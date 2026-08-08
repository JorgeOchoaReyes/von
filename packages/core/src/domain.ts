import { z } from "zod";

/**
 * Backend isolation tier. This is the single most important scaling knob in the
 * platform — see docs/ARCHITECTURE.md §3.
 *
 * - `pooled`   — the app lives in a shared Firebase project but owns two things
 *                outright: a Google Cloud Identity Platform *tenant* (its own
 *                user pool, so its users cannot sign into any other app) and
 *                its own named Firestore *database* (its own indexes, rules,
 *                backups and throughput). Provisioning takes seconds, so a
 *                brand-new app is usable immediately. This is the default.
 * - `dedicated`— the app owns a real Firebase project, created via the Firebase
 *                Management API. Takes 1-3 minutes and consumes GCP project
 *                quota, so it is only provisioned on publish/upgrade.
 */
export const BackendTier = z.enum(["pooled", "dedicated"]);
export type BackendTier = z.infer<typeof BackendTier>;

/**
 * How the user's app reaches a real device.
 *
 * - `shell`  — the app runs inside Von's shared host binary via an EAS Update
 *              channel. No native build, arrives in ~1 min. Covers every
 *              JS/asset-only app.
 * - `standalone` — the app has its own EAS project, bundle id and binaries.
 *              Required for custom native modules, custom icon/splash on the
 *              home screen, and store submission.
 */
export const DeliveryMode = z.enum(["shell", "standalone"]);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

export const Plan = z.enum(["free", "pro", "team"]);
export type Plan = z.infer<typeof Plan>;

export const Tenant = z.object({
  id: z.string(),
  name: z.string(),
  ownerEmail: z.string().email(),
  plan: Plan.default("free"),
  createdAt: z.number(),
});
export type Tenant = z.infer<typeof Tenant>;

/**
 * An app under construction. `slug` is the derived name that every external
 * resource is keyed on (Firebase project id, GitHub repo, Expo slug), so it is
 * immutable once provisioning has started.
 */
export const App = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().default(""),
  backendTier: BackendTier.default("pooled"),
  deliveryMode: DeliveryMode.default("shell"),
  /** Set once a dedicated Firebase project exists. */
  firebaseProjectId: z.string().nullable().default(null),
  /** Pooled apps get a GCIP tenant id inside the shared project. */
  gcipTenantId: z.string().nullable().default(null),
  /** `owner/repo` once exported/created on GitHub. */
  repoFullName: z.string().nullable().default(null),
  easProjectId: z.string().nullable().default(null),
  /** EAS Update channel this app's installed build listens on. */
  channel: z.string().default("preview"),
  /** Bumped whenever a native-affecting change ships; gates OTA delivery. */
  runtimeVersion: z.string().default("1.0.0"),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type App = z.infer<typeof App>;

/**
 * The config an installed app fetches at boot. Because this is resolved at
 * runtime rather than baked into the bundle (as it is in the ByteLearning
 * reference), an app can be promoted from a pooled backend to a dedicated
 * Firebase project without rebuilding or even re-publishing the bundle.
 */
export const RuntimeConfig = z.object({
  appId: z.string(),
  backendTier: BackendTier,
  firebase: z.object({
    apiKey: z.string(),
    authDomain: z.string(),
    projectId: z.string(),
    storageBucket: z.string(),
    messagingSenderId: z.string(),
    appId: z.string(),
  }),
  /** Present only for pooled apps; passed to `auth.tenantId` on the client. */
  gcipTenantId: z.string().nullable(),
  /**
   * Firestore database this app owns. `(default)` for a dedicated project, a
   * per-app id for a pooled one. Passed to `getFirestore(app, databaseId)`.
   *
   * A database per app rather than a path prefix inside a shared one: indexes,
   * rules, backups and throughput are all per-database, so sharing one makes
   * every app's data model everyone else's problem.
   */
  firestoreDatabaseId: z.string(),
  functionsRegion: z.string().default("us-central1"),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfig>;

export const BuildStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
export type BuildStatus = z.infer<typeof BuildStatus>;

/** A release attempt — either an OTA update or a native binary build. */
export const Release = z.object({
  id: z.string(),
  appId: z.string(),
  kind: z.enum(["ota", "native"]),
  /** Why the router chose this kind — surfaced in the admin UI. */
  reason: z.string(),
  channel: z.string(),
  runtimeVersion: z.string(),
  status: BuildStatus,
  /** EAS build/update id, once known. */
  externalId: z.string().nullable().default(null),
  artifactUrl: z.string().nullable().default(null),
  createdAt: z.number(),
});
export type Release = z.infer<typeof Release>;
