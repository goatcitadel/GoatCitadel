/* eslint-disable max-lines -- Route metadata intentionally centralizes the release surface contract. */
import type { ChatMode } from "@goatcitadel/contracts";

export type PrimaryArea = "chat" | "cowork" | "code" | "projects" | "library" | "ops" | "settings";
export type CoworkSection = "workspace" | "tasks" | "board";
export type LibrarySection =
  | "agents"
  | "skills"
  | "capabilities"
  | "memory"
  | "journey"
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
  | "citadel-blueprint"
  | "citadel-vault";
export type OpsSection =
  | "boards"
  | "activity"
  | "sessions"
  | "schedules"
  | "workers"
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
  | "hooks"
  | "trust-policy"
  | "workspace-capabilities"
  | "citadel-capabilities";
export type ReleaseSurfaceStatus = "ship" | "hide" | "experimental" | "needs_release_polish";

export interface AppRoute {
  area: PrimaryArea;
  mode?: ChatMode; // unified-surface conversation mode (chat area only)
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
    label: "Work",
    kicker: "Conversation",
    description: "One chat workspace for planning, building, search, attachments, approvals, and quick help.",
  },
  cowork: {
    id: "cowork",
    label: "Chat",
    kicker: "Legacy",
    description: "Legacy planning links now open Chat or the Ops board.",
  },
  code: {
    id: "code",
    label: "Chat",
    kicker: "Legacy",
    description: "Legacy Code links now open Chat with governed code capabilities available inside the conversation.",
  },
  projects: {
    id: "projects",
    label: "Projects",
    kicker: "Containers",
    description: "Project containers with conversation, planning, and build threads grouped together.",
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
      label: "Conversation",
      description: "Active work thread with artifacts and attachments close at hand.",
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
      description: "Review Code Mode and tool decisions from the build lane.",
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
    {
      id: "projects-citadels",
      label: "Citadels",
      description: "Govern personal, company, and project context with Charter, Chambers, and Gatehouse posture.",
      area: "library",
      section: "citadel-overview",
    },
    {
      id: "projects-artifacts",
      label: "Artifacts",
      description: "Reopen generated outputs tied to project work.",
      area: "library",
      section: "artifacts",
    },
    {
      id: "projects-sessions",
      label: "Sessions",
      description: "Review retained project runs, timelines, and evidence.",
      area: "ops",
      section: "sessions",
    },
    {
      id: "projects-memory",
      label: "Memory",
      description: "Inspect reusable context and provenance before continuing work.",
      area: "library",
      section: "memory",
    },
  ],
  library: [
    {
      id: "library-citadel-overview",
      label: "Overview",
      description: "See the active Citadel Charter, Chambers, and Gatehouse posture.",
      area: "library",
      section: "citadel-overview",
    },
    {
      id: "library-citadel",
      label: "Mason",
      description: "Stage Personal or Company Citadels before connecting accounts or opening Gates.",
      area: "library",
      section: "citadel",
    },
    {
      id: "library-citadel-wards",
      label: "Wards",
      description: "List, add, and test deny-wins Gatehouse Wards.",
      area: "library",
      section: "citadel-wards",
    },
    {
      id: "library-citadel-council",
      label: "Council",
      description: "Inspect agents seated in the Citadel from the agents catalog.",
      area: "library",
      section: "citadel-council",
    },
    {
      id: "library-citadel-vault",
      label: "Vault",
      description: "Store, reveal, and delete sealed Citadel secrets.",
      area: "library",
      section: "citadel-vault",
    },
    {
      id: "library-citadel-blueprint",
      label: "Blueprint",
      description: "Export a secret-free Blueprint, or validate and import one.",
      area: "library",
      section: "citadel-blueprint",
    },
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
      id: "library-journey",
      label: "Journey",
      description: "Inspect experimental read-only skill-learning and candidate evidence.",
      area: "library",
      section: "journey",
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
      description: "Browse uploaded and workspace files outside Build.",
      area: "library",
      section: "files",
    },
    {
      id: "library-artifacts",
      label: "Artifacts",
      description: "Reopen generated outputs from conversation, planning, and build work.",
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
      id: "ops-boards",
      label: "Boards",
      description: "Trusted saved layouts composed from canonical Ops summaries.",
      area: "ops",
      section: "boards",
    },
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
      id: "ops-workers",
      label: "Workers",
      description: "Operator-visible remote-worker registry, assignments, events, and reconciliation.",
      area: "ops",
      section: "workers",
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
      description: "Conversation personality presets and the global conversation default.",
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
      id: "settings-hooks",
      label: "Hooks",
      description: "Governed lifecycle hooks, delivery posture, and evidence.",
      area: "settings",
      section: "hooks",
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
    {
      id: "settings-workspace-capabilities",
      label: "Workspace capabilities",
      description: "Choose which skills, plugins, and MCP servers this workspace uses.",
      area: "settings",
      section: "workspace-capabilities",
    },
    {
      id: "settings-citadel-capabilities",
      label: "Citadel capabilities",
      description: "Govern which skills, plugins, and MCP servers exist in this Citadel.",
      area: "settings",
      section: "citadel-capabilities",
    },
  ],
};

