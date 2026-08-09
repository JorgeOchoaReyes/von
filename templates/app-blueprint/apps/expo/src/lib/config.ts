import Constants from "expo-constants";

/**
 * Where this app's backend lives — fetched at boot, not baked into the bundle.
 *
 * The reference implementation hardcoded the Firebase config in the source. That
 * is right for one app and fatal for a platform: it means the backend an
 * installed build talks to is frozen at build time, so moving an app from the
 * shared pool to its own Firebase project would need a rebuild, a store review,
 * and every user to reinstall.
 *
 * Fetching it instead makes that migration a server-side change the app picks up
 * on its next launch. It is the one indirection the whole tiering model rests
 * on.
 *
 * These values are not secret. A Firebase *web* config ships in every client
 * binary ever published; access control lives in Firestore rules and in the
 * GCIP tenant, not in keeping these strings hidden.
 */
export interface RuntimeConfig {
  appId: string;
  backendTier: "pooled" | "dedicated";
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    storageBucket: string;
    messagingSenderId: string;
    appId: string;
  };
  /** Present for pooled apps; scopes sign-in to this app's own user pool. */
  gcipTenantId: string | null;
  /** `(default)` for a dedicated project, a per-app id inside a pool. */
  firestoreDatabaseId: string;
  functionsRegion: string;
}

const extra = Constants.expoConfig?.extra as
  | { vonApiUrl?: string; vonAppId?: string }
  | undefined;

export const API_URL = extra?.vonApiUrl ?? "{{VON_API_URL}}";
export const APP_ID = extra?.vonAppId ?? "{{APP_ID}}";

let cached: RuntimeConfig | null = null;
let inFlight: Promise<RuntimeConfig> | null = null;

/**
 * Fetch once per process, and share the request.
 *
 * Several screens can mount before the first response lands; without the shared
 * promise each would issue its own request and initialise Firebase separately.
 */
export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const res = await fetch(`${API_URL}/v1/apps/${APP_ID}/runtime-config`);
    if (!res.ok) {
      // Deliberately fatal. Continuing without a backend would mean an app that
      // renders, accepts input, and silently drops everything the user does.
      throw new Error(
        `could not load runtime config (${res.status}). The app may still be provisioning.`,
      );
    }
    cached = (await res.json()) as RuntimeConfig;
    return cached;
  })();

  // A failed load must not stick: clear the slot so the next call retries
  // rather than every caller for the life of the process replaying one failure.
  inFlight.catch(() => {
    inFlight = null;
  });

  return inFlight;
}
