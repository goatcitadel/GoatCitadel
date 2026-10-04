import type { CheckDef, HttpMethod, RouteKey } from "./types";

export interface RouteManifestEntry {
  readonly method: string;
  readonly url: string;
  readonly accessClass?: string;
  readonly classificationSource?: string;
  readonly tracked: boolean;
}

export interface RouteManifest {
  readonly items: readonly RouteManifestEntry[];
}

export interface StaleClaim {
  readonly checkId: string;
  readonly route: RouteKey;
}

export interface CoverageReport {
  readonly total: number;
  readonly covered: number;
  readonly uncovered: readonly RouteKey[];
  readonly staleClaims: readonly StaleClaim[];
}

const HTTP_METHODS: ReadonlySet<string> = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ROUTE_KEY_PATTERN = /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/;

export function isRouteKey(value: string): value is RouteKey {
  return ROUTE_KEY_PATTERN.test(value);
}

export function toRouteKey(method: string, url: string): RouteKey | undefined {
  const upper = method.toUpperCase();
  if (!HTTP_METHODS.has(upper)) {
    return undefined;
  }
  const key = `${upper} ${url}`;
  return isRouteKey(key) ? key : undefined;
}

export function splitRouteKey(key: RouteKey): { readonly method: HttpMethod; readonly url: string } {
  const space = key.indexOf(" ");
  return { method: key.slice(0, space) as HttpMethod, url: key.slice(space + 1) };
}

export function trackedRouteKeys(manifest: RouteManifest): RouteKey[] {
  const keys = new Set<RouteKey>();
  for (const entry of manifest.items) {
    const key = entry.tracked ? toRouteKey(entry.method, entry.url) : undefined;
    if (key) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

export function domainOfUrl(url: string): string {
  const segments = url.split("/").filter((segment) => segment !== "");
  if (segments[0] === "api" && segments[1] === "v1") {
    return segments[2] ?? "api";
  }
  return segments[0] ?? "root";
}

export function computeCoverage(
  manifestKeys: readonly RouteKey[] | undefined,
  checks: readonly Pick<CheckDef, "id" | "routes">[],
): CoverageReport | undefined {
  if (!manifestKeys) {
    return undefined;
  }
  const known = new Set(manifestKeys);
  const claimed = new Set<RouteKey>();
  const staleClaims: StaleClaim[] = [];
  for (const check of checks) {
    for (const route of check.routes) {
      if (known.has(route)) {
        claimed.add(route);
      } else if (splitRouteKey(route).url.startsWith("/api/v1/")) {
        staleClaims.push({ checkId: check.id, route });
      }
    }
  }
  return {
    total: manifestKeys.length,
    covered: claimed.size,
    uncovered: manifestKeys.filter((key) => !claimed.has(key)),
    staleClaims,
  };
}
