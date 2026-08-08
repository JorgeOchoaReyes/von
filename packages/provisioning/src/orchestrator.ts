import {
  newResourceRecord,
  type ResourceLedger,
  type ResourceRecord,
} from "@von/core";
import { RetryableError, TerminalError, type Driver } from "./driver.ts";

/**
 * One node in a provisioning plan.
 *
 * `spec` is a *thunk* rather than a value because most steps depend on outputs
 * of earlier steps (the Firebase web config feeds the GitHub secret, the Expo
 * project id feeds app.json). The thunk receives everything produced so far.
 */
export interface Step<Spec = any, Outputs extends Record<string, unknown> = any> {
  id: string;
  driver: Driver<Spec, Outputs>;
  spec: (ctx: PlanContext) => Spec;
  /** Step ids that must reach `ready` first. */
  needs?: string[];
  /** Skip this step entirely (e.g. dedicated-only steps for a pooled app). */
  when?: (ctx: PlanContext) => boolean;
}

export interface PlanContext {
  appId: string;
  /** Outputs of completed steps, keyed by step id. */
  outputs: Record<string, Record<string, unknown>>;
  /** Free-form inputs the plan was started with. */
  input: Record<string, unknown>;
}

export interface Plan {
  name: string;
  steps: Step[];
}

export interface RunEvent {
  type: "step.start" | "step.ok" | "step.skip" | "step.retry" | "step.fail";
  stepId: string;
  attempt?: number;
  message?: string;
}

export interface RunOptions {
  maxAttemptsPerStep?: number;
  onEvent?: (e: RunEvent) => void;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs a plan to completion, resuming from wherever the ledger says it got to.
 *
 * Calling this twice for the same app is safe and is the intended recovery
 * mechanism: steps already `ready` in the ledger are skipped, and steps that
 * are `creating` (i.e. we crashed mid-flight) are reconciled by asking the
 * driver's `read()` before attempting another `create()`.
 */
export async function runPlan(
  plan: Plan,
  ctx: PlanContext,
  ledger: ResourceLedger,
  opts: RunOptions = {},
): Promise<PlanContext> {
  const maxAttempts = opts.maxAttemptsPerStep ?? 5;
  const sleep = opts.sleep ?? defaultSleep;
  const emit = opts.onEvent ?? (() => {});

  for (const step of order(plan.steps)) {
    if (step.when && !step.when(ctx)) {
      emit({ type: "step.skip", stepId: step.id });
      continue;
    }

    const spec = step.spec(ctx);
    const key = step.driver.key(spec);

    let record = (await ledger.get(key)) ?? newResourceRecord(key, step.driver.kind, ctx.appId);

    if (record.state === "ready") {
      ctx.outputs[step.id] = record.outputs;
      emit({ type: "step.skip", stepId: step.id, message: "already provisioned" });
      continue;
    }

    emit({ type: "step.start", stepId: step.id });

    // Reconcile a possibly-orphaned resource before creating a second one.
    if (record.state === "creating") {
      const existing = await step.driver.read(spec).catch(() => null);
      if (existing) {
        record = await settle(ledger, record, existing);
        ctx.outputs[step.id] = existing;
        emit({ type: "step.ok", stepId: step.id, message: "recovered" });
        continue;
      }
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      record.state = "creating";
      record.attempts = attempt;
      await ledger.upsert(record);

      try {
        const outputs = (await step.driver.create(spec)) as Record<string, unknown>;
        record = await settle(ledger, record, outputs);
        ctx.outputs[step.id] = outputs;
        emit({ type: "step.ok", stepId: step.id, attempt });
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;

        if (err instanceof TerminalError) break;

        if (attempt < maxAttempts) {
          const backoff =
            err instanceof RetryableError && err.retryAfterMs
              ? err.retryAfterMs
              : Math.min(30_000, 2 ** attempt * 500) + Math.random() * 250;
          emit({
            type: "step.retry",
            stepId: step.id,
            attempt,
            message: (err as Error).message,
          });
          await sleep(backoff);
        }
      }
    }

    if (lastError) {
      record.state = "failed";
      record.error = (lastError as Error).message;
      await ledger.upsert(record);
      emit({ type: "step.fail", stepId: step.id, message: record.error });
      throw lastError;
    }
  }

  return ctx;
}

async function settle(
  ledger: ResourceLedger,
  record: ResourceRecord,
  outputs: Record<string, unknown>,
): Promise<ResourceRecord> {
  const next: ResourceRecord = {
    ...record,
    state: "ready",
    error: null,
    outputs,
    externalId:
      typeof outputs.externalId === "string" ? outputs.externalId : record.externalId,
  };
  await ledger.upsert(next);
  return next;
}

/** Topological sort over `needs`. Throws on a cycle or a dangling dependency. */
function order(steps: Step[]): Step[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const sorted: Step[] = [];
  const mark = new Map<string, "visiting" | "done">();

  const visit = (step: Step, trail: string[]): void => {
    const state = mark.get(step.id);
    if (state === "done") return;
    if (state === "visiting") {
      throw new Error(`Cyclic provisioning plan: ${[...trail, step.id].join(" -> ")}`);
    }
    mark.set(step.id, "visiting");
    for (const need of step.needs ?? []) {
      const dep = byId.get(need);
      if (!dep) throw new Error(`Step "${step.id}" depends on unknown step "${need}"`);
      visit(dep, [...trail, step.id]);
    }
    mark.set(step.id, "done");
    sorted.push(step);
  };

  for (const step of steps) visit(step, []);
  return sorted;
}
