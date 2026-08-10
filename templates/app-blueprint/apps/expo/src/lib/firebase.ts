import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, signInAnonymously, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getFunctions, type Functions } from "firebase/functions";
import { loadRuntimeConfig, type RuntimeConfig } from "./config";

/**
 * Firebase, initialised from config fetched at boot.
 *
 * Two lines here carry the platform's whole isolation model:
 *
 *   auth.tenantId       — the app's own GCIP tenant. A user of this app cannot
 *                         authenticate into any other app in the pool: separate
 *                         credential store, separate uid space.
 *   getFirestore(db,id) — the app's own *named database*, not a path prefix in a
 *                         shared one. Its own indexes, rules, backups and
 *                         throughput, so one app's data model is nobody else's
 *                         problem.
 *
 * Both come from the runtime config, which is why an app can be promoted from
 * the shared pool to its own Firebase project without being rebuilt.
 */
export interface Backend {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
  config: RuntimeConfig;
}

let backend: Backend | null = null;
let inFlight: Promise<Backend> | null = null;

async function connect(): Promise<Backend> {
  const config = await loadRuntimeConfig();

  // getApps() guards against fast refresh re-running this module in
  // development, which would otherwise throw on a duplicate app name.
  const app = getApps()[0] ?? initializeApp(config.firebase);

  const auth = getAuth(app);
  if (config.gcipTenantId) {
    // Must be set before any sign-in call, or the user lands in the pool
    // project's default tenant — shared with every other app in the pool.
    auth.tenantId = config.gcipTenantId;
  }

  const db = getFirestore(app, config.firestoreDatabaseId);
  const functions = getFunctions(app, config.functionsRegion);

  return { app, auth, db, functions, config };
}

/** The connected backend, initialised once and shared. */
export function getBackend(): Promise<Backend> {
  if (backend) return Promise.resolve(backend);
  if (inFlight) return inFlight;

  inFlight = connect().then((b) => {
    backend = b;
    return b;
  });
  inFlight.catch(() => {
    inFlight = null;
  });

  return inFlight;
}

/**
 * Sign in anonymously, so the app has a uid to scope data by from first launch.
 *
 * Anonymous rather than a sign-up wall: the generated app should do something
 * useful before it asks anyone for an email. The account can be upgraded later
 * without losing data.
 */
export async function ensureSignedIn(): Promise<string> {
  const { auth } = await getBackend();
  if (auth.currentUser) return auth.currentUser.uid;
  const { user } = await signInAnonymously(auth);
  return user.uid;
}
