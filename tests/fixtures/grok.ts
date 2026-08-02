import type { ApiSuccessResponse, ApiTransport, JsonValue } from "../../src/core/types";
import { BRIDGE_PROTOCOL_VERSION } from "../../src/core/types";
import { utf8ByteLength } from "../../src/core/hash";

export class FixtureTransport implements ApiTransport {
  readonly requests: Array<{ path: string; method: "GET" | "POST"; body?: JsonValue }> = [];

  constructor(private readonly responses: Map<string, JsonValue[]>) {}

  async request(request: { path: string; method: "GET" | "POST"; body?: JsonValue; timeoutMs: number }): Promise<ApiSuccessResponse> {
    this.requests.push({ path: request.path, method: request.method, ...(request.body === undefined ? {} : { body: request.body }) });
    const key = `${request.method} ${request.path}`;
    const queue = this.responses.get(key);
    if (!queue?.length) throw new Error(`Missing fixture response for ${key}`);
    const body = queue.shift() as JsonValue;
    return {
      requestId: crypto.randomUUID(),
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      ok: true,
      status: 200,
      body,
      responseBytes: utf8ByteLength(JSON.stringify(body)),
    };
  }
}

