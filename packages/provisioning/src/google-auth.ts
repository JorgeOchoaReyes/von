import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { GoogleAuth } from "./drivers/google.ts";

/**
 * Getting a Google access token, and keeping one.
 *
 * The version this replaces read `GOOGLE_ACCESS_TOKEN` from the environment on
 * every call. That works for about an hour. Google access tokens expire, and a
 * control plane is a long-running process, so provisioning worked immediately
 * after deploy and then began failing with 401s from a background task — the
 * worst shape of failure, because nothing about the configuration changed
 * between working and not.
 *
 * Three sources, in the order they are tried:
 *
 *   1. a service account key — inline JSON in `GOOGLE_SERVICE_ACCOUNT_KEY`, or
 *      a path in `GOOGLE_APPLICATION_CREDENTIALS`. Signs its own JWT and
 *      exchanges it. This is the one to use in production.
 *   2. the metadata server, when running on Cloud Run or GCE. No key material
 *      to store or rotate, so it is preferred *over* a key when both would
 *      work — but a key is checked first because setting one is an explicit
 *      instruction to use that identity.
 *   3. `GOOGLE_ACCESS_TOKEN`, static. Kept because `gcloud auth
 *      print-access-token` is the fastest way to try something locally. It
 *      still expires in an hour, and this says so out loud rather than letting
 *      it be discovered.
 *
 * Everything is cached and refreshed ahead of expiry, and concurrent callers
 * share one refresh: genesis runs several Google steps at once, and without
 * single-flighting a cold start would fire a token request per step.
 */

/** Everything Google's APIs are called with here fits under one scope. */
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const METADATA_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/**
 * Refreshed this long before it actually expires.
 *
 * A token that is valid when the request is made can still be rejected by the
 * time it arrives. Sixty seconds is comfortably longer than any call here
 * takes and short enough not to waste most of a token's life.
 */
const EXPIRY_MARGIN_MS = 60_000;

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface GoogleAuthOptions {
  /** Overridable so tests do not reach the network. */
  fetchImpl?: typeof fetch;
  /** Overridable so tests are not at the mercy of the wall clock. */
  now?: () => number;
}

/**
 * A source of tokens, whatever the credential behind it is.
 *
 * `describe()` exists so readiness and startup logs can say *which* identity is
 * in use. "Provisioning failed with 401" is a much shorter conversation when
 * the logs already said `service account
 * von-provisioner@example.iam.gserviceaccount.com`.
 */
export interface TokenSource {
  describe(): string;
  fetchToken(): Promise<CachedToken>;
}

export class NoGoogleCredentials extends Error {
  constructor() {
    super(
      "no Google credentials: set GOOGLE_SERVICE_ACCOUNT_KEY (inline JSON) or " +
        "GOOGLE_APPLICATION_CREDENTIALS (path), run on Cloud Run/GCE, or set " +
        "GOOGLE_ACCESS_TOKEN for a short local session",
    );
  }
}

/**
 * A self-signed JWT exchanged for an access token.
 *
 * This is the whole of the service-account flow: sign a short assertion with
 * the key's private half, hand it to Google, get a token back. No dependency
 * needed for it, and one fewer package that gets to see the key.
 */
export function serviceAccountSource(
  key: ServiceAccountKey,
  opts: GoogleAuthOptions = {},
): TokenSource {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  if (!key.client_email || !key.private_key) {
    throw new Error("service account key is missing client_email or private_key");
  }

  return {
    describe: () => `service account ${key.client_email}`,

    async fetchToken() {
      const issuedAt = Math.floor(now() / 1000);
      const tokenUri = key.token_uri ?? TOKEN_URL;

      const claims = {
        iss: key.client_email,
        scope: SCOPE,
        aud: tokenUri,
        iat: issuedAt,
        exp: issuedAt + 3600,
      };

      const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
        JSON.stringify(claims),
      )}`;

      const signer = createSign("RSA-SHA256");
      signer.update(signingInput);
      // The key arrives from JSON, where the PEM's newlines are escaped. A key
      // pasted into an environment variable often keeps them escaped, and
      // crypto rejects it with a message about the format that says nothing
      // about why.
      const pem = key.private_key.includes("\\n")
        ? key.private_key.replace(/\\n/g, "\n")
        : key.private_key;
      const assertion = `${signingInput}.${signer.sign(pem, "base64url")}`;

      const res = await doFetch(tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      });

      if (!res.ok) {
        throw new Error(
          `google token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
        );
      }

      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token) throw new Error("google token exchange returned no access_token");

      return {
        token: body.access_token,
        expiresAt: now() + (body.expires_in ?? 3600) * 1000,
      };
    },
  };
}

