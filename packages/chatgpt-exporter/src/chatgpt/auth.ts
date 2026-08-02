import { parseSessionEnvelopeInsidePage } from "./envelopes";

export interface SafeSessionMetadata {
  authenticated: true;
  expiresAt: string;
}

export class PageLocalAuth {
  #accessToken: string | null = null;
  #expiresAt = 0;

  constructor(
    private readonly fetcher: typeof fetch = (input, init) => window.fetch(input, init),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async probe(signal?: AbortSignal): Promise<SafeSessionMetadata> {
    await this.#refreshIfNeeded(signal);
    return { authenticated: true, expiresAt: new Date(this.#expiresAt).toISOString() };
  }

  async authorizationHeaders(workspaceId: string | null, signal?: AbortSignal): Promise<Record<string, string>> {
    await this.#refreshIfNeeded(signal);
    if (!this.#accessToken) throw new PageAuthenticationError("ChatGPT did not provide an access token.");
    return {
      Authorization: `Bearer ${this.#accessToken}`,
      "X-Authorization": `Bearer ${this.#accessToken}`,
      ...(workspaceId === null ? {} : { "ChatGPT-Account-Id": workspaceId }),
    };
  }

  containsCurrentToken(text: string): boolean {
    return this.#accessToken !== null && text.includes(this.#accessToken);
  }

  clear(): void {
    this.#accessToken = null;
    this.#expiresAt = 0;
  }

  async #refreshIfNeeded(signal?: AbortSignal): Promise<void> {
    if (this.#accessToken && this.#expiresAt - this.now() > 60_000) return;
    let response: Response;
    try {
      response = await this.fetcher("/api/auth/session", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      this.clear();
      throw new PageAuthenticationError("Could not reach the ChatGPT session endpoint.");
    }
    if (!response.ok) {
      this.clear();
      throw new PageAuthenticationError(`ChatGPT session check failed with HTTP ${response.status}.`, response.status);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      this.clear();
      throw new PageAuthenticationError("ChatGPT returned an invalid session response.");
    }
    try {
      const session = parseSessionEnvelopeInsidePage(value);
      const expiresAt = Date.parse(session.expires);
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
        throw new PageAuthenticationError("ChatGPT returned an expired session.");
      }
      this.#accessToken = session.accessToken;
      this.#expiresAt = expiresAt;
    } catch (error) {
      this.clear();
      if (error instanceof PageAuthenticationError) throw error;
      throw new PageAuthenticationError("ChatGPT returned an invalid session response.");
    }
  }
}

export class PageAuthenticationError extends Error {
  readonly code = "AUTHENTICATION_REQUIRED";
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "PageAuthenticationError";
  }
}
