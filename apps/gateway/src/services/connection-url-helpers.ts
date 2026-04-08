export function isConnectionValueLocalUrl(urlValue: string | undefined): boolean {
  if (!urlValue) {
    return false;
  }
  try {
    const url = new URL(urlValue);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

export function isConnectionUrlRemoteSafe(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    if (url.protocol === "https:") {
      return true;
    }
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

export function isHostAllowlistedInList(hostname: string, allowlist: string[]): boolean {
  const normalizedHost = hostname.trim().toLowerCase();
  const normalizedAllowlist = allowlist.map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (normalizedAllowlist.length === 0) {
    return false;
  }
  return normalizedAllowlist.some((allowed) => {
    if (allowed === "*" || allowed === normalizedHost) {
      return true;
    }
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(1);
      return normalizedHost.endsWith(suffix);
    }
    return false;
  });
}

export function isUrlAllowlistedInList(urlValue: string, allowlist: string[]): boolean {
  try {
    const url = new URL(urlValue);
    return isHostAllowlistedInList(url.host, allowlist) || isHostAllowlistedInList(url.hostname, allowlist);
  } catch {
    return false;
  }
}

export function tryParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
