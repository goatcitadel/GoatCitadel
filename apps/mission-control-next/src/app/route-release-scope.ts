import { getRouteReleaseKey, normalizeAppRoute, describeReleaseSurfaceStatus } from "./route-release-kernel";
import type { AppRoute, RouteReleaseScope, ReleaseSurfaceStatus } from "./route-model";

export const ROUTE_RELEASE_SCOPE: readonly RouteReleaseScope[] = [
  {
    area: "chat",
    section: "root",
    status: "ship",
    releaseAction:
      "Send a Chat turn and inspect model, tool, approval, memory, runtime, artifact, and code-capability context when present.",
    verification: "verify:surface:regression, verify:runtime:truth",
    note: "Chat is the only release-bearing conversation surface.",
  },
  {
    area: "cowork",
    section: "workspace",
    status: "hide",
    releaseAction: "Redirect legacy planning workspace links into Chat.",
    verification: "route-model tests; not release-bearing as a visible surface",
    note: "Planning and orchestration remain Chat capabilities rather than a separate operator surface.",
  },
  {
    area: "cowork",
    section: "tasks",
    status: "hide",
    releaseAction: "Redirect legacy task-board links to Ops Kanban.",
    verification: "route-model tests; Ops Kanban proof lane",
    note: "Task state is operational detail, not a separate planning surface.",
  },
  {
    area: "cowork",
    section: "board",
    status: "hide",
    releaseAction: "Redirect legacy agent-board links to Ops Kanban.",
    verification: "route-model tests; Ops Kanban proof lane",
    note: "Agent posture is operational detail, not a separate planning surface.",
  },
  {
    area: "code",
    section: "root",
    status: "hide",
    releaseAction: "Redirect legacy Code links into Chat.",
    verification: "route-model tests, verify:code-mode:sandbox",
    note: "Code Mode remains a governed trusted-code capability, not a visible Code surface.",
  },
  {
    area: "projects",
    section: "root",
    status: "ship",
    releaseAction: "Select a project and continue related conversation, planning, or build work.",
    verification: "verify:surface:regression",
    note: "Projects is release-bearing as the home base for cross-surface continuation.",
  },
  {
    area: "library",
    section: "agents",
    status: "ship",
    releaseAction: "Inspect reusable agent profiles and catalog controls.",
    verification: "verify:surface:regression",
    note: "Agent catalog is a visible Library route with operator navigation.",
  },
  {
    area: "library",
    section: "skills",
    status: "ship",
    releaseAction: "Review skill activation posture and lifecycle evidence.",
    verification: "verify:surface:regression, verify:agentic:proof",
    note: "Skills are release-bearing when trust/provenance stays visible.",
  },
  {
    area: "library",
    section: "capabilities",
    status: "ship",
    releaseAction: "Inspect capability availability, degraded posture, and callable/inspectable truth.",
    verification: "verify:surface:regression, verify:catalog:parity",
    note: "Capability truth remains part of the release surface.",
  },
  {
    area: "library",
    section: "memory",
    status: "ship",
    releaseAction: "Inspect, edit, forget, and audit memory lifecycle state through MemoryLifecycleService.",
    verification: "verify:surface:regression, verify:memory:truth",
    note: "Memory lifecycle is release-bearing through MemoryLifecycleService ownership and operator provenance.",
  },
  {
    area: "library",
    section: "journey",
    status: "experimental",
    releaseAction:
      "Inspect currently captured learning, memory, approval, effect, and Skill Hub lifecycle evidence without mutation.",
    verification: "verify:surface:regression, focused Journey route and service tests",
    note: "Canonical producers cover skill learning, candidate governance, memory, approvals and effects, plus Skill Hub lifecycle events including rollback and revoke; import and cross-surface coverage remain experimental.",
  },
  {
    area: "library",
    section: "knowledge",
    status: "ship",
    releaseAction: "Inspect knowledge sources and attachable context with source visibility.",
    verification: "verify:surface:regression",
    note: "Knowledge is release-bearing when source visibility and attachable context provenance remain visible.",
  },
  {
    area: "library",
    section: "notes",
    status: "ship",
    releaseAction: "Capture notes and reminders with workspace scoping and operator-visible state.",
    verification: "verify:surface:regression, focused personal-ops route tests",
    note: "Notes are release-bearing as personal business context, separate from durable learned memory.",
  },
  {
    area: "library",
    section: "communications",
    status: "ship",
    releaseAction: "Inspect inbox, agenda, contacts, and approval-gated mail drafts.",
    verification: "verify:surface:regression, focused communications route tests",
    note: "Communications is release-bearing only through governed integrations and approval-gated outbound effects.",
  },
  {
    area: "library",
    section: "files",
    status: "ship",
    releaseAction: "Browse uploaded and workspace files from the Library lane.",
    verification: "verify:surface:regression",
    note: "File browsing is release-bearing as an inspectable support surface.",
  },
  {
    area: "library",
    section: "artifacts",
    status: "ship",
    releaseAction: "Reopen generated artifacts and inspect linked run/source evidence.",
    verification: "verify:surface:regression",
    note: "Artifacts are release-bearing when linked run, source, and decision provenance is inspectable.",
  },
  {
    area: "library",
    section: "prompt-packs",
    status: "ship",
    releaseAction: "Author, export, benchmark, review prompt packs, and inspect model comparison judgments.",
    verification: "verify:surface:regression, prompt:gates",
    note: "Prompt-pack workflows remain release-bearing, including operator-visible model comparison review.",
  },
  {
    area: "library",
    section: "curator",
    status: "experimental",
    releaseAction:
      "Review skill health proposals without treating archive recommendations as final release automation.",
    verification: "verify:surface:regression label check",
    note: "Curator remains visible as experimental operator assistance.",
  },
  {
    area: "library",
    section: "citadel",
    status: "ship",
    releaseAction:
      "Stage a Citadel with the Mason and review the drafted Blueprint before connecting accounts or opening Gates.",
    verification: "verify:surface:regression",
    note: "The Mason and Citadel staging are release-bearing for drafting and review; staging never activates connections or opens Gates on its own.",
  },
  {
    area: "library",
    section: "citadel-overview",
    status: "ship",
    releaseAction:
      "Inspect and update the active Citadel Charter, review Chambers and Gatehouse posture, and explicitly archive or restore the Citadel.",
    verification: "verify:surface:regression",
    note: "Citadel overview is release-bearing for Charter purpose edits and explicit identity lifecycle actions; Chamber and Gatehouse posture remain inspectable here.",
  },
  {
    area: "library",
    section: "citadel-wards",
    status: "ship",
    releaseAction: "List, add, and test Gatehouse Wards (deny-wins) for the active Citadel.",
    verification: "verify:surface:regression, verify:agentic:governance",
    note: "Wards are release-bearing for authoring, evaluation, and live request-path enforcement: the gateway resolves the parent Citadel from the workspace on every tool invoke, so a matching Ward always enforces (deny-wins).",
  },
  {
    area: "library",
    section: "citadel-council",
    status: "ship",
    releaseAction: "Inspect, seat, and remove agents in the Citadel by reference to the existing agents catalog.",
    verification: "verify:surface:regression",
    note: "Council seating and removal are release-bearing reference mutations; per-seat grant-ceiling enforcement is a tracked follow-on.",
  },
  {
    area: "library",
    section: "citadel-blueprint",
    status: "ship",
    releaseAction: "Export the active Citadel as a secret-free Blueprint, or validate and import one.",
    verification: "verify:surface:regression",
    note: "Blueprint import/export is release-bearing; imports are schema-checked and secret-scanned, and staging never activates connections.",
  },
  {
    area: "library",
    section: "citadel-vault",
    status: "ship",
    releaseAction: "Store, reveal, and delete Citadel secrets sealed at rest under a per-Citadel keychain key.",
    verification: "verify:surface:regression, verify:auth:matrix",
    note: "Vault is release-bearing for sealed per-Citadel secret storage and fails closed when the keychain is unavailable; per-Chamber keys and rotation are the tracked follow-on.",
  },
  {
    area: "ops",
    section: "boards",
    status: "ship",
    releaseAction: "Create, select, edit, archive, and restore trusted layouts built from compiled Ops summaries.",
    verification: "focused HX-410 Mission Control tests, verify:surface:regression",
    note: "Saved boards are layout-only projections; every widget reloads its canonical source and never becomes runtime authority.",
  },
  {
    area: "ops",
    section: "activity",
    status: "ship",
    releaseAction: "Inspect realtime and retained operational events.",
    verification: "verify:surface:regression, verify:realtime:truth",
    note: "Activity is release-bearing as retained event inspection feeding the Ops attention queue.",
  },
  {
    area: "ops",
    section: "sessions",
    status: "ship",
    releaseAction: "Inspect session timelines, summaries, and operator evidence.",
    verification: "verify:surface:regression",
    note: "Sessions are release-bearing evidence navigation.",
  },
  {
    area: "ops",
    section: "schedules",
    status: "ship",
    releaseAction: "Review scheduler posture and create governed recurring work.",
    verification: "verify:surface:regression",
    note: "Schedules is release-bearing with governed recurring-work review and primary actions visible.",
  },
  {
    area: "ops",
    section: "workers",
    status: "hide",
    releaseAction:
      "Inspect the read-only remote-worker registry, assignments, events, and reconciliation once live HX-501/HX-502/HX-504 authority is composed.",
    verification: "remote-workers route + service proof; verify:surface:regression (fixture-seeded)",
    note: "HX-507 remote-worker visibility is architecture-ship but implementation-hold pending live worker authority, so it is not counted in the visible release surface until the live data gate opens.",
  },
  {
    area: "ops",
    section: "improvement",
    status: "experimental",
    releaseAction: "Inspect improvement loops as experimental replay/self-improvement support.",
    verification: "verify:surface:regression label check",
    note: "Improvement remains visible but must not be described as autonomous release magic.",
  },
  {
    area: "ops",
    section: "notifications",
    status: "ship",
    releaseAction: "Review runtime issues, self-repair proposals, and follow-up signals.",
    verification: "verify:surface:regression",
    note: "Notifications is release-bearing as the Ops exception and follow-up review surface.",
  },
  {
    area: "ops",
    section: "approvals",
    status: "ship",
    releaseAction: "Review pending decisions, replay effects, and approval history.",
    verification: "verify:surface:regression, verify:auth:matrix",
    note: "Approval governance is release-bearing.",
  },
  {
    area: "ops",
    section: "costs",
    status: "ship",
    releaseAction: "Inspect spend visibility and cost evidence.",
    verification: "verify:surface:regression",
    note: "Cost visibility remains part of release trust.",
  },
  {
    area: "ops",
    section: "quality",
    status: "ship",
    releaseAction: "Inspect eval proof, prompt-pack gate posture, and read-only trace/report export paths.",
    verification: "verify:surface:regression, prompt:gates",
    note: "Quality is release-bearing as an evidence dashboard and does not replace prompt-pack review or named verification lanes.",
  },
  {
    area: "ops",
    section: "runtime",
    status: "ship",
    releaseAction: "Inspect gateway health, daemon posture, host vitals, and backup state.",
    verification: "verify:surface:regression, verify:runtime:truth",
    note: "Runtime truth is release-bearing.",
  },
  {
    area: "ops",
    section: "diagnostics",
    status: "ship",
    releaseAction: "Inspect durable, daemon, admin, docs, and readiness diagnostics.",
    verification: "verify:surface:regression, docs:check",
    note: "Diagnostics stay available behind drill-in surfaces.",
  },
  {
    area: "ops",
    section: "kanban",
    status: "experimental",
    releaseAction: "Inspect multi-agent board posture without treating bulk controls as final release control.",
    verification: "verify:surface:regression label check",
    note: "Kanban remains visible as experimental multi-agent operations.",
  },
  {
    area: "settings",
    section: "general",
    status: "ship",
    releaseAction: "Configure base defaults inherited by operator surfaces.",
    verification: "verify:surface:regression",
    note: "General settings are release-bearing.",
  },
  {
    area: "settings",
    section: "providers",
    status: "ship",
    releaseAction: "Configure provider credentials and run provider/model smoke evidence.",
    verification: "verify:surface:regression, provider exercise paths",
    note: "Provider setup is release-bearing with smoke evidence, model discovery state, and plain failure copy.",
  },
  {
    area: "settings",
    section: "personalities",
    status: "experimental",
    releaseAction: "Adjust personality presets without treating them as a release-critical runtime guarantee.",
    verification: "verify:surface:regression label check",
    note: "Personalities remain experimental polish around Chat defaults.",
  },
  {
    area: "settings",
    section: "access",
    status: "ship",
    releaseAction: "Inspect auth posture, device trust, desktop/mobile continuity, and access boundaries.",
    verification: "verify:surface:regression, verify:auth:matrix",
    note: "Access, secret truth, device grants, and desktop/mobile continuity are release-bearing.",
  },
  {
    area: "settings",
    section: "permissions",
    status: "ship",
    releaseAction: "Configure permission profiles and local operator override evidence.",
    verification: "verify:surface:regression, verify:agentic:governance",
    note: "Permission governance is release-bearing.",
  },
  {
    area: "settings",
    section: "trust-policy",
    status: "ship",
    releaseAction:
      "Inspect the unified Trust & Policy matrix, then jump to Permissions, Tools, MCP, Skills, Capabilities, or Approvals for edits.",
    verification: "verify:surface:regression, verify:agentic:governance",
    note: "Trust & Policy is a dashboard-only release surface and fails closed when the snapshot API is unavailable.",
  },
  {
    area: "settings",
    section: "budget",
    status: "ship",
    releaseAction: "Set budget mode and review cost evidence.",
    verification: "verify:surface:regression",
    note: "Budget controls are release-bearing trust controls.",
  },
  {
    area: "settings",
    section: "onboarding",
    status: "ship",
    releaseAction:
      "Follow Start Here readiness through provider/local path, first Chat task, evidence, and Run Detail steps.",
    verification: "verify:install, verify:surface:regression",
    note: "Start Here is release-bearing as the first-run checklist through setup, first work, proof artifact, and run evidence.",
  },
  {
    area: "settings",
    section: "runtime",
    status: "ship",
    releaseAction: "Configure mesh, local runtimes, backups, and serving posture.",
    verification: "verify:surface:regression, verify:runtime:truth",
    note: "Runtime settings are release-bearing when experimental sidecars stay labeled.",
  },
  {
    area: "settings",
    section: "local-ai",
    status: "ship",
    releaseAction: "Inspect local hardware readiness, model-fit recommendations, and approval-gated local model jobs.",
    verification: "verify:surface:regression, verify:runtime:truth",
    note: "Local AI remains honest about advisory fit and does not claim autonomous installs or mature local inference.",
  },
  {
    area: "settings",
    section: "workspaces",
    status: "ship",
    releaseAction: "Configure workspace context, guidance, and extension posture.",
    verification: "verify:surface:regression",
    note: "Workspace controls remain release-bearing.",
  },
  {
    area: "settings",
    section: "addons",
    status: "experimental",
    releaseAction: "Preview bundled capability packs without implying a full marketplace/install lifecycle.",
    verification: "verify:surface:regression label check",
    note: "Capability packs stay experimental until plugins replace them.",
  },
  {
    area: "settings",
    section: "integrations",
    status: "ship",
    releaseAction: "Review connector status and open real setup/action paths where supported.",
    verification: "verify:surface:regression, verify:catalog:parity",
    note: "Integrations is release-bearing when each connector exposes a setup/action path or explicit blocked state.",
  },
  {
    area: "settings",
    section: "channels",
    status: "ship",
    releaseAction: "Run guided channel setup with live-auth or live-send diagnostics where supported.",
    verification: "verify:surface:regression, channel setup tests",
    note: "Channels is release-bearing with guided setup, live diagnostics where supported, and blocked copy otherwise.",
  },
  {
    area: "settings",
    section: "mcp",
    status: "ship",
    releaseAction:
      "Configure local stdio, Approval Inbox, and governed remote http/sse MCP paths with supported auth readiness.",
    verification: "verify:surface:regression, mcp visibility tests",
    note: "MCP is release-bearing for local stdio, Approval Inbox, and governed remote http/sse truth; OAuth records fail closed as needs_auth when token refs are missing or expired.",
  },
  {
    area: "settings",
    section: "web-search",
    status: "ship",
    releaseAction:
      "Configure Firecrawl (hosted or self-hosted), the native search engine order, and keychain-held Firecrawl, Brave, and Parallel keys.",
    verification: "WebSearchSettings tests, gateway web-search credential and settings tests",
    note: "Web & Search saves through the governed settings path; keys are live-checked and stored only in the OS keychain, with environment variables as the fallback.",
  },
  {
    area: "settings",
    section: "tools",
    status: "ship",
    releaseAction: "Inspect low-level tool catalog and scoped allow/deny grants.",
    verification: "verify:surface:regression, verify:agentic:governance",
    note: "Tool grants and deny-wins policy are release-bearing.",
  },
  {
    area: "settings",
    section: "hooks",
    status: "ship",
    releaseAction: "Configure governed lifecycle hooks and inspect durable delivery evidence.",
    verification: "verify:hooks, verify:surface:regression, verify:runtime:truth",
    note: "Hooks remain Gateway-governed: network allowlists, approvals, payload scope, and policy cannot be bypassed.",
  },
  {
    area: "settings",
    section: "workspace-capabilities",
    status: "hide",
    releaseAction: "Choose which skills, integrations, and MCP servers this workspace uses.",
    verification: "not release-bearing; gateway capability-scope suite",
    note: "Workspace capability scoping is not yet part of the certified 1.0 release surface: MCP scope is enforced at invocation, but agent-side skill-discovery scoping and visual-regression coverage are tracked follow-ups.",
  },
  {
    area: "settings",
    section: "citadel-capabilities",
    status: "hide",
    releaseAction: "Govern which skills, integrations, and MCP servers exist in this Citadel.",
    verification: "not release-bearing; gateway capability-scope suite",
    note: "Citadel capability ownership is not yet part of the certified 1.0 release surface; pending agent-side skill enforcement and visual-regression baselines.",
  },
];

