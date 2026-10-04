export interface AutoProbeExclusion {
  readonly pattern: RegExp;
  readonly reason: string;
}

/** Anchored exact-route pattern, so `/api/v1/skills/sources` never also matches a longer URL. */
function exactRoute(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);
}

function excludeRoutes(reason: string, urls: readonly string[]): AutoProbeExclusion[] {
  return urls.map((url) => ({ pattern: exactRoute(url), reason }));
}

/**
 * GET routes that must never be auto-probed, on either target. Each stays uncovered until a hand-written check
 * claims it. Read-tier probes run on the operator's real gateway too, so a probed read must stay on the machine,
 * start no process, change no state, and answer 2xx without a query string.
 */
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

  // Reaches beyond the machine.
  ...excludeRoutes("Searches remote skill marketplaces (agentskill.sh, skillsmp.com).", ["/api/v1/skills/sources"]),
  ...excludeRoutes("Requires the q query parameter and looks it up on remote skill marketplaces.", [
    "/api/v1/skills/lookup",
  ]),
  ...excludeRoutes("Reads Gmail and Calendar through connected accounts, which reaches the network.", [
    "/api/v1/communications",
  ]),
  ...excludeRoutes("Falls back to querying the configured llama.cpp server URL, which may be a remote host.", [
    "/api/v1/llamacpp/models",
  ]),
  ...excludeRoutes("Requires the code and state query parameters and exchanges the code with Slack.", [
    "/api/v1/integrations/slack/oauth/callback",
  ]),

  // Starts a process or changes state on every read.
  ...excludeRoutes("Refreshes the llama.cpp runtime on every read: persists its state and publishes an event.", [
    "/api/v1/llamacpp/status",
  ]),
  ...excludeRoutes("Refreshes the llama.cpp runtime and runs its binary to read the version.", [
    "/api/v1/llamacpp/setup",
  ]),
  ...excludeRoutes("Runs the llama.cpp binary to read its version.", ["/api/v1/llamacpp/install"]),
  ...excludeRoutes("Runs where/which and each local runtime's version command (ollama, llama-server, vllm, sglang).", [
    "/api/v1/local-ai/readiness",
  ]),
  ...excludeRoutes("Spawns where/which child processes to find agent harness executables.", [
    "/api/v1/agentic/availability",
  ]),
  ...excludeRoutes("Spawns git child processes to read the branch and commit.", ["/api/v1/review/readiness"]),
  ...excludeRoutes("Spawns git child processes to read the build identity.", ["/api/v1/review/identity"]),

  // Answers 4xx without the query parameter it requires.
  ...excludeRoutes("Requires the workspaceId query parameter.", [
    "/api/v1/chat/sessions/recents",
    "/api/v1/chat/document-patch-proposals",
    "/api/v1/engineering-learnings",
    "/api/v1/engineering-learnings/context",
    "/api/v1/library/external-sources",
    "/api/v1/inbox",
    "/api/v1/journey/events",
    "/api/v1/ops/boards",
    "/api/v1/ops/runtime-authority",
    "/api/v1/ops/workspace-path-bridges",
    "/api/v1/skills/hub",
    "/api/v1/work-passport/baseline",
  ]),
  ...excludeRoutes("Requires the query parameter for the search text.", ["/api/v1/chat/session-search"]),
  ...excludeRoutes("Requires the sessionId query parameter.", ["/api/v1/chat/tools/approvals"]),
  ...excludeRoutes("Requires the relativePath query parameter.", ["/api/v1/files/preview"]),
  ...excludeRoutes("Requires the path query parameter.", ["/api/v1/integrations/obsidian/note"]),
  ...excludeRoutes("Requires the skillId query parameter.", ["/api/v1/skills/by-id/evaluations"]),
  ...excludeRoutes("Requires one of the sessionId, turnId, runId, approvalId, or taskId query parameters.", [
    "/api/v1/runtime/lifecycle",
  ]),
  ...excludeRoutes("Answers a bare 409, not a recognised feature-disabled shape, while its flag is off (default).", [
    "/api/v1/cron/review-queue",
  ]),

  // Needs a credential an operator-token probe does not carry.
  ...excludeRoutes("Needs a companion-authenticated session; operator calls are refused.", [
    "/api/v1/auth/companion/session",
  ]),
  ...excludeRoutes("Needs A2A peer authentication; operator calls are refused.", ["/api/v1/a2a/extended-agent-card"]),
  ...excludeRoutes("Needs an admitted mesh-node identity; operator calls fail.", [
    "/api/v1/mesh/capabilities/manifests/self",
    "/api/v1/mesh/capabilities/invocations/pending",
  ]),
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
