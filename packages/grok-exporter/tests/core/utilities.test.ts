import { describe, expect, it, vi } from "vitest";
import { GrokExporterError, sanitizeError } from "../../src/core/errors";
import { hashJson, sha256Hex, utf8ByteLength } from "../../src/core/hash";
import { stableStringify } from "../../src/core/json";
import { assertSafeRelativePath, extensionFromMediaType, safePathSegment } from "../../src/core/paths";
import { redactJson, redactUrl } from "../../src/core/redaction";
import { isRetryableHttpStatus, parseRetryAfter, withRetry } from "../../src/core/retry";

describe("stable data utilities", () => {
  it("sorts object keys recursively before hashing", async () => {
    const left = { z: 1, a: { d: true, b: "x" } };
    const right = { a: { b: "x", d: true }, z: 1 };
    expect(stableStringify(left)).toBe(stableStringify(right));
    expect(await hashJson(left)).toBe(await hashJson(right));
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(utf8ByteLength("😀")).toBe(4);
  });
});

describe("path safety", () => {
  it("normalizes unsafe and reserved names", () => {
    expect(safePathSegment(" ../../CON: a/b ")).toBe("CON- a-b");
    expect(safePathSegment("   ")).toBe("untitled");
    expect(safePathSegment("NUL")).toBe("_NUL");
    expect(extensionFromMediaType("image/jpeg; charset=binary")).toBe("jpg");
  });

  it("rejects absolute paths and traversal", () => {
    expect(() => assertSafeRelativePath("conversations/abc")).not.toThrow();
    expect(() => assertSafeRelativePath("../secret")).toThrow();
    expect(() => assertSafeRelativePath("/tmp/export")).toThrow();
    expect(() => assertSafeRelativePath("C:\\private")).toThrow();
  });
});

describe("redaction", () => {
  it("redacts credential-shaped keys and signed URL parameters", () => {
    expect(redactJson({ cookie: "secret", nested: { message: "safe" } })).toEqual({
      cookie: "[REDACTED]",
      nested: { message: "safe" },
    });
    const redacted = redactUrl("https://assets.grok.com/file.png?x-amz-signature=abc&width=100");
    expect(redacted).toContain("x-amz-signature=%5BREDACTED%5D");
    expect(redacted).toContain("width=100");
    expect(sanitizeError(new Error("Authorization: Bearer abc.def"))).toMatchObject({
      message: "Authorization: Bearer [REDACTED]",
    });
  });
});

describe("retry behavior", () => {
  it("classifies transient statuses and Retry-After values", () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(403)).toBe(false);
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:01 GMT", 0)).toBe(1000);
  });

  it("retries only explicitly retryable failures", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const result = withRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new GrokExporterError("rate limited", { retryable: true });
      return "ok";
    }, { maxRetries: 3, baseDelayMs: 1, random: () => 0 });

    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("ok");
    expect(attempts).toBe(3);
    vi.useRealTimers();
  });
});
