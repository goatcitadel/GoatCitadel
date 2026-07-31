export function isSuspiciousEncodedPath(rawUrl: string): boolean {
  const pathOnly = rawUrl.split("?")[0] ?? "";
  const lower = pathOnly.toLowerCase();
  if (/%00/.test(lower) || /%2f|%5c/.test(lower)) {
    return true;
  }

  const decoded = decodePathSafely(pathOnly);
  if (!decoded) {
    return true;
  }
  if (decoded.includes("\0")) {
    return true;
  }
  if (startsWithSuspiciousWindowsPrefix(decoded)) {
    return true;
  }
  const normalized = decoded.replaceAll("\\", "/");
  if (normalized.includes("/../") || normalized.startsWith("../") || normalized.endsWith("/..")) {
    return true;
  }

  const segments = normalized.split("/").filter(Boolean);
  return segments.some(
    (segment, index) =>
      !isOpaqueDurableWatcherIdSegment(segments, index) &&
      (hasNtfsAlternateDataStream(segment) || isWindowsReservedDeviceSegment(segment)),
  );
}

/**
 * Durable watcher IDs are opaque database keys rather than filesystem names.
 * Their canonical producers use colon-delimited provenance, so the exact
 * watcher-control route segments must not be mistaken for NTFS alternate data
 * streams. Encoded separators, nulls, traversal, and every non-watcher segment
 * remain governed by the checks above and below.
 */
function isOpaqueDurableWatcherIdSegment(segments: string[], index: number): boolean {
  const isBackgroundTaskControl =
    segments.length === 8 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "durable" &&
    segments[3] === "runs" &&
    segments[5] === "background-tasks" &&
    segments[7] === "control" &&
    index === 6;
  const isDirectWatcherControl =
    segments.length === 6 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "durable" &&
    segments[3] === "child-watchers" &&
    ["detach", "reattach", "close"].includes(segments[5] ?? "") &&
    index === 4;
  return isBackgroundTaskControl || isDirectWatcherControl;
}

function decodePathSafely(value: string): string | undefined {
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) {
        return current;
      }
      current = next;
    } catch {
      return undefined;
    }
  }
  return current;
}

function startsWithSuspiciousWindowsPrefix(value: string): boolean {
  return (
    value.startsWith("\\\\") ||
    value.startsWith("//") ||
    value.startsWith("\\\\?\\") ||
    value.startsWith("\\\\.\\") ||
    /^[a-z]:[\\/]/i.test(value) ||
    /^\/[a-z]:[\\/]/i.test(value)
  );
}

function hasNtfsAlternateDataStream(segment: string): boolean {
  if (/^[a-z]:$/i.test(segment)) {
    return false;
  }
  const colonIndex = segment.indexOf(":");
  return colonIndex > 0;
}

function isWindowsReservedDeviceSegment(segment: string): boolean {
  const normalized = segment
    .replace(/[. ]+$/g, "")
    .split(":", 1)[0]
    ?.trim()
    .toUpperCase();
  return normalized !== undefined && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/.test(normalized);
}
