import { assertOk, RetryableError, TerminalError, type Driver } from "../driver.ts";

/**
 * Google drivers. These automate DEPLOY.md §1 (Firebase project, Anonymous
 * auth, Firestore, Blaze billing) and §3.1 (service account key).
 *
 * Auth: every call takes a short-lived OAuth2 access token for the platform's
 * *provisioner* service account, which must hold `roles/resourcemanager.projectCreator`
 * on the parent folder and `roles/billing.user` on the billing account.
 */
export interface GoogleAuth {
  /** Returns a bearer token with the cloud-platform scope. */
  accessToken(): Promise<string>;
}

interface GoogleCtx {
  auth: GoogleAuth;
  /** GCP folder or org to create projects under, e.g. `folders/123456`. */
  parent: string;
  /** Billing account to attach, e.g. `billingAccounts/00X-XXX-XXX`. */
  billingAccount: string;
}

async function gapi(
  ctx: GoogleCtx,
  url: string,
  init: RequestInit & { context: string },
): Promise<any> {
  const token = await ctx.auth.accessToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  await assertOk(res, init.context);
  return res.status === 204 ? null : res.json();
}

/**
 * Poll a Google long-running operation to completion.
 *
 * Project creation and `addFirebase` are both LROs that take 20-90s. The
 * orchestrator's retry loop is *not* the right tool here (it would re-issue the
 * create), so drivers block on the operation instead.
 */
async function awaitOperation(
  ctx: GoogleCtx,
  opName: string,
  api: "cloudresourcemanager" | "firebase",
  timeoutMs = 180_000,
): Promise<any> {
  const base =
    api === "cloudresourcemanager"
      ? "https://cloudresourcemanager.googleapis.com/v1"
      : "https://firebase.googleapis.com/v1beta1";

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const op = await gapi(ctx, `${base}/${opName}`, {
      method: "GET",
      context: `poll ${opName}`,
    });
    if (op.done) {
      if (op.error) throw new TerminalError(`operation failed: ${JSON.stringify(op.error)}`);
      return op.response;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new RetryableError(`operation ${opName} did not complete within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Dedicated Firebase project
// ---------------------------------------------------------------------------

export interface FirebaseProjectSpec {
  appId: string;
  /** Must be globally unique, 6-30 chars. Derived from the app slug + suffix. */
  projectId: string;
  displayName: string;
}

export interface FirebaseProjectOutputs extends Record<string, unknown> {
  externalId: string;
  projectId: string;
  projectNumber: string;
}

export function firebaseProjectDriver(
  ctx: GoogleCtx,
): Driver<FirebaseProjectSpec, FirebaseProjectOutputs> {
  return {
    kind: "firebase.project",
    key: (s) => `firebase.project:${s.appId}`,

    async read(spec) {
      const token = await ctx.auth.accessToken();
      const res = await fetch(
        `https://firebase.googleapis.com/v1beta1/projects/${spec.projectId}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (res.status === 404 || res.status === 403) return null;
      await assertOk(res, "read firebase project");
      const body = await res.json();
      return {
        externalId: spec.projectId,
        projectId: spec.projectId,
        projectNumber: String(body.projectNumber ?? ""),
      };
    },

    async create(spec) {
      // 1. Create the underlying GCP project.
      const createOp = await gapi(ctx, "https://cloudresourcemanager.googleapis.com/v1/projects", {
        method: "POST",
        context: "create gcp project",
        body: JSON.stringify({
          projectId: spec.projectId,
          name: spec.displayName,
          parent: parseParent(ctx.parent),
        }),
      });
      await awaitOperation(ctx, createOp.name, "cloudresourcemanager");

      // 2. Attach billing. Cloud Functions v2 requires the Blaze plan, which is
      //    just "this project has an open billing account" (DEPLOY.md §1.4).
      await gapi(
        ctx,
        `https://cloudbilling.googleapis.com/v1/projects/${spec.projectId}/billingInfo`,
        {
          method: "PUT",
          context: "attach billing",
          body: JSON.stringify({ billingAccountName: ctx.billingAccount }),
        },
      );

      // 3. Enable the APIs the generated app needs.
      for (const api of [
        "firebase.googleapis.com",
        "firestore.googleapis.com",
        "cloudfunctions.googleapis.com",
        "cloudbuild.googleapis.com",
        "run.googleapis.com",
        "identitytoolkit.googleapis.com",
      ]) {
        await gapi(
          ctx,
          `https://serviceusage.googleapis.com/v1/projects/${spec.projectId}/services/${api}:enable`,
          { method: "POST", context: `enable ${api}`, body: "{}" },
        );
      }

      // 4. Turn it into a Firebase project.
      const fbOp = await gapi(
        ctx,
        `https://firebase.googleapis.com/v1beta1/projects/${spec.projectId}:addFirebase`,
        { method: "POST", context: "addFirebase", body: "{}" },
      );
      const project = await awaitOperation(ctx, fbOp.name, "firebase");

      return {
        externalId: spec.projectId,
        projectId: spec.projectId,
        projectNumber: String(project?.projectNumber ?? ""),
      };
    },
  };
}

