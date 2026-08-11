import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { API_URL, APP_ID } from "./config";

/**
 * Telling the platform this app failed to start.
 *
 * An update lands on every installed device in about a minute, with no review
 * step between the change and the phone. If it crashes on launch, the person
 * best placed to notice is holding an app that will not open — so the app has
 * to speak for itself.
 *
 * Deliberately minimal. It reports *that* a launch failed and *which build* it
 * was, and nothing else: no stack trace, no message, no device identifiers.
 * Those would be user data flowing to the platform from an app the platform did
 * not write the content of, and the count alone is enough to raise the question
 * with whoever published the change.
 */

let reported = false;

/**
 * The build's identity, taken from expo-updates.
 *
 * `updateId` names the exact bundle the device is running, which is what makes
 * attribution precise. It is absent in development and on a build still running
 * its embedded bundle, so the runtime version is the fallback — coarser, but it
 * still identifies which release the device could be on.
 */
function identity(): { runtimeVersion: string; updateGroup?: string } {
  const runtimeVersion =
    (Constants.expoConfig?.runtimeVersion as string | undefined) ??
    Updates.runtimeVersion ??
    "unknown";

  return Updates.updateId
    ? { runtimeVersion, updateGroup: Updates.updateId }
    : { runtimeVersion };
}

/**
 * Report once per launch, at most.
 *
 * A crash loop would otherwise post on every restart and turn one broken device
 * into a flood — inflating a count whose only job is to be a rough signal.
 */
export async function reportLaunchFailure(): Promise<void> {
  if (reported || __DEV__) return;
  reported = true;

  try {
    await fetch(`${API_URL}/v1/apps/${APP_ID}/crash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(identity()),
    });
  } catch {
    // Swallowed on purpose. This runs *because* something already went wrong;
    // a failed report must not become a second error on top of the first.
  }
}

/**
 * Install a global handler for errors that escape React.
 *
 * `ErrorUtils` is React Native's own hook, and the `isFatal` flag is the one
 * that matters: a non-fatal error is a bug, but a fatal one means this launch
 * is over. Chaining to the previous handler keeps the red box in development
 * and the normal crash path in production — this reports, it does not swallow.
 */
export function installCrashReporter(): void {
  const globals = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler(): (error: Error, isFatal?: boolean) => void;
      setGlobalHandler(handler: (error: Error, isFatal?: boolean) => void): void;
    };
  };

  const errorUtils = globals.ErrorUtils;
  if (!errorUtils) return;

  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    if (isFatal) void reportLaunchFailure();
    previous(error, isFatal);
  });
}