/** The instance's own identity, on Cloud Run or GCE. No key to store. */
export function metadataSource(opts: GoogleAuthOptions = {}): TokenSource {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  return {
    describe: () => "the instance metadata server",

    async fetchToken() {
      const res = await doFetch(METADATA_URL, {
        headers: { "metadata-flavor": "Google" },
      });
      if (!res.ok) {
        throw new Error(`metadata server returned ${res.status}`);
      }

      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token) throw new Error("metadata server returned no access_token");

      return {
        token: body.access_token,
        expiresAt: now() + (body.expires_in ?? 3600) * 1000,
      };
    },
  };
}

/**
 * A token someone pasted in.
 *
 * Its expiry is unknown — it is an opaque string, not a response — so it is
 * treated as valid for an hour from first use and then refetched from the
 * environment, which is the only way it can ever change without a restart.
 */
export function staticTokenSource(
  read: () => string | undefined,
  opts: GoogleAuthOptions = {},
): TokenSource {
  const now = opts.now ?? Date.now;

  return {
    describe: () => "GOOGLE_ACCESS_TOKEN (static; expires about an hour after it was minted)",

    async fetchToken() {
      const token = read()?.trim();
      if (!token) throw new NoGoogleCredentials();
      return { token, expiresAt: now() + 3600_000 };
    },
  };
}

/**
 * Whichever credential this environment actually has.
 *
 * Returns null rather than throwing so a control plane with no Google
 * credentials still starts — provisioning is one capability among several, and
 * refusing to boot without it would make the readiness endpoint unreachable
 * precisely when it is most useful.
 */
export async function detectTokenSource(
  env: NodeJS.ProcessEnv = process.env,
  opts: GoogleAuthOptions = {},
): Promise<TokenSource | null> {
  const inline = env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim();
  if (inline) {
    return serviceAccountSource(parseKey(inline, "GOOGLE_SERVICE_ACCOUNT_KEY"), opts);
  }

  const path = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (path) {
    const raw = await readFile(path, "utf8");
    return serviceAccountSource(parseKey(raw, path), opts);
  }

  if (await onMetadataServer(opts)) return metadataSource(opts);

  if (env.GOOGLE_ACCESS_TOKEN?.trim()) {
    return staticTokenSource(() => env.GOOGLE_ACCESS_TOKEN, opts);
  }

  return null;
}

function parseKey(raw: string, origin: string): ServiceAccountKey {
  try {
    return JSON.parse(raw) as ServiceAccountKey;
  } catch {
    throw new Error(`${origin} is not valid JSON — expected a service account key file`);
  }
}

/**
 * Is there a metadata server?
 *
 * Probed with a short timeout because off a Google host the name does not
 * resolve, and on some networks a wildcard DNS answer means it resolves to
 * something that will never reply. Either way this must not hold up a boot.
 */
async function onMetadataServer(opts: GoogleAuthOptions = {}): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(METADATA_URL, {
      headers: { "metadata-flavor": "Google" },
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * A `GoogleAuth` that caches, refreshes ahead of expiry, and single-flights.
 */
export function cachingAuth(source: TokenSource, opts: GoogleAuthOptions = {}): GoogleAuth {
  const now = opts.now ?? Date.now;

  let cached: CachedToken | null = null;
  let inFlight: Promise<CachedToken> | null = null;

  return {
    async accessToken() {
      if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.token;

      // One refresh, however many callers arrive during it. Cleared in a
      // `finally` so a failed refresh does not wedge every later call on a
      // rejected promise.
      inFlight ??= source
        .fetchToken()
        .then((fresh) => {
          cached = fresh;
          return fresh;
        })
        .finally(() => {
          inFlight = null;
        });

      return (await inFlight).token;
    },
  };
}

const b64url = (value: string): string => Buffer.from(value).toString("base64url");
