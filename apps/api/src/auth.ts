import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Who may call the control plane.
 *
 * Every endpoint here spends real money — it creates GCP projects, GitHub
 * repositories and EAS projects, and it runs an agent against an API key we
 * pay for. Deployed without a gate, the first thing that finds it turns the
 * platform into someone else's free build farm.
 *
 * This is a shared-secret gate, not a user identity system. It is the right
 * size for what exists today (the admin console and the chat client are both
 * ours) and it is deliberately explicit about that: `tenantId` still comes from
 * the request, so this authorises *callers*, not *tenants*. A real multi-tenant
 * boundary needs signed user tokens, and that is a larger change than this
 * file should pretend to make.
 *
 * Two exceptions are unauthenticated on purpose:
 *
 *   - `/healthz`, because a load balancer cannot hold a secret.
 *   - `/v1/apps/:id/runtime-config`, which is documented as public: it returns a
 *     Firebase *web* config, the same values that ship inside every client
 *     binary. Access control for that data lives in Firestore rules and the
 *     GCIP tenant, not in the secrecy of these strings.
 */

const PUBLIC_PATHS = [/^\/healthz$/, /^\/v1\/apps\/[^/]+\/runtime-config$/];

/** Constant-time compare, so a wrong key cannot be found byte by byte. */
function matches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Length alone leaks nothing useful, and timingSafeEqual demands equal sizes.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AuthOptions {
  /** Accepted keys. Several, so a key can be rotated without downtime. */
  keys: string[];
  /**
   * Allow unauthenticated access when no key is configured. True for local
   * development; in a deployment this is what turns a missing secret into a
   * refusal to start rather than an open door.
   */
  allowAnonymous: boolean;
}

export function authOptionsFromEnv(): AuthOptions {
  const keys = (process.env.VON_API_KEYS ?? process.env.VON_API_KEY ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  // Local development runs open; anything with a preview host or a Firestore
  // project is a deployment and must not.
  const deployed = Boolean(process.env.VON_FIRESTORE_PROJECT || process.env.VON_PREVIEW_HOST);

  if (keys.length === 0 && deployed) {
    throw new Error(
      "VON_API_KEYS is required when the control plane is deployed: it creates " +
        "billable cloud resources on every request and must not be open.",
    );
  }

  return { keys, allowAnonymous: keys.length === 0 };
}

/** Extract a key from `Authorization: Bearer …` or `x-von-key`. */
function presentedKey(header: (name: string) => string | undefined): string | null {
  const auth = header("authorization");
  if (auth) {
    const [scheme, ...rest] = auth.split(" ");
    if (scheme?.toLowerCase() === "bearer" && rest.length) return rest.join(" ").trim();
  }
  return header("x-von-key")?.trim() || null;
}

export function requireApiKey(opts: AuthOptions): MiddlewareHandler {
  return async (c, next) => {
    if (opts.allowAnonymous) return next();
    if (PUBLIC_PATHS.some((p) => p.test(c.req.path))) return next();

    // CORS preflight never carries the header; rejecting it would break the
    // browser clients before the real request is ever sent.
    if (c.req.method === "OPTIONS") return next();

    const given = presentedKey((n) => c.req.header(n));
    if (!given || !opts.keys.some((k) => matches(given, k))) {
      return c.json({ error: "unauthorized" }, 401, {
        "www-authenticate": 'Bearer realm="von"',
      });
    }

    return next();
  };
}
