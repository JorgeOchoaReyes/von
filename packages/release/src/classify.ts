/**
 * OTA-vs-native routing.
 *
 * The founding brief calls this "the key decision" and leaves it to a human
 * (stage 4). It is automatable because the answer is a pure function of the
 * diff, and because the two failure modes are wildly asymmetric:
 *
 *   - Wrongly choosing **native**: the user waits ~10 minutes for a build they
 *     did not need. Annoying, recoverable, invisible if we are already building.
 *   - Wrongly choosing **OTA**: the update ships JS that references a native
 *     module absent from the installed binary. The app crashes on launch, on a
 *     device we cannot reach, and the user's only fix is reinstalling.
 *
 * So the classifier is deliberately biased: anything it cannot *prove* is
 * JS-only is treated as native. `unknown-dependency` is the common case there.
 */

export type ReleaseKind = "ota" | "native" | "none";

export interface ChangeSet {
  /** Repo-relative paths touched by the change. */
  files: string[];
  /** Dependency names added or removed (not version bumps). */
  addedDependencies?: string[];
  removedDependencies?: string[];
  /** `expo.plugins` entries added or removed in app.json / app.config.*. */
  changedPlugins?: string[];
}

export interface ReleaseDecision {
  kind: ReleaseKind;
  /** Human-readable justification, surfaced in chat and in the admin UI. */
  reason: string;
  /** Every rule that fired, for debugging a surprising decision. */
  triggers: string[];
  /** True when the installed binary must be replaced before this can land. */
  requiresRuntimeBump: boolean;
}

/**
 * Paths that change what the native binary contains. Editing any of these
 * means the installed APK/IPA is now stale.
 */
const NATIVE_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/(^|\/)app\.json$/, "app.json (native config: bundle id, plugins, icons)"],
  [/(^|\/)app\.config\.(js|ts|mjs|cjs)$/, "dynamic Expo config"],
  [/(^|\/)eas\.json$/, "EAS build profiles"],
  [/(^|\/)(android|ios)\//, "native project directory"],
  [/(^|\/)Podfile(\.lock)?$/, "CocoaPods manifest"],
  [/(^|\/)google-services\.json$/, "Android Firebase config (compiled in)"],
  [/(^|\/)GoogleService-Info\.plist$/, "iOS Firebase config (compiled in)"],
  [/(^|\/)expo-module\.config\.json$/, "Expo native module config"],
];

/**
 * Paths that only affect the JS bundle or assets — safe to ship over the air.
 * Note that `metro.config.js` and `babel.config.js` are here: they change how
 * the bundle is *built*, and that build also happens during `eas update`.
 */
const JS_PATH_PATTERNS: RegExp[] = [
  /(^|\/)app\//,
  /(^|\/)src\//,
  /(^|\/)assets\//,
  /(^|\/)packages\//,
  /(^|\/)metro\.config\.js$/,
  /(^|\/)babel\.config\.js$/,
  /\.(ts|tsx|js|jsx|json|png|jpg|jpeg|svg|ttf|otf|webp|mp4)$/,
];

/**
 * Paths that ship through a completely different pipeline — Cloud Functions and
 * Firestore rules deploy from GitHub Actions and never touch the device bundle.
 */
const BACKEND_PATH_PATTERNS: RegExp[] = [
  /^functions\//,
  /(^|\/)firestore\.rules$/,
  /(^|\/)firestore\.indexes\.json$/,
  /(^|\/)firebase\.json$/,
];

const IGNORED_PATH_PATTERNS: RegExp[] = [
  /^\.github\//,
  /(^|\/)README\.md$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)DEPLOY\.md$/,
  /(^|\/)\.env\.example$/,
];

/**
 * Dependencies known to be pure JS. Anything outside this list is assumed to
 * carry native code — see the asymmetry note at the top of the file.
 *
 * Keep this list conservative. It is safe to omit a JS-only package (costs one
 * unnecessary build); it is not safe to add a package that turns out to have a
 * config plugin or autolinked native module.
 */
