import type { CancellationSignal } from "./types";

export class RunControl implements CancellationSignal {
  cancelled = false;
  paused = false;
  private resumeResolvers: Array<() => void> = [];

  cancel(): void {
    this.cancelled = true;
    this.resume();
  }

  pause(): void {
    if (!this.cancelled) this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const resolvers = this.resumeResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new DOMException("Export cancelled by the user.", "AbortError");
  }

  async waitIfPaused(): Promise<void> {
    this.throwIfCancelled();
    if (!this.paused) return;
    await new Promise<void>((resolve) => this.resumeResolvers.push(resolve));
    this.throwIfCancelled();
  }
}