function parseParent(parent: string): { type: string; id: string } {
  const [type, id] = parent.split("/");
  if (!type || !id) throw new TerminalError(`invalid parent "${parent}"`);
  return { type: type.replace(/s$/, ""), id };
}

// ---------------------------------------------------------------------------
// Web app + config (what the client SDK needs)
// ---------------------------------------------------------------------------

export interface WebAppSpec {
  appId: string;
  projectId: string;
  displayName: string;
}

export interface WebAppOutputs extends Record<string, unknown> {
  externalId: string;
  config: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    storageBucket: string;
    messagingSenderId: string;
    appId: string;
  };
}

export function firebaseWebAppDriver(ctx: GoogleCtx): Driver<WebAppSpec, WebAppOutputs> {
  const fetchConfig = async (appName: string) =>
    gapi(ctx, `https://firebase.googleapis.com/v1beta1/${appName}/config`, {
      method: "GET",
      context: "read webapp config",
    });

  return {
    kind: "firebase.webapp",
    key: (s) => `firebase.webapp:${s.appId}`,

    async read(spec) {
      const list = await gapi(
        ctx,
        `https://firebase.googleapis.com/v1beta1/projects/${spec.projectId}/webApps`,
        { method: "GET", context: "list webapps" },
      ).catch(() => null);

      const existing = list?.apps?.find((a: any) => a.displayName === spec.displayName);
      if (!existing) return null;

      const config = await fetchConfig(existing.name);
      return { externalId: existing.appId, config: normalizeConfig(config) };
    },

    async create(spec) {
      const op = await gapi(
        ctx,
        `https://firebase.googleapis.com/v1beta1/projects/${spec.projectId}/webApps`,
        {
          method: "POST",
          context: "create webapp",
          body: JSON.stringify({ displayName: spec.displayName }),
        },
      );
      const app = await awaitOperation(ctx, op.name, "firebase");
      const config = await fetchConfig(app.name);
      return { externalId: app.appId, config: normalizeConfig(config) };
    },
  };
}

function normalizeConfig(raw: any): WebAppOutputs["config"] {
  return {
    apiKey: raw.apiKey,
    authDomain: raw.authDomain,
    projectId: raw.projectId,
    storageBucket: raw.storageBucket,
    messagingSenderId: raw.messagingSenderId,
    appId: raw.appId,
  };
}

// ---------------------------------------------------------------------------
// Firestore database + Anonymous auth (DEPLOY.md §1.2 and §1.3)
// ---------------------------------------------------------------------------

export interface FirestoreSpec {
  appId: string;
  projectId: string;
  locationId: string;
}

export function firestoreDriver(
  ctx: GoogleCtx,
): Driver<FirestoreSpec, Record<string, unknown>> {
  return {
    kind: "firebase.firestore",
    key: (s) => `firebase.firestore:${s.appId}`,

    async read(spec) {
      const db = await gapi(
        ctx,
        `https://firestore.googleapis.com/v1/projects/${spec.projectId}/databases/(default)`,
        { method: "GET", context: "read firestore" },
      ).catch(() => null);
      return db ? { externalId: db.name, name: db.name } : null;
    },

    async create(spec) {
      const op = await gapi(
        ctx,
        `https://firestore.googleapis.com/v1/projects/${spec.projectId}/databases?databaseId=(default)`,
        {
          method: "POST",
          context: "create firestore",
          body: JSON.stringify({
            locationId: spec.locationId,
            type: "FIRESTORE_NATIVE",
            // Rules are deployed from the generated repo, so the database
            // itself starts locked and the repo's firestore.rules is the
            // source of truth from the first deploy onward.
            concurrencyMode: "OPTIMISTIC",
          }),
        },
      );
      return { externalId: op.name ?? `projects/${spec.projectId}/databases/(default)` };
    },
  };
}

export interface AnonAuthSpec {
  appId: string;
  projectId: string;
}

export function anonymousAuthDriver(
  ctx: GoogleCtx,
): Driver<AnonAuthSpec, Record<string, unknown>> {
  return {
    kind: "firebase.auth",
    key: (s) => `firebase.auth:${s.appId}`,

    async read(spec) {
      const cfg = await gapi(
        ctx,
        `https://identitytoolkit.googleapis.com/v2/projects/${spec.projectId}/config`,
        { method: "GET", context: "read auth config" },
      ).catch(() => null);
      return cfg?.signIn?.anonymous?.enabled ? { externalId: spec.projectId } : null;
    },

    async create(spec) {
      await gapi(
        ctx,
        `https://identitytoolkit.googleapis.com/v2/projects/${spec.projectId}/config?updateMask=signIn.anonymous.enabled`,
        {
          method: "PATCH",
          context: "enable anonymous auth",
          body: JSON.stringify({ signIn: { anonymous: { enabled: true } } }),
        },
      );
      return { externalId: spec.projectId };
    },
  };
}

// ---------------------------------------------------------------------------
// Pooled tenancy: a GCIP tenant inside the shared project
// ---------------------------------------------------------------------------

export interface GcipTenantSpec {
  appId: string;
  /** The *shared* pool project, not a per-app project. */
  poolProjectId: string;
  displayName: string;
}

