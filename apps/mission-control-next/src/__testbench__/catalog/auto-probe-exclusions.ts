export interface AutoProbeExclusion {
  readonly pattern: RegExp;
  readonly reason: string;
}

/** GET routes that must never be auto-probed. Each stays uncovered until a hand-written check claims it. */
export const AUTO_PROBE_EXCLUSIONS: readonly AutoProbeExclusion[] = [
  { pattern: /\/stream(\/|$)/, reason: "Streams events; hand-written realtime checks cover streams." },
  { pattern: /\/(export|download|archive)(\/|$)/, reason: "Downloads a potentially large payload." },
  { pattern: /^\/api\/v1\/docs$/, reason: "Serves the HTML API reference, not JSON." },
  {
    pattern: /^\/api\/v1\/llm\/models$/,
    reason: "Queries the provider's remote model catalog; the external catalog check covers it.",
  },
  {
    pattern: /^\/api\/v1\/dev\//,
    reason: "Development verification endpoints are exercised by journeys, not auto-probes.",
  },
];

/** Areas whose reads may reach the network. On the real gateway, auto-probes skip them until reviewed. */
export const REAL_TARGET_NETWORK_DOMAINS: ReadonlySet<string> = new Set([
  "a2a",
  "addons",
  "channels",
  "comms",
  "integrations",
  "llm",
  "mcp",
  "mesh",
  "voice",
]);

export function findExclusion(url: string): AutoProbeExclusion | undefined {
  return AUTO_PROBE_EXCLUSIONS.find((exclusion) => exclusion.pattern.test(url));
}
