/* eslint-disable max-lines -- Route metadata intentionally centralizes the release surface contract. */
export type PrimaryArea = "chat" | "cowork" | "code" | "projects" | "library" | "ops" | "settings";
export type CoworkSection = "workspace" | "tasks" | "board";
export type LibrarySection =
  | "agents"
  | "skills"
  | "capabilities"
  | "memory"
  | "knowledge"
  | "notes"
  | "communications"
  | "files"
  | "artifacts"
  | "prompt-packs"
  | "curator"
  | "citadel"
  | "citadel-overview"
  | "citadel-wards"
  | "citadel-council"
  | "citadel-blueprint";
export type OpsSection =
  | "activity"
  | "sessions"
  | "schedules"
  | "improvement"
  | "notifications"
  | "approvals"
  | "costs"
  | "quality"
  | "runtime"
  | "diagnostics"
  | "kanban";
export type SettingsSection =
  | "general"
  | "providers"
  | "personalities"
  | "access"
  | "permissions"
  | "budget"
  | "onboarding"
  | "runtime"
  | "local-ai"
  | "workspaces"
  | "addons"
  | "integrations"
  | "channels"
  | "mcp"
  | "tools"
  | "trust-policy";
export type ReleaseSurfaceStatus = "ship" | "hide" | "experimental" | "needs_release_polish";

export interface AppRoute {
  area: PrimaryArea;
  section?: CoworkSection | LibrarySection | OpsSection | SettingsSection;
  view?: string;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  artifactId?: string;
  approvalId?: string;
  projectId?: string;
  theme?: string;
}

export interface AreaMeta {
  id: PrimaryArea;
  label: string;
  description: string;
  kicker: string;
}

export interface RailItem {
  id: string;
  label: string;
  description: string;
  area: PrimaryArea;
  section?: AppRoute["section"];
  preserveThread?: boolean;
}

export interface RouteReleaseScope {
  area: PrimaryArea;
  section: "root" | CoworkSection | LibrarySection | OpsSection | SettingsSection;
  status: ReleaseSurfaceStatus;
  releaseAction: string;
  verification: string;
  note: string;
}

type RouteReleaseKeyInput = {
  area: PrimaryArea;
  section?: RouteReleaseScope["section"] | AppRoute["section"];
};

export const AREA_META: Record<PrimaryArea, AreaMeta> = {
  chat: {
    id: "chat",
    label: "Chat",
    kicker: "Conversation",
    description: "Conversation, search, attachments, and quick help.",
  },
  cowork: {
    id: "cowork",
    label: "Cowork",
    kicker: "Orchestration",
    description: "Delegation, tasks, checkpoints, and shared execution.",
  },
  code: {
    id: "code",
    label: "Code",
    kicker: "Implementation",
    description: "Workbench, files, diffs, runs, and code-mode control.",
  },
  projects: {
    id: "projects",
    label: "Projects",
    kicker: "Containers",
    description: "Project containers with Chat, Cowork, and Code threads grouped together.",
  },
  library: {
    id: "library",
    label: "Library",
    kicker: "Knowledge",
    description: "Agents, skills, capabilities, knowledge, memory, files, artifacts, and prompt packs.",
  },
  ops: {
    id: "ops",
    label: "Ops",
    kicker: "Operations",
    description: "Approvals, activity, spend, runtime, and diagnostics.",
  },
  settings: {
    id: "settings",
    label: "Settings",
    kicker: "Configuration",
    description: "Providers, runtimes, workspaces, integrations, and policy.",
  },
};

