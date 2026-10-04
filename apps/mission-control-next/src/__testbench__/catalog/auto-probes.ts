import { request } from "@goatcitadel/mission-control-shared/api/client-core";
import { pass, summarizeEvidence } from "../runner/assert";
import { domainOfUrl, toRouteKey, type RouteManifest } from "../runner/routes";
import type { CheckDef, RouteKey } from "../runner/types";
import type { TargetKind } from "../gateway-target/resolve-target";
import { REAL_TARGET_NETWORK_DOMAINS, findExclusion } from "./auto-probe-exclusions";

export function buildAutoProbes(
  manifest: RouteManifest,
  handWritten: readonly CheckDef[],
  target: TargetKind,
): CheckDef[] {
  const claimed = new Set(handWritten.flatMap((check) => check.routes));
  const probes = new Map<RouteKey, CheckDef>();
  for (const entry of manifest.items) {
    if (!entry.tracked || entry.method.toUpperCase() !== "GET" || entry.url.includes(":")) {
      continue;
    }
    const key = toRouteKey(entry.method, entry.url);
    const domain = domainOfUrl(entry.url);
    const skipped =
      !key ||
      entry.accessClass === "sse-read" ||
      claimed.has(key) ||
      probes.has(key) ||
      findExclusion(entry.url) !== undefined ||
      (target === "real" && REAL_TARGET_NETWORK_DOMAINS.has(domain));
    if (key && !skipped) {
      probes.set(key, createAutoProbe(key, entry.url, domain));
    }
  }
  return [...probes.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function createAutoProbe(key: RouteKey, url: string, domain: string): CheckDef {
  return {
    id: `auto:${key}`,
    kind: "auto",
    domain,
    title: url.replace(/^\/api\/v1\//, ""),
    tier: "read",
    routes: [key],
    description: "Generated from the route list: the route must answer 2xx with JSON.",
    async run(ctx) {
      const body = await request<unknown>(url, { signal: ctx.signal });
      return body === undefined
        ? pass("Answered with no content.")
        : pass("Answered with JSON.", summarizeEvidence(body));
    },
  };
}
