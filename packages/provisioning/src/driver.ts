import type { ResourceKind } from "@von/core";

/**
 * A driver owns exactly one kind of external resource.
 *
 * The contract is deliberately narrow so that every driver is *idempotent by
 * construction*:
 *
 *   - `key(spec)` is a pure function. Same app + same spec => same key, forever.
 *   - `read(spec)` answers "does this already exist on the provider?" without
 *     creating anything. It is the recovery path when our ledger write was lost
 *     but the provider-side create succeeded.
 *   - `create(spec)` may be called more than once for the same key. It must
 *     either return the existing resource or fail with a retryable error.
 *
 * Drivers never talk to the ledger or to each other. The orchestrator wires
 * outputs from one step into the spec of the next.
 */
export interface Driver<Spec, Outputs extends Record<string, unknown>> {
  readonly kind: ResourceKind;

  key(spec: Spec): string;

  /** Return existing outputs, or null if the resource does not exist yet. */
  read(spec: Spec): Promise<Outputs | null>;

  create(spec: Spec): Promise<Outputs>;

  /** Best-effort teardown. Called on app deletion and on plan rollback. */
  destroy?(spec: Spec, outputs: Outputs): Promise<void>;
}

/**
 * Thrown for failures that are worth retrying (429, 5xx, provider eventual
 * consistency). Anything else aborts the run and surfaces to the user.
 */
export class RetryableError extends Error {
  // Declared as fields rather than constructor parameter properties: Node's
  // --experimental-strip-types runs in strip-only mode and rejects the latter.
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class TerminalError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "TerminalError";
    this.hint = hint;
  }
}

/** Classify an HTTP response into the retry taxonomy above. */
export async function assertOk(res: Response, context: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  const snippet = body.slice(0, 400);

  if (res.status === 429 || res.status >= 500) {
    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    throw new RetryableError(
      `${context}: ${res.status} ${snippet}`,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  // 409 usually means "already exists" — the caller decides whether that is
  // success (idempotent create) or a real conflict.
  throw new TerminalError(`${context}: ${res.status} ${snippet}`);
}