export const RAIL_ITEMS: Record<PrimaryArea, RailItem[]> = {
  chat: [
    {
      id: "chat-thread",
      label: "Thread",
      description: "Conversation with artifacts and attachments close at hand.",
      area: "chat",
      preserveThread: true,
    },
    {
      id: "chat-artifacts",
      label: "Artifacts",
      description: "Jump to generated outputs from active work.",
      area: "library",
      section: "artifacts",
      preserveThread: true,
    },
    {
      id: "chat-memory",
      label: "Memory",
      description: "Inspect what the system knows and what it learned.",
      area: "library",
      section: "memory",
    },
    {
      id: "chat-approvals",
      label: "Approvals",
      description: "Review pending tool or risk decisions.",
      area: "ops",
      section: "approvals",
    },
  ],
  cowork: [
    {
      id: "cowork-workspace",
      label: "Workspace",
      description: "Delegation-first surface for multi-step work.",
      area: "cowork",
      section: "workspace",
      preserveThread: true,
    },
    {
      id: "cowork-tasks",
      label: "Task Board",
      description: "Move between planning, assigned, review, blocked, and done.",
      area: "cowork",
      section: "tasks",
    },
    {
      id: "cowork-board",
      label: "Agent Board",
      description: "See agent posture and live board state.",
      area: "cowork",
      section: "board",
    },
    {
      id: "cowork-approvals",
      label: "Approvals",
      description: "Surface risky checkpoints where the operator expects them.",
      area: "ops",
      section: "approvals",
    },
  ],
  code: [
    {
      id: "code-workbench",
      label: "Workbench",
      description: "Implementation help with file actions, diffs, and candidates.",
      area: "code",
      preserveThread: true,
    },
    {
      id: "code-files",
      label: "Files",
      description: "Browse shared workspace files outside the active thread.",
      area: "library",
      section: "files",
    },
    {
      id: "code-runtime",
      label: "Runtime",
      description: "Keep serving posture and spend visible while coding.",
      area: "ops",
      section: "runtime",
    },
    {
      id: "code-approvals",
      label: "Approvals",
      description: "Review Code Mode and tool decisions from the coding lane.",
      area: "ops",
      section: "approvals",
      preserveThread: true,
    },
    {
      id: "code-prompt-packs",
      label: "Prompt Packs",
      description: "Jump into quality gates and pack authoring.",
      area: "library",
      section: "prompt-packs",
    },
  ],
  projects: [
    {
      id: "projects-list",
      label: "Projects",
      description: "Browse project containers and their cross-surface threads.",
      area: "projects",
    },
  ],
  library: [
    {
      id: "library-agents",
      label: "Agents",
      description: "Reusable agent profiles and catalog controls.",
      area: "library",
      section: "agents",
    },
    {
      id: "library-skills",
      label: "Skills",
      description: "Curate reusable behavior and activation posture.",
      area: "library",
      section: "skills",
    },
    {
      id: "library-capabilities",
      label: "Capabilities",
      description: "See what skills, tools, providers, MCP entries, and channels are available or degraded.",
      area: "library",
      section: "capabilities",
    },
    {
      id: "library-memory",
      label: "Memory",
      description: "Maintain durable memory items and lifecycle policy.",
      area: "library",
      section: "memory",
    },
    {
      id: "library-knowledge",
      label: "Knowledge",
      description: "Knowledge ingest and retrieval as attachable context.",
      area: "library",
      section: "knowledge",
    },
    {
      id: "library-notes",
      label: "Notes",
      description: "Business notes, checklists, reminders, and follow-ups.",
      area: "library",
      section: "notes",
    },
    {
      id: "library-communications",
      label: "Communications",
      description: "Inbox, calendar agenda, contacts, and approval-gated drafts.",
      area: "library",
      section: "communications",
    },
    {
      id: "library-files",
      label: "Files",
      description: "Browse uploaded and workspace files outside Code.",
      area: "library",
      section: "files",
    },
    {
      id: "library-artifacts",
      label: "Artifacts",
      description: "Reopen generated outputs from Chat, Cowork, and Code.",
      area: "library",
      section: "artifacts",
    },
    {
      id: "library-prompt-packs",
      label: "Prompt Packs",
      description: "Author, export, benchmark, review prompt packs, and inspect model comparisons.",
      area: "library",
      section: "prompt-packs",
    },
    {
      id: "library-curator",
      label: "Skill Curator",
      description: "Review ranked skill health, immunity flags, and archive proposals.",
      area: "library",
      section: "curator",
    },
  ],
  ops: [
    {
      id: "ops-activity",
      label: "Activity",
      description: "Realtime event feed and retained operational signal.",
      area: "ops",
      section: "activity",
    },
    {
      id: "ops-sessions",
      label: "Sessions",
      description: "Session timelines, summaries, and operator evidence.",
      area: "ops",
      section: "sessions",
    },
    {
      id: "ops-schedules",
      label: "Schedules",
      description: "Cron posture and scheduler review queue.",
      area: "ops",
      section: "schedules",
    },
    {
      id: "ops-improvement",
      label: "Improvement",
      description: "Replay and improvement loops.",
      area: "ops",
      section: "improvement",
    },
    {
      id: "ops-notifications",
      label: "Notifications",
      description: "Runtime issues, self-repair proposals, and operator follow-up.",
      area: "ops",
      section: "notifications",
    },
    {
      id: "ops-approvals",
      label: "Approvals",
      description: "Decision inbox, replay, and approval history.",
      area: "ops",
      section: "approvals",
    },
    {
      id: "ops-costs",
      label: "Costs",
      description: "Spend visibility without a dashboard maze.",
      area: "ops",
      section: "costs",
    },
    {
      id: "ops-quality",
      label: "Quality",
      description: "Eval proof, prompt-pack gates, and export posture.",
      area: "ops",
      section: "quality",
    },
    {
      id: "ops-runtime",
      label: "Runtime",
      description: "Gateway health, daemon posture, host vitals, and backups.",
      area: "ops",
      section: "runtime",
    },
    {
      id: "ops-diagnostics",
      label: "Diagnostics",
      description: "Durable, daemon, admin, docs, and readiness diagnostics.",
      area: "ops",
      section: "diagnostics",
    },
    {
      id: "ops-kanban",
      label: "Kanban",
      description: "Multi-agent board with distress signals, retry budgets, and bulk operator controls.",
      area: "ops",
      section: "kanban",
    },
  ],
  settings: [
    {
      id: "settings-general",
      label: "General",
      description: "Base defaults every other surface inherits.",
      area: "settings",
      section: "general",
    },
    {
      id: "settings-onboarding",
      label: "Start Here",
      description: "Safe demo, first-run readiness, setup center, and sharing checkpoints.",
      area: "settings",
      section: "onboarding",
    },
    {
      id: "settings-providers",
      label: "Providers & Models",
      description: "Provider credentials, model catalogs, and active routing defaults.",
      area: "settings",
      section: "providers",
    },
    {
      id: "settings-personalities",
      label: "Personalities",
      description: "Chat personality presets and the global Chat default.",
      area: "settings",
      section: "personalities",
    },
    {
      id: "settings-access",
      label: "Access",
      description: "Auth posture, secrets, and access boundaries.",
      area: "settings",
      section: "access",
    },
    {
      id: "settings-permissions",
      label: "Permissions",
      description: "Permission profiles, active defaults, and local operator override evidence.",
      area: "settings",
      section: "permissions",
    },
    {
      id: "settings-trust-policy",
      label: "Trust & Policy",
      description: "Unified dashboard for capability, tool, and source trust posture.",
      area: "settings",
      section: "trust-policy",
    },
    {
      id: "settings-runtime",
      label: "Runtime",
      description: "Mesh, local runtimes, backups, and serving posture.",
      area: "settings",
      section: "runtime",
    },
    {
      id: "settings-local-ai",
      label: "Local AI",
      description: "Hardware readiness, model fit, local endpoints, and serve jobs.",
      area: "settings",
      section: "local-ai",
    },
    {
      id: "settings-workspaces",
      label: "Workspaces",
      description: "Workspace context, guidance, and extension posture.",
      area: "settings",
      section: "workspaces",
    },
    {
      id: "settings-integrations",
      label: "Integrations",
      description: "Connections, connectors, and integration overview.",
      area: "settings",
      section: "integrations",
    },
    {
      id: "settings-channels",
      label: "Channels",
      description: "Comms and delivery setup.",
      area: "settings",
      section: "channels",
    },
    {
      id: "settings-mcp",
      label: "MCP",
      description: "MCP server posture, templates, and transport configuration.",
      area: "settings",
      section: "mcp",
    },
    {
      id: "settings-tools",
      label: "Tools",
      description: "Low-level tool catalog and scoped allow/deny grants.",
      area: "settings",
      section: "tools",
    },
    {
      id: "settings-addons",
      label: "Add-ons",
      description: "Installed extensions and workspace add-on posture.",
      area: "settings",
      section: "addons",
    },
    {
      id: "settings-budget",
      label: "Budget",
      description: "Set budget mode and review cost evidence.",
      area: "settings",
      section: "budget",
    },
  ],
};