let releaseScopesByKey: Map<string, RouteReleaseScope> | undefined;

function readReleaseScope(key: string): RouteReleaseScope | undefined {
  releaseScopesByKey ??= new Map(ROUTE_RELEASE_SCOPE.map((scope) => [getRouteReleaseKey(scope), scope]));
  return releaseScopesByKey.get(key);
}

/** Raw-key compact adapter over the same cached live canonical public row. */
export function readRouteReleaseStatus(key: string): ReleaseSurfaceStatus | undefined {
  return readReleaseScope(key)?.status;
}

export function getRouteReleaseScope(route: AppRoute): RouteReleaseScope {
  const normalized = normalizeAppRoute(route);
  const releaseRoute = normalized;
  const key = getRouteReleaseKey(releaseRoute);
  return (
    readReleaseScope(key) ?? {
      area: releaseRoute.area,
      section: "root",
      status: "hide",
      releaseAction: "Route is not part of the current visible release surface.",
      verification: "not release-bearing",
      note: "Missing route-scope metadata fails closed as hidden.",
    }
  );
}

export function describeReleaseScopeForOperator(scope: RouteReleaseScope): string {
  const status = describeReleaseSurfaceStatus(scope.status);
  const action = trimTerminalPunctuation(scope.releaseAction);
  const verification = trimTerminalPunctuation(scope.verification);
  return `${status}. Action: ${action}. Verification: ${verification}. Constraint: ${scope.note}`;
}

function trimTerminalPunctuation(value: string): string {
  return value.replace(/[.;:\s]+$/u, "");
}
