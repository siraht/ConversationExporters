import { GrokExporterError } from "./errors";
import type { CancellationSignal } from "./types";

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  cancellation?: CancellationSignal;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const random = options.random ?? Math.random;

  for (let attempt = 0; ; attempt += 1) {
    await options.cancellation?.waitIfPaused?.();
    options.cancellation?.throwIfCancelled();
    try {
      return await operation(attempt);
    } catch (error) {
      const retryable = error instanceof GrokExporterError && error.retryable;
      if (!retryable || attempt >= options.maxRetries) throw error;

      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jittered = Math.max(1, Math.round(exponential * (0.75 + random() * 0.5)));
      const delayMs = Math.max(jittered, error.retryAfterMs ?? 0);
      options.onRetry?.(error, attempt + 1, delayMs);
      await cancellableDelay(delayMs, options.cancellation);
    }
  }
}

export async function cancellableDelay(delayMs: number, cancellation?: CancellationSignal): Promise<void> {
  await cancellation?.waitIfPaused?.();
  cancellation?.throwIfCancelled();
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  cancellation?.throwIfCancelled();
}

export class RequestPacer {
  private nextAllowedAt = 0;

  constructor(private readonly intervalMs: number) {}

  async wait(cancellation?: CancellationSignal): Promise<void> {
    const now = Date.now();
    const delayMs = Math.max(0, this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.intervalMs;
    await cancellableDelay(delayMs, cancellation);
  }
}