export const ROUTE_RELEASE_SCOPE = [
  {
    area: "chat",
    section: "root",
    status: "ship",
    releaseAction: "Send a normal Chat turn and inspect model/tool/runtime context when present.",
    verification: "verify:surface:regression, verify:runtime:truth",
    note: "Core conversational lane remains release-bearing.",
  },
  {
    area: "cowork",
    section: "workspace",
    status: "ship",
    releaseAction: "Start or resume a durable Cowork run, then inspect blockers, approvals, and evidence.",
    verification: "verify:surface:regression, verify:durable:recovery, verify:runtime:truth",
    note: "Flagship durable flow is release-bearing with next-action, blocker, approval, and evidence truth visible.",
  },
  {
    area: "cowork",
    section: "tasks",
    status: "ship",
    releaseAction: "Review task state, blocked work, and deliverables from the Cowork lane.",
    verification: "verify:surface:regression",
    note: "Task board is release-bearing for continuation, deliverable, and blocker review.",
  },
  {
    area: "cowork",
    section: "board",
    status: "ship",
    releaseAction: "Inspect agent posture and delegation board state.",
    verification: "verify:surface:regression",
    note: "Agent board is release-bearing as an inspectable posture surface and does not claim autonomous live-control parity.",
  },
  {
    area: "code",
    section: "root",
    status: "ship",
    releaseAction: "Bind a code source, edit files, run validation, inspect diffs, and review Code Mode proof.",
    verification: "verify:surface:regression, verify:code:workbench-loop, verify:code-mode:sandbox",
    note: "Code workbench is release-bearing with source binding, validation/diff review, and governed Code Mode proof truth.",
  },
  {
    area: "projects",
    section: "root",
    status: "ship",
    releaseAction: "Select a project and continue related Chat, Cowork, or Code work.",
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
    status: "experimental",
    releaseAction:
      "Stage a Citadel with the Mason and review the drafted Blueprint without connecting accounts or opening Gates.",
    verification: "verify:surface:regression label check",
    note: "The Mason and Citadel staging remain experimental until activation, Vault crypto, and Gate enforcement are release-proven.",
  },
  {
    area: "library",
    section: "citadel-overview",
    status: "experimental",
    releaseAction:
      "Inspect how the active workspace is governed as a Citadel — Charter, Chambers, and Gatehouse posture.",
    verification: "verify:surface:regression label check",
    note: "Citadel overview is read-only and experimental until Gate enforcement and Vault crypto are release-proven.",
  },
  {
    area: "library",
    section: "citadel-wards",
    status: "experimental",
    releaseAction: "List, add, and test Gatehouse Wards (deny-wins) without treating them as enforced on the request path.",
    verification: "verify:surface:regression label check",
    note: "Wards are authored and evaluated here but remain experimental until threaded into the policy engine for live enforcement.",
  },
  {
    area: "library",
    section: "citadel-council",
    status: "experimental",
    releaseAction: "Inspect the agents seated in the Citadel by reference to the existing agents catalog.",
    verification: "verify:surface:regression label check",
    note: "Council seating is read-only and experimental until per-seat grant ceilings are enforced by the policy engine.",
  },
  {
    area: "library",
    section: "citadel-blueprint",
    status: "experimental",
    releaseAction: "Export the active Citadel as a secret-free Blueprint, or validate and import one.",
    verification: "verify:surface:regression label check",
    note: "Blueprint import/export is experimental; imports are schema-checked and secret-scanned but staging never activates connections.",
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
      "Follow Start Here readiness through provider/local path, first Chat/Cowork/Code task, evidence, and Run Detail steps.",
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
    releaseAction: "Inspect add-on posture without implying a full marketplace/install lifecycle.",
    verification: "verify:surface:regression label check",
    note: "Add-ons stay experimental until permission grants, durable logs, rollback, and marketplace boundaries are proven.",
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
    section: "tools",
    status: "ship",
    releaseAction: "Inspect low-level tool catalog and scoped allow/deny grants.",
    verification: "verify:surface:regression, verify:agentic:governance",
    note: "Tool grants and deny-wins policy are release-bearing.",
  },
] as const satisfies readonly RouteReleaseScope[];

