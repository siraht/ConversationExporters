import { describe, expect, it } from "vitest";
import { boundedInteger, dashboardErrorMessage, strictInteger } from "../src/dashboard";

function input(id: string, value: string): HTMLInputElement {
  return { id, value } as HTMLInputElement;
}

describe("shared dashboard helpers", () => {
  it("preserves Grok's bounded integer behavior", () => {
    expect(boundedInteger(input("workers", "4.6"), 1, 8)).toBe(5);
    expect(boundedInteger(input("workers", "20"), 1, 8)).toBe(8);
    expect(boundedInteger(input("workers", "invalid"), 1, 8)).toBe(1);
  });

  it("preserves ChatGPT's strict integer behavior", () => {
    expect(strictInteger(input("workers", "5"), 1, 8)).toBe(5);
    expect(() => strictInteger(input("workers", "4.5"), 1, 8)).toThrow("workers must be 1-8.");
  });

  it("normalizes dashboard errors without hiding their message", () => {
    expect(dashboardErrorMessage(new Error("failed"))).toBe("failed");
    expect(dashboardErrorMessage("failed")).toBe("failed");
  });
});
