import type { SanitizedError } from "./types";

export class GrokExporterError extends Error {
  readonly code?: string;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      code?: string;
      httpStatus?: number;
      retryable?: boolean;
      retryAfterMs?: number;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GrokExporterError";
    if (options.code !== undefined) this.code = options.code;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export function sanitizeError(error: unknown): SanitizedError {
  if (error instanceof GrokExporterError) {
    return {
      name: error.name,
      message: redactErrorMessage(error.message),
      retryable: error.retryable,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactErrorMessage(error.message),
      retryable: false,
    };
  }

  return {
    name: "UnknownError",
    message: redactErrorMessage(String(error)),
    retryable: false,
  };
}

export function redactErrorMessage(message: string): string {
  return message
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/([?&](?:token|key|signature|sig|auth|expires|x-amz-[^=]+)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(sso|sso-rw|auth_token)=[^;\s]+/gi, "$1=[REDACTED]");
}