const ROUTE_RELEASE_SCOPE_BY_KEY = new Map(ROUTE_RELEASE_SCOPE.map((scope) => [getRouteReleaseKey(scope), scope]));

export function normalizeAppRoute(route: AppRoute): AppRoute {
  const base = {
    area: route.area,
    sessionId: route.sessionId,
    turnId: route.turnId,
    runId: route.runId,
    artifactId: route.artifactId,
    approvalId: route.approvalId,
    projectId: route.projectId,
    theme: route.theme,
    view: route.view,
  };

  if (route.area === "cowork") {
    return {
      ...base,
      area: "cowork",
      section: (route.section as CoworkSection | undefined) ?? "workspace",
    };
  }
  if (route.area === "library") {
    return {
      ...base,
      area: "library",
      section: (route.section as LibrarySection | undefined) ?? "agents",
    };
  }
  if (route.area === "ops") {
    return {
      ...base,
      area: "ops",
      section: (route.section as OpsSection | undefined) ?? "activity",
    };
  }
  if (route.area === "settings") {
    return {
      ...base,
      area: "settings",
      section: (route.section as SettingsSection | undefined) ?? "general",
    };
  }
  return {
    ...base,
    area: route.area,
  };
}

export function parseAppRoute(input: string | URL): AppRoute {
  const url = typeof input === "string" ? new URL(input, "http://goatcitadel.local") : input;
  const rawParts = url.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const parts = rawParts.map((part) => part.toLowerCase());
  const params = url.searchParams;
  const area = (parts[0] as PrimaryArea | undefined) ?? "chat";
  const normalizedArea = isPrimaryArea(area) ? area : "chat";
  const routeArea = normalizedArea;
  const routeSection = area === "settings" && parts[1] === "safety" ? "permissions" : parts[1];
  const nextRoute: AppRoute = normalizeAppRoute({
    area: routeArea,
    section: routeArea === "projects" ? undefined : (routeSection as AppRoute["section"]),
    sessionId: readParam(params, "sessionId"),
    turnId: readParam(params, "turnId"),
    runId: readParam(params, "runId"),
    artifactId: readParam(params, "artifactId"),
    approvalId: readParam(params, "approvalId"),
    projectId:
      area === "projects"
        ? safeDecodePathSegment(rawParts[1]) || readParam(params, "projectId")
        : readParam(params, "projectId"),
    theme: readParam(params, "theme"),
    view: readParam(params, "view"),
  });
  return nextRoute;
}