const KNOWN_JS_ONLY = new Set([
  "clsx",
  "date-fns",
  "dayjs",
  "immer",
  "lodash",
  "nanoid",
  "react",
  "react-dom",
  "tailwind-merge",
  "zod",
  "zustand",
  "@tanstack/react-query",
]);

/** Packages whose presence always implies a native rebuild, for clarity in logs. */
const KNOWN_NATIVE_PREFIXES = [
  "expo-",
  "react-native-",
  "@react-native",
  "@react-native-",
  "@shopify/react-native",
  "@stripe/stripe-react-native",
];

export function classifyChange(change: ChangeSet): ReleaseDecision {
  const triggers: string[] = [];
  let sawJs = false;
  let sawBackend = false;

  for (const file of change.files) {
    if (IGNORED_PATH_PATTERNS.some((p) => p.test(file))) continue;

    const native = NATIVE_PATH_PATTERNS.find(([p]) => p.test(file));
    if (native) {
      triggers.push(`${file}: ${native[1]}`);
      continue;
    }

    if (BACKEND_PATH_PATTERNS.some((p) => p.test(file))) {
      sawBackend = true;
      continue;
    }

    if (JS_PATH_PATTERNS.some((p) => p.test(file))) {
      sawJs = true;
      continue;
    }

    // Unrecognised path. Treat as native — see the asymmetry note.
    triggers.push(`${file}: unrecognised path, assuming native impact`);
  }

  for (const dep of change.addedDependencies ?? []) {
    if (KNOWN_JS_ONLY.has(dep)) {
      sawJs = true;
      continue;
    }
    const prefix = KNOWN_NATIVE_PREFIXES.find((p) => dep.startsWith(p));
    triggers.push(
      prefix
        ? `+${dep}: native module (${prefix}*)`
        : `+${dep}: unknown dependency, assuming native`,
    );
  }

  for (const dep of change.removedDependencies ?? []) {
    if (KNOWN_JS_ONLY.has(dep)) {
      sawJs = true;
      continue;
    }
    triggers.push(`-${dep}: removing a possibly-native dependency`);
  }

  for (const plugin of change.changedPlugins ?? []) {
    triggers.push(`plugin ${plugin}: config plugins run at prebuild time`);
  }

  if (triggers.length > 0) {
    return {
      kind: "native",
      reason: `Needs a new build — ${triggers[0]}${
        triggers.length > 1 ? ` (+${triggers.length - 1} more)` : ""
      }. An OTA update cannot change the installed binary, so this ships as a build with a bumped runtime version.`,
      triggers,
      requiresRuntimeBump: true,
    };
  }

  if (sawJs) {
    return {
      kind: "ota",
      reason:
        "JS and asset changes only — publishing over the air. Reaches the installed build in about a minute; no reinstall.",
      triggers: [],
      requiresRuntimeBump: false,
    };
  }

  if (sawBackend) {
    return {
      kind: "none",
      reason:
        "Backend-only change (functions, rules, or indexes). Deploys through GitHub Actions; the app bundle is untouched.",
      triggers: [],
      requiresRuntimeBump: false,
    };
  }

  return {
    kind: "none",
    reason: "No changes that affect the app bundle or backend.",
    triggers: [],
    requiresRuntimeBump: false,
  };
}

/**
 * Next runtime version.
 *
 * With `runtimeVersion: { policy: "appVersion" }` the runtime version *is* the
 * app version, so bumping the app version is what makes an old OTA channel stop
 * matching a new binary. That is the mechanism preventing a fresh JS bundle
 * from landing on a binary that lacks the native module it needs.
 */
export function nextRuntimeVersion(current: string, decision: ReleaseDecision): string {
  if (!decision.requiresRuntimeBump) return current;
  const [major = 1, minor = 0, patch = 0] = current.split(".").map(Number);
  return `${major}.${minor + 1}.${patch === 0 ? 0 : 0}`;
}
