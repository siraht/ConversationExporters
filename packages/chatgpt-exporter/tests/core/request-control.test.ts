import { describe, expect, it, vi } from "vitest";

import { ControlledTransport } from "../../src/core/request-control";
import type { ChatGptTransport } from "../../src/chatgpt/client";
import type { ApiSuccessResponse } from "../../src/extension/protocol";

const response: ApiSuccessResponse = {
  requestId: "request",
  protocolVersion: 1,
  ok: true,
  status: 200,
  body: {},
  responseBytes: 2,
  correlationId: "correlation",
};

describe("cooperative provider request control", () => {
  it("pauses before the next request and resumes it without losing the operation", async () => {
    const inner = transport();
    const controlled = new ControlledTransport(inner, { delayMs: 0, maxConcurrency: 1 });
    controlled.pause();
    const pending = controlled.request({ operation: "session_probe", parameters: {} }, null);
    await Promise.resolve();
    expect(inner.request).not.toHaveBeenCalled();
    controlled.resume();
    await expect(pending).resolves.toEqual(response);
    expect(inner.request).toHaveBeenCalledTimes(1);
  });

  it("cancels queued requests with a retryable terminal error", async () => {
    const inner = transport();
    const controlled = new ControlledTransport(inner, { delayMs: 0, maxConcurrency: 1 });
    controlled.pause();
    const pending = controlled.request({ operation: "session_probe", parameters: {} }, null);
    controlled.cancel();
    await expect(pending).rejects.toMatchObject({ code: "RUN_CANCELLED", retryable: true });
    expect(inner.request).not.toHaveBeenCalled();
  });

  it("enforces the configured delay between completed requests", async () => {
    let now = 1_000;
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const inner = transport();
    const controlled = new ControlledTransport(inner, { delayMs: 250, maxConcurrency: 1, now: () => now, sleep });
    await controlled.request({ operation: "session_probe", parameters: {} }, null);
    await controlled.request({ operation: "session_probe", parameters: {} }, null);
    expect(sleep).toHaveBeenLastCalledWith(250);
  });

  it("retries transient failures with jittered exponential backoff and Retry-After", async () => {
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const transient = Object.assign(new Error("rate limited"), { retryable: true, retryAfterMs: 2_000 });
    const inner = transport();
    inner.request.mockRejectedValueOnce(transient).mockRejectedValueOnce(Object.assign(new Error("unavailable"), { retryable: true }));
    const controlled = new ControlledTransport(inner, {
      delayMs: 0,
      maxConcurrency: 1,
      maxRetries: 2,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
      random: () => 0,
      sleep,
    });

    await expect(controlled.request({ operation: "session_probe", parameters: {} }, null)).resolves.toEqual(response);
    expect(inner.request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([2_000, 1_500]);
  });

  it("does not retry terminal failures and stops after the retry limit", async () => {
    const terminal = Object.assign(new Error("forbidden"), { retryable: false });
    const terminalInner = transport();
    terminalInner.request.mockRejectedValue(terminal);
    const terminalControl = new ControlledTransport(terminalInner, { delayMs: 0, maxConcurrency: 1 });
    await expect(terminalControl.request({ operation: "session_probe", parameters: {} }, null)).rejects.toBe(terminal);
    expect(terminalInner.request).toHaveBeenCalledTimes(1);

    const transient = Object.assign(new Error("unavailable"), { retryable: true });
    const retryInner = transport();
    retryInner.request.mockRejectedValue(transient);
    const retryControl = new ControlledTransport(retryInner, {
      delayMs: 0,
      maxConcurrency: 1,
      maxRetries: 1,
      retryBaseDelayMs: 1,
      random: () => 0,
      sleep: async () => undefined,
    });
    await expect(retryControl.request({ operation: "session_probe", parameters: {} }, null)).rejects.toBe(transient);
    expect(retryInner.request).toHaveBeenCalledTimes(2);
  });
});

function transport(): ChatGptTransport & { request: ReturnType<typeof vi.fn> } {
  return { request: vi.fn(async () => response) } as ChatGptTransport & { request: ReturnType<typeof vi.fn> };
}
