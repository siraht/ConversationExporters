import { describe, expect, it, vi } from "vitest";
import { RunControl } from "../../src/core/control";

describe("run control", () => {
  it("blocks at pause points and resumes explicitly", async () => {
    const control = new RunControl();
    const completed = vi.fn();
    control.pause();
    const waiting = control.waitIfPaused().then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    control.resume();
    await waiting;
    expect(completed).toHaveBeenCalledOnce();
  });

  it("wakes paused work when cancelled and throws AbortError", async () => {
    const control = new RunControl();
    control.pause();
    const waiting = control.waitIfPaused();
    control.cancel();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(() => control.throwIfCancelled()).toThrow("Export cancelled");
  });
});