const MODE_RAIL_THREAD: RailItem = {
  id: "chat-thread",
  label: "Conversation",
  description: "The active work thread with artifacts and attachments close at hand.",
  area: "chat",
  preserveThread: true,
};
const MODE_RAIL_APPROVALS: RailItem = {
  id: "chat-approvals",
  label: "Approvals",
  description: "Review pending tool or risk decisions.",
  area: "ops",
  section: "approvals",
  preserveThread: true,
};

/** Chat rail for the single conversation surface. Legacy mode values are ignored. */
export function buildModeRail(mode: ChatMode | undefined): RailItem[] {
  void mode;
  return [
    MODE_RAIL_THREAD,
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
    MODE_RAIL_APPROVALS,
  ];
}

export interface RailGroup {
  id: string;
  label: string;
  sections: NonNullable<AppRoute["section"]>[];
}

/**
 * Single source of truth for rail grouping. Drives both the nav rail
 * (buildRailSections) and breadcrumb derivation (routeKicker), so the two can
 * never disagree. Areas absent here render as one ungrouped rail. Sections
 * intentionally omitted from every group stay reachable via deep link but are
 * not surfaced in grouped navigation. Release-bearing trust/setup settings stay
 * grouped so operators can find them without command search.
 */
export const RAIL_GROUPS: Partial<Record<PrimaryArea, RailGroup[]>> = {
  settings: [
    {
      id: "settings-foundations",
      label: "Foundations",
      sections: ["general", "onboarding", "workspaces", "workspace-capabilities"],
    },
    {
      id: "settings-identity",
      label: "Identity",
      sections: [
        "access",
        "permissions",
        "personalities",
        "providers",
        "local-ai",
        "trust-policy",
        "citadel-capabilities",
      ],
    },
    { id: "settings-surfaces", label: "Surfaces", sections: ["channels", "integrations", "mcp", "tools", "hooks"] },
    { id: "settings-operations", label: "Operations", sections: ["runtime", "addons", "budget"] },
  ],
  library: [
    {
      id: "library-citadels",
      label: "Citadels",
      sections: [
        "citadel-overview",
        "citadel",
        "citadel-wards",
        "citadel-council",
        "citadel-vault",
        "citadel-blueprint",
      ],
    },
    {
      id: "library-knowledge",
      label: "Knowledge",
      sections: ["agents", "skills", "capabilities", "memory", "journey", "knowledge", "notes"],
    },
    {
      id: "library-assets",
      label: "Assets",
      sections: ["files", "artifacts", "communications", "prompt-packs", "curator"],
    },
  ],
  ops: [
    { id: "ops-observe", label: "Observe", sections: ["boards", "activity", "sessions", "schedules", "workers"] },
    {
      id: "ops-control",
      label: "Operate",
      sections: ["improvement", "notifications", "approvals", "costs", "quality", "runtime", "diagnostics", "kanban"],
    },
  ],
};

/** The rail group a section belongs to, or undefined when ungrouped. */
export function railGroupForSection(area: PrimaryArea, section: AppRoute["section"]): RailGroup | undefined {
  if (!section) {
    return undefined;
  }
  return RAIL_GROUPS[area]?.find((group) => group.sections.includes(section));
}

/**
 * Derives a page's breadcrumb kicker from the route registry so it always
 * matches the nav rail: "Area · [Group ·] Section", with the section name taken
 * verbatim from the rail item label. Grouped sections render three levels;
 * ungrouped sections render two. Falls back to the area label for root/unknown.
 */
export function routeKicker(route: AppRoute): string {
  const normalized = normalizeAppRoute(route);
  const areaLabel = AREA_META[normalized.area].label;
  const section = normalized.section;
  if (!section) {
    return areaLabel;
  }
  const sectionLabel = RAIL_ITEMS[normalized.area]?.find((item) => item.section === section)?.label;
  if (!sectionLabel) {
    return areaLabel;
  }
  const group = railGroupForSection(normalized.area, section);
  // Collapse to "Area · Section" when the section's name equals its group's (e.g.
  // the Knowledge section inside the Knowledge group) to avoid a redundant
  // "Library · Knowledge · Knowledge".
  if (group && group.label.toLowerCase() !== sectionLabel.toLowerCase()) {
    return `${areaLabel} · ${group.label} · ${sectionLabel}`;
  }
  return `${areaLabel} · ${sectionLabel}`;
}

export const ROUTE_RELEASE_SCOPE = [
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
    note: "Personalities remain experimental polish around Work defaults.",
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
      "Follow Start Here readiness through provider/local path, first Work task, evidence, and Run Detail steps.",
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
    releaseAction: "Choose which skills, plugins, and MCP servers this workspace uses.",
    verification: "not release-bearing; gateway capability-scope suite",
    note: "Workspace capability scoping is not yet part of the certified 1.0 release surface: MCP scope is enforced at invocation, but agent-side skill-discovery scoping and visual-regression coverage are tracked follow-ups.",
  },
  {
    area: "settings",
    section: "citadel-capabilities",
    status: "hide",
    releaseAction: "Govern which skills, plugins, and MCP servers exist in this Citadel.",
    verification: "not release-bearing; gateway capability-scope suite",
    note: "Citadel capability ownership is not yet part of the certified 1.0 release surface; pending agent-side skill enforcement and visual-regression baselines.",
  },
] as const satisfies readonly RouteReleaseScope[];