export function buildAppHref(route: AppRoute): string {
  const next = normalizeAppRoute(route);
  const params = new URLSearchParams();
  writeParam(params, "sessionId", next.sessionId);
  writeParam(params, "turnId", next.turnId);
  writeParam(params, "runId", next.runId);
  writeParam(params, "artifactId", next.artifactId);
  writeParam(params, "approvalId", next.approvalId);
  if (next.area !== "projects") {
    writeParam(params, "projectId", next.projectId);
  }
  writeParam(params, "view", next.view);
  // theme is a global localStorage preference, not per-URL state (see 819ef761f); do not serialize it into hrefs.

  const path =
    next.area === "chat" || next.area === "code"
      ? `/${next.area}`
      : next.area === "projects"
        ? `/projects${next.projectId ? `/${encodeURIComponent(next.projectId)}` : ""}`
        : next.area === "cowork" && (!next.section || next.section === "workspace")
          ? "/cowork"
          : `/${next.area}/${next.section ?? ""}`;

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function getRouteLabel(route: AppRoute): string {
  const next = normalizeAppRoute(route);
  if (next.area === "chat" || next.area === "code" || next.area === "projects") {
    return AREA_META[next.area].label;
  }
  if (next.area === "cowork") {
    return next.section === "tasks" ? "Task Board" : next.section === "board" ? "Agent Board" : "Cowork";
  }

  const item = RAIL_ITEMS[next.area].find((entry) => entry.section === next.section);
  return item?.label ?? AREA_META[next.area].label;
}

export function getRouteDescription(route: AppRoute): string {
  const next = normalizeAppRoute(route);
  if (next.area === "chat" || next.area === "code" || next.area === "projects") {
    return AREA_META[next.area].description;
  }
  if (next.area === "cowork") {
    if (next.section === "tasks") {
      return "Tasks, activities, deliverables, and blockers stay inside the Cowork lane instead of floating as a separate product.";
    }
    if (next.section === "board") {
      return "The board exposes live agent posture without forcing agent catalog chrome over active work.";
    }
    return AREA_META.cowork.description;
  }
  return (
    RAIL_ITEMS[next.area].find((entry) => entry.section === next.section)?.description ??
    AREA_META[next.area].description
  );
}

export function getRouteReleaseKey(route: RouteReleaseKeyInput): string {
  const section =
    route.area === "chat" || route.area === "code" || route.area === "projects"
      ? "root"
      : ((route.section as RouteReleaseScope["section"] | undefined) ?? defaultSectionForArea(route.area));
  return `${route.area}/${section}`;
}

export function getRouteReleaseScope(route: AppRoute): RouteReleaseScope {
  const key = getRouteReleaseKey(normalizeAppRoute(route));
  return (
    ROUTE_RELEASE_SCOPE_BY_KEY.get(key) ?? {
      area: route.area,
      section: "root",
      status: "hide",
      releaseAction: "Route is not part of the current visible release surface.",
      verification: "not release-bearing",
      note: "Missing route-scope metadata fails closed as hidden.",
    }
  );
}

/**
 * True when a route is flagged `experimental` in ROUTE_RELEASE_SCOPE. Used to
 * keep experimental surfaces out of the primary navigation rails while leaving
 * them fully reachable via direct URL, the command palette, and their
 * "Experimental" stage badge.
 */
export function isExperimentalRoute(route: { area: PrimaryArea; section?: AppRoute["section"] }): boolean {
  return ROUTE_RELEASE_SCOPE_BY_KEY.get(getRouteReleaseKey(route))?.status === "experimental";
}

export function describeReleaseSurfaceStatus(status: ReleaseSurfaceStatus): string {
  if (status === "ship") {
    return "Release-ready";
  }
  if (status === "needs_release_polish") {
    return "Needs release polish";
  }
  if (status === "experimental") {
    return "Experimental";
  }
  return "Hidden";
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

export function isReleaseSurfaceReady(status: ReleaseSurfaceStatus): boolean {
  return status === "ship";
}

export function buildNavigationTarget(current: AppRoute, item: RailItem): AppRoute {
  const preserveThread = item.preserveThread ?? false;
  return normalizeAppRoute({
    area: item.area,
    section: item.section,
    sessionId: preserveThread ? current.sessionId : undefined,
    turnId: preserveThread ? current.turnId : undefined,
    runId: preserveThread ? current.runId : undefined,
    artifactId: preserveThread ? current.artifactId : undefined,
    approvalId: preserveThread ? current.approvalId : undefined,
    projectId: item.area === "projects" ? current.projectId : undefined,
    theme: current.theme,
    view:
      item.area === "library" && item.section === "agents" && current.area === "library" && current.view === "catalog"
        ? current.view
        : undefined,
  });
}

export function isRailItemActive(route: AppRoute, item: RailItem): boolean {
  const next = normalizeAppRoute(route);
  if (item.area !== next.area) {
    return false;
  }
  if (!item.section) {
    return true;
  }
  return item.section === next.section;
}

function defaultSectionForArea(area: PrimaryArea): RouteReleaseScope["section"] {
  if (area === "cowork") {
    return "workspace";
  }
  if (area === "library") {
    return "agents";
  }
  if (area === "ops") {
    return "activity";
  }
  if (area === "settings") {
    return "general";
  }
  return "root";
}

function isPrimaryArea(value: string | undefined): value is PrimaryArea {
  return (
    value === "chat" ||
    value === "cowork" ||
    value === "code" ||
    value === "projects" ||
    value === "library" ||
    value === "ops" ||
    value === "settings"
  );
}

function readParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value ? value : undefined;
}

function safeDecodePathSegment(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function writeParam(params: URLSearchParams, key: string, value?: string): void {
  if (value?.trim()) {
    params.set(key, value.trim());
  }
}
