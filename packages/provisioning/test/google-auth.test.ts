import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  cachingAuth,
  detectTokenSource,
  metadataSource,
  serviceAccountSource,
  staticTokenSource,
  type ServiceAccountKey,
} from "../src/google-auth.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const KEY: ServiceAccountKey = {
  client_email: "von-provisioner@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
};

/** A fetch that records what it was asked and answers with what it is told. */
function stub(...responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("a service account key is exchanged for a token", async () => {
  const { impl, calls } = stub({ body: { access_token: "ya29.abc", expires_in: 3599 } });

  const source = serviceAccountSource(KEY, { fetchImpl: impl });
  const { token } = await source.fetchToken();

  assert.equal(token, "ya29.abc");

  const body = calls[0]!.init!.body as URLSearchParams;
  assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");

  // The assertion is a real JWT signed with the key, and its claims name the
  // identity and the scope. A malformed one is rejected by Google with a
  // message that says nothing useful, so it is checked here instead.
  const [header, claims] = body.get("assertion")!.split(".");
  assert.equal(JSON.parse(Buffer.from(header!, "base64url").toString()).alg, "RS256");
  const parsed = JSON.parse(Buffer.from(claims!, "base64url").toString());
  assert.equal(parsed.iss, KEY.client_email);
  assert.match(parsed.scope, /cloud-platform/);
});

test("a key pasted into an env var with escaped newlines still signs", async () => {
  // A PEM copied out of the JSON file keeps its \n escapes. crypto rejects it
  // with a message about key format that points nowhere near the cause.
  const escaped = { ...KEY, private_key: KEY.private_key.replace(/\n/g, "\\n") };
  const { impl } = stub({ body: { access_token: "ya29.ok", expires_in: 3599 } });

  await assert.doesNotReject(serviceAccountSource(escaped, { fetchImpl: impl }).fetchToken());
});

test("a rejected exchange says what Google said", async () => {
  const { impl } = stub({ status: 400, body: { error: "invalid_grant" } });

  await assert.rejects(
    serviceAccountSource(KEY, { fetchImpl: impl }).fetchToken(),
    /400.*invalid_grant/s,
  );
});

test("a token is reused until it is nearly expired", async () => {
  let clock = 1_000_000;
  const { impl, calls } = stub({ body: { access_token: "first", expires_in: 3600 } });

  const auth = cachingAuth(serviceAccountSource(KEY, { fetchImpl: impl, now: () => clock }), {
    now: () => clock,
  });

  assert.equal(await auth.accessToken(), "first");
  clock += 3_000_000; // still well inside the hour
  assert.equal(await auth.accessToken(), "first");
  assert.equal(calls.length, 1);
});

test("a token is refreshed before it expires, not after", async () => {
  let clock = 1_000_000;
  const { impl, calls } = stub(
    { body: { access_token: "first", expires_in: 3600 } },
    { body: { access_token: "second", expires_in: 3600 } },
  );

  const auth = cachingAuth(serviceAccountSource(KEY, { fetchImpl: impl, now: () => clock }), {
    now: () => clock,
  });

  await auth.accessToken();
  // 30s before expiry: still valid, but a call made now could arrive after it
  // is not. That is the window the margin exists to avoid.
  clock += 3_570_000;
  assert.equal(await auth.accessToken(), "second");
  assert.equal(calls.length, 2);
});

test("concurrent callers share one refresh", async () => {
  const { impl, calls } = stub({ body: { access_token: "one", expires_in: 3600 } });
  const auth = cachingAuth(serviceAccountSource(KEY, { fetchImpl: impl }));

  // Genesis runs several Google steps at once. Without single-flighting, a cold
  // start fires a token exchange per step.
  const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);

  assert.deepEqual(tokens, ["one", "one", "one"]);
  assert.equal(calls.length, 1);
});

test("a failed refresh does not wedge every later call", async () => {
  let fail = true;
  const impl = (async () =>
    fail
      ? new Response("nope", { status: 500 })
      : new Response(JSON.stringify({ access_token: "recovered", expires_in: 3600 }))) as unknown as typeof fetch;

  const auth = cachingAuth(serviceAccountSource(KEY, { fetchImpl: impl }));

  await assert.rejects(auth.accessToken());
  fail = false;
  assert.equal(await auth.accessToken(), "recovered");
});

test("the metadata server is used when there is one", async () => {
  const { impl, calls } = stub({ body: { access_token: "metadata-token", expires_in: 3599 } });

  const { token } = await metadataSource({ fetchImpl: impl }).fetchToken();

  assert.equal(token, "metadata-token");
  assert.match(calls[0]!.url, /metadata\.google\.internal/);
  assert.equal(
    (calls[0]!.init!.headers as Record<string, string>)["metadata-flavor"],
    "Google",
  );
});

test("a static token is treated as expiring, because it does", async () => {
  let clock = 0;
  const source = staticTokenSource(() => "ya29.pasted", { now: () => clock });

  const { expiresAt } = await source.fetchToken();

  assert.equal(expiresAt, 3600_000);
  assert.match(source.describe(), /expires/);
});

test("an inline key beats a static token", async () => {
  const { impl } = stub({ body: {} });
  const source = await detectTokenSource(
    {
      GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(KEY),
      GOOGLE_ACCESS_TOKEN: "ya29.stale",
    } as NodeJS.ProcessEnv,
    { fetchImpl: impl },
  );

  assert.match(source!.describe(), /von-provisioner@/);
});

test("a key that is not JSON says so, naming where it came from", async () => {
  await assert.rejects(
    detectTokenSource({ GOOGLE_SERVICE_ACCOUNT_KEY: "ya29.oops" } as NodeJS.ProcessEnv),
    /GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON/,
  );
});

test("no credentials at all is null, not a crash", async () => {
  // The control plane has to boot without Google configured: provisioning is
  // one capability among several, and /v1/readiness is most useful precisely
  // when something is missing.
  const impl = (async () => {
    throw new Error("no metadata server here");
  }) as unknown as typeof fetch;

  assert.equal(await detectTokenSource({} as NodeJS.ProcessEnv, { fetchImpl: impl }), null);
});
