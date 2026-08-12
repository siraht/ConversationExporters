export function requiredElement<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing dashboard element: ${id}`);
  return value as T;
}

export function setDashboardStatus(element: HTMLElement, message: string, state: string): void {
  element.textContent = message;
  element.dataset.state = state;
}

export function dashboardErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function boundedInteger(input: HTMLInputElement, minimum: number, maximum: number): number {
  const value = Number(input.value);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : minimum;
}

export function strictInteger(input: HTMLInputElement, minimum: number, maximum: number): number {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${input.id} must be ${minimum}-${maximum}.`);
  return value;
}

export function automaticInterval(search: string, minimumSeconds = 300): number | undefined {
  const raw = new URLSearchParams(search).get("auto");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= minimumSeconds ? Math.round(seconds) * 1_000 : undefined;
}
