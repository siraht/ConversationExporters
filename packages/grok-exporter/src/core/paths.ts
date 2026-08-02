const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function safePathSegment(value: string, fallback = "untitled", maxLength = 120): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .replace(/^[ .-]+|[ .]+$/g, "")
    .slice(0, maxLength)
    .replace(/[ .]+$/g, "");

  const candidate = normalized || fallback;
  return WINDOWS_RESERVED.test(candidate) ? `_${candidate}` : candidate;
}

export function assertSafeRelativePath(path: string): void {
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[a-z]:/i.test(path)) {
    throw new Error(`Unsafe absolute path: ${path}`);
  }

  const segments = path.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe relative path: ${path}`);
  }
}

export function conversationBasePath(conversationId: string): string {
  const safeId = safePathSegment(conversationId, "missing-id", 160);
  const path = `conversations/${safeId}`;
  assertSafeRelativePath(path);
  return path;
}

export function extensionFromMediaType(mediaType: string | undefined): string {
  if (!mediaType) return "bin";
  const normalized = mediaType.toLowerCase().split(";", 1)[0]?.trim();
  const known: Record<string, string> = {
    "application/json": "json",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "text/csv": "csv",
    "text/markdown": "md",
    "text/plain": "txt",
    "video/mp4": "mp4",
    "video/webm": "webm",
  };
  return known[normalized ?? ""] ?? safePathSegment(normalized?.split("/").at(-1) ?? "bin", "bin", 12);
}