const ROUTE_RELEASE_SCOPE_BY_KEY = new Map(ROUTE_RELEASE_SCOPE.map((scope) => [getRouteReleaseKey(scope), scope]));

export function normalizeAppRoute(route: AppRoute): AppRoute {
  if (route.area === "code") {
    return normalizeAppRoute({ ...route, area: "chat", mode: undefined, section: undefined });
  }
  if (route.area === "cowork") {
    if (route.section === "tasks" || route.section === "board") {
      return normalizeAppRoute({ ...route, area: "ops", section: "kanban", mode: undefined });
    }
    return normalizeAppRoute({ ...route, area: "chat", mode: undefined, section: undefined });
  }

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
    mode: route.area === "chat" && route.mode === "chat" ? "chat" : undefined,
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
  const rawMode = readParam(params, "mode");
  const parsedMode = rawMode === "chat" ? "chat" : undefined;
  const nextRoute: AppRoute = normalizeAppRoute({
    area: routeArea,
    section: routeArea === "projects" ? undefined : (routeSection as AppRoute["section"]),
    mode: parsedMode,
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
  // Chat is the only operator conversation surface; legacy mode params are not serialized.

  const path =
    next.area === "chat"
      ? "/chat"
      : next.area === "projects"
        ? `/projects${next.projectId ? `/${encodeURIComponent(next.projectId)}` : ""}`
        : `/${next.area}/${next.section ?? ""}`;

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function getRouteLabel(route: AppRoute): string {
  const next = normalizeAppRoute(route);
  if (next.area === "chat") {
    return AREA_META.chat.label;
  }
  if (next.area === "projects") {
    return AREA_META[next.area].label;
  }

  const item = RAIL_ITEMS[next.area].find((entry) => entry.section === next.section);
  return item?.label ?? AREA_META[next.area].label;
}

export function getRouteDescription(route: AppRoute): string {
  const next = normalizeAppRoute(route);
  if (next.area === "chat") {
    return AREA_META.chat.description;
  }
  if (next.area === "projects") {
    return AREA_META[next.area].description;
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
  const normalized = normalizeAppRoute(route);
  const releaseRoute = normalized;
  const key = getRouteReleaseKey(releaseRoute);
  return (
    ROUTE_RELEASE_SCOPE_BY_KEY.get(key) ?? {
      area: releaseRoute.area,
      section: "root",
      status: "hide",
      releaseAction: "Route is not part of the current visible release surface.",
      verification: "not release-bearing",
      note: "Missing route-scope metadata fails closed as hidden.",
    }
  );
}

/**
 * True when a route is flagged `experimental` in ROUTE_RELEASE_SCOPE. Most
 * experimental surfaces stay out of the primary navigation rails while
 * remaining reachable via direct URL, the command palette, and their
 * "Experimental" stage badge.
 */
export function isExperimentalRoute(route: { area: PrimaryArea; section?: AppRoute["section"] }): boolean {
  return ROUTE_RELEASE_SCOPE_BY_KEY.get(getRouteReleaseKey(route))?.status === "experimental";
}

/**
 * Primary-rail visibility is release-aware, with a narrow discoverability
 * exception for the personality catalog. Personalities remain explicitly
 * experimental on-surface, but hiding the only catalog leaves first-time users
 * with no way to inspect what is available before choosing a preset.
 */
export function isPrimaryRailRoute(route: { area: PrimaryArea; section?: AppRoute["section"] }): boolean {
  if (isHiddenRoute(route)) {
    return false;
  }
  if (!isExperimentalRoute(route)) {
    return true;
  }
  return route.area === "settings" && route.section === "personalities";
}

/**
 * True when a route is intentionally direct-URL-only. Hidden routes remain
 * routable for compatibility and verification, but must not leak into primary
 * navigation or command-palette discovery.
 */
export function isHiddenRoute(route: { area: PrimaryArea; section?: AppRoute["section"] }): boolean {
  return (ROUTE_RELEASE_SCOPE_BY_KEY.get(getRouteReleaseKey(route))?.status ?? "hide") === "hide";
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
  return "Direct URL only";
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
    mode: item.area === "chat" ? current.mode : undefined,
    sessionId: preserveThread ? current.sessionId : undefined,
    turnId: preserveThread ? current.turnId : undefined,
    runId: preserveThread ? current.runId : undefined,
    artifactId: preserveThread ? current.artifactId : undefined,
    approvalId: preserveThread ? current.approvalId : undefined,
    projectId: preserveThread || item.area === "projects" ? current.projectId : undefined,
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
