import { describe, expect, it } from "vitest";

import { BRIDGE_PROTOCOL_VERSION, failureResponse, requestId } from "../../src/extension/protocol";

describe("extension protocol", () => {
  it("fails unimplemented authenticated requests closed", () => {
    expect(failureResponse("request-1", "ENDPOINTS_NOT_IMPLEMENTED", "Not implemented.", { correlationId: "correlation-1" })).toEqual({
      requestId: "request-1",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      ok: false,
      error: {
        name: "ChatGPTExporterError",
        code: "ENDPOINTS_NOT_IMPLEMENTED",
        message: "Not implemented.",
        retryable: false,
        correlationId: "correlation-1",
      },
    });
  });

  it("accepts only a present string request identifier", () => {
    expect(requestId({ requestId: "request-2" })).toBe("request-2");
    expect(requestId({ requestId: "" })).toBe("unknown");
    expect(requestId(null)).toBe("unknown");
  });
});
