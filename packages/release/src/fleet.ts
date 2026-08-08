/**
 * Fleet rollout — applying one change across many apps.
 *
 * This is how a blueprint fix, a dependency bump, or a security patch reaches
 * every app already generated. It is deliberately *not* a for-loop:
 *
 *   - one app's failure must not stop the rollout, or a single bad repo blocks
 *     a security fix for everyone else;
 *   - concurrency is bounded, because GitHub and EAS rate-limit per
 *     installation and a burst of 1000 pushes gets the whole platform throttled;
 *   - it is resumable, since a rollout across thousands of apps will be
 *     interrupted at some point.
 */

export interface RolloutItem {
  appId: string;
}

export interface RolloutOutcome<T> {
  appId: string;
  status: "ok" | "failed" | "skipped";
  result?: T;
  error?: string;
}

export interface RolloutOptions<T> {
  /** Max apps in flight. Keep well under provider rate limits. */
  concurrency?: number;
  /** Stop the whole rollout once this many apps have failed. */
  abortAfterFailures?: number;
  onProgress?: (done: number, total: number, last: RolloutOutcome<T>) => void;
  /** Return false to skip an app without counting it as a failure. */
  filter?: (item: RolloutItem) => boolean | Promise<boolean>;
}

export interface RolloutSummary<T> {
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  aborted: boolean;
  outcomes: RolloutOutcome<T>[];
}

export async function rollout<T>(
  items: RolloutItem[],
  apply: (item: RolloutItem) => Promise<T>,
  opts: RolloutOptions<T> = {},
): Promise<RolloutSummary<T>> {
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const abortAfter = opts.abortAfterFailures ?? Infinity;

  const outcomes: RolloutOutcome<T>[] = [];
  let cursor = 0;
  let failures = 0;
  let aborted = false;

  const worker = async (): Promise<void> => {
    while (true) {
      if (aborted) return;
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index]!;

      let outcome: RolloutOutcome<T>;
      try {
        const include = opts.filter ? await opts.filter(item) : true;
        if (!include) {
          outcome = { appId: item.appId, status: "skipped" };
        } else {
          outcome = { appId: item.appId, status: "ok", result: await apply(item) };
        }
      } catch (err) {
        failures++;
        outcome = {
          appId: item.appId,
          status: "failed",
          error: (err as Error).message,
        };
        // A broad failure (a bad blueprint commit, an expired token) would
        // otherwise churn through every app producing the same error.
        if (failures >= abortAfter) aborted = true;
      }

      outcomes.push(outcome);
      opts.onProgress?.(outcomes.length, items.length, outcome);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return {
    total: items.length,
    ok: outcomes.filter((o) => o.status === "ok").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    aborted,
    outcomes,
  };
}
