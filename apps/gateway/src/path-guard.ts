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
  return segments.some((segment) => hasNtfsAlternateDataStream(segment) || isWindowsReservedDeviceSegment(segment));
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