export interface GcipTenantOutputs extends Record<string, unknown> {
  externalId: string;
  tenantId: string;
}

/**
 * Allocates an isolated user pool for a pooled-tier app in ~1 second.
 *
 * This is what makes "type a prompt, use your app immediately" possible: the
 * app gets real auth isolation (its own users, its own sign-in settings) with
 * no project creation, no billing linkage, and no GCP project quota consumed.
 * Data isolation is handled separately by the `/t/{tenantId}` path prefix and
 * the pooled Firestore rules.
 */
export function gcipTenantDriver(ctx: GoogleCtx): Driver<GcipTenantSpec, GcipTenantOutputs> {
  return {
    kind: "gcip.tenant",
    key: (s) => `gcip.tenant:${s.appId}`,

    async read(spec) {
      const list = await gapi(
        ctx,
        `https://identitytoolkit.googleapis.com/v2/projects/${spec.poolProjectId}/tenants?pageSize=200`,
        { method: "GET", context: "list gcip tenants" },
      ).catch(() => null);

      const found = list?.tenants?.find((t: any) => t.displayName === spec.displayName);
      if (!found) return null;
      const tenantId = String(found.name).split("/").pop()!;
      return { externalId: tenantId, tenantId };
    },

    async create(spec) {
      const tenant = await gapi(
        ctx,
        `https://identitytoolkit.googleapis.com/v2/projects/${spec.poolProjectId}/tenants`,
        {
          method: "POST",
          context: "create gcip tenant",
          body: JSON.stringify({
            displayName: spec.displayName,
            allowPasswordSignup: true,
            enableAnonymousUser: true,
          }),
        },
      );
      const tenantId = String(tenant.name).split("/").pop()!;
      return { externalId: tenantId, tenantId };
    },

    async destroy(spec, outputs) {
      await gapi(
        ctx,
        `https://identitytoolkit.googleapis.com/v2/projects/${spec.poolProjectId}/tenants/${outputs.tenantId}`,
        { method: "DELETE", context: "delete gcip tenant" },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Deploy service account (DEPLOY.md §3.1-3.2, fully automated)
// ---------------------------------------------------------------------------

export interface ServiceAccountSpec {
  appId: string;
  projectId: string;
  accountId: string;
}

export interface ServiceAccountOutputs extends Record<string, unknown> {
  externalId: string;
  email: string;
  /** Base64 JSON key — goes straight into the repo's FIREBASE_SERVICE_ACCOUNT. */
  privateKeyJson: string;
}

export function deployServiceAccountDriver(
  ctx: GoogleCtx,
): Driver<ServiceAccountSpec, ServiceAccountOutputs> {
  const email = (s: ServiceAccountSpec) =>
    `${s.accountId}@${s.projectId}.iam.gserviceaccount.com`;

  return {
    kind: "firebase.serviceaccount",
    key: (s) => `firebase.serviceaccount:${s.appId}`,

    // A key is only returned at creation time, so a partially-created service
    // account is not recoverable via read(); the orchestrator will create a new
    // key against the existing account, which is the correct behaviour.
    async read() {
      return null;
    },

    async create(spec) {
      const sa = await gapi(
        ctx,
        `https://iam.googleapis.com/v1/projects/${spec.projectId}/serviceAccounts`,
        {
          method: "POST",
          context: "create service account",
          body: JSON.stringify({
            accountId: spec.accountId,
            serviceAccount: { displayName: "Von deploy" },
          }),
        },
      ).catch((err) => {
        // 409 = already exists, which is fine; we only need a fresh key.
        if (err instanceof TerminalError && /409/.test(err.message)) {
          return { email: email(spec) };
        }
        throw err;
      });

      // Grant deploy rights. `roles/editor` matches the manual runbook; tighten
      // to firebase.admin + cloudfunctions.developer + iam.serviceAccountUser
      // once the generated app's deploy surface is fixed.
      await gapi(
        ctx,
        `https://cloudresourcemanager.googleapis.com/v1/projects/${spec.projectId}:getIamPolicy`,
        { method: "POST", context: "get iam policy", body: "{}" },
      ).then((policy: any) =>
        gapi(
          ctx,
          `https://cloudresourcemanager.googleapis.com/v1/projects/${spec.projectId}:setIamPolicy`,
          {
            method: "POST",
            context: "set iam policy",
            body: JSON.stringify({
              policy: {
                ...policy,
                bindings: [
                  ...(policy.bindings ?? []),
                  { role: "roles/editor", members: [`serviceAccount:${sa.email}`] },
                ],
              },
            }),
          },
        ),
      );

      const key = await gapi(
        ctx,
        `https://iam.googleapis.com/v1/projects/${spec.projectId}/serviceAccounts/${sa.email}/keys`,
        {
          method: "POST",
          context: "create sa key",
          body: JSON.stringify({ privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE" }),
        },
      );

      return {
        externalId: sa.email,
        email: sa.email,
        privateKeyJson: Buffer.from(key.privateKeyData, "base64").toString("utf8"),
      };
    },
  };
}
