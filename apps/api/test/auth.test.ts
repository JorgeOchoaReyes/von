import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { authOptionsFromEnv, requireApiKey } from "../src/auth.ts";

const KEY = "k".repeat(40);

function server(keys: string[]) {
  const app = new Hono();
  app.use("*", requireApiKey({ keys, allowAnonymous: keys.length === 0 }));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/v1/apps/:id/runtime-config", (c) => c.json({ appId: c.req.param("id") }));
  app.post("/v1/apps", (c) => c.json({ created: true }, 201));
  return app;
}

const call = (app: Hono, path: string, init: RequestInit = {}) =>
  app.request(`http://von.test${path}`, init);

/** Restore env after a test that changes it. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a request with no key is refused", async () => {
  const res = await call(server([KEY]), "/v1/apps", { method: "POST" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /Bearer/);
});

test("a wrong key is refused", async () => {
  const res = await call(server([KEY]), "/v1/apps", {
    method: "POST",
    headers: { authorization: `Bearer ${"x".repeat(40)}` },
  });
  assert.equal(res.status, 401);
});

test("a correct key is accepted, via either header", async () => {
  const app = server([KEY]);

  assert.equal(
    (await call(app, "/v1/apps", { method: "POST", headers: { authorization: `Bearer ${KEY}` } }))
      .status,
    201,
  );
  assert.equal(
    (await call(app, "/v1/apps", { method: "POST", headers: { "x-von-key": KEY } })).status,
    201,
  );
});

test("several keys are accepted, so one can be rotated without downtime", async () => {
  const app = server(["old-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaa", KEY]);
  for (const key of ["old-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaa", KEY]) {
    const res = await call(app, "/v1/apps", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(res.status, 201, `expected ${key} to be accepted`);
  }
});

test("healthz is open — a load balancer cannot hold a secret", async () => {
  assert.equal((await call(server([KEY]), "/healthz")).status, 200);
});

test("runtime-config is open, as documented", async () => {
  // It returns a Firebase *web* config: the same values baked into every client
  // binary. Access control lives in Firestore rules and the GCIP tenant.
  const res = await call(server([KEY]), "/v1/apps/app_1/runtime-config");
  assert.equal(res.status, 200);
});

test("a path that merely looks like runtime-config is still protected", async () => {
  const app = new Hono();
  app.use("*", requireApiKey({ keys: [KEY], allowAnonymous: false }));
  app.all("*", (c) => c.json({ reached: true }));

  for (const path of [
    "/v1/apps/app_1/runtime-config/../../../v1/apps",
    "/v1/apps/app_1/runtime-configs",
    "/prefix/v1/apps/app_1/runtime-config",
  ]) {
    assert.equal((await call(app, path)).status, 401, `${path} should not be public`);
  }
});

test("CORS preflight is not rejected before the real request", async () => {
  // Preflight never carries the header; a 401 here would break every browser
  // client before the authenticated request is ever sent.
  const res = await call(server([KEY]), "/v1/apps", { method: "OPTIONS" });
  assert.notEqual(res.status, 401);
});

test("with no keys configured everything is open — local development", async () => {
  assert.equal((await call(server([]), "/v1/apps", { method: "POST" })).status, 201);
});

test("a deployment without keys refuses to start", () => {
  // The failure mode this prevents: a public control plane that creates
  // billable GCP projects for anyone who finds it.
  withEnv({ VON_API_KEYS: undefined, VON_API_KEY: undefined, VON_FIRESTORE_PROJECT: "von-prod" }, () => {
    assert.throws(authOptionsFromEnv, /VON_API_KEYS is required/);
  });

  withEnv({ VON_API_KEYS: undefined, VON_API_KEY: undefined, VON_PREVIEW_HOST: "preview.von.app" }, () => {
    assert.throws(authOptionsFromEnv, /VON_API_KEYS is required/);
  });
});

test("local development without keys is allowed to run open", () => {
  withEnv(
    {
      VON_API_KEYS: undefined,
      VON_API_KEY: undefined,
      VON_FIRESTORE_PROJECT: undefined,
      VON_PREVIEW_HOST: undefined,
    },
    () => {
      assert.deepEqual(authOptionsFromEnv(), { keys: [], allowAnonymous: true });
    },
  );
});

test("keys are read as a comma-separated list, trimmed", () => {
  withEnv({ VON_API_KEYS: ` ${KEY} , second-key ` }, () => {
    assert.deepEqual(authOptionsFromEnv().keys, [KEY, "second-key"]);
  });
});
