import type { GlobalCopy, PageCopy, PageId, TabId } from "./copy-types";

interface NavItemCopy {
  id: TabId;
  label: string;
  code: string;
}

interface NavSectionCopy {
  label: string;
  items: TabId[];
}

export const globalCopy: GlobalCopy = {
  guideCard: {
    title: "Quick Guide",
    what: "What you can do here",
    when: "Best time to use this page",
    mostCommonAction: "Most common action",
    actions: "Try this first",
    terms: "Terms explained",
  },
  common: {
    save: "Save",
    cancel: "Cancel",
    archive: "Archive",
    restore: "Restore",
    deletePermanently: "Delete Permanently",
    apply: "Apply",
    test: "Test",
    loading: "Loading...",
    noPendingEdits: "No pending edits.",
  },
  selectOrCustom: {
    suggested: "Suggested",
    custom: "Custom",
    selectValue: "Select a value",
    customValueHint: "Current value is custom. Switch to Custom mode to edit it.",
    enterCustom: "Enter custom value",
  },
  commandPalette: {
    placeholder: "Type a page or action...",
  },
  configFormBuilder: {
    noSchema: "No guided schema is available for this connection yet. Use Advanced JSON if needed.",
    showAdvanced: "Show Advanced Fields",
    hideAdvanced: "Hide Advanced Fields",
    enabled: "enabled",
    envRefChip: "ENV Ref",
    customValue: "Custom value",
  },
  smartPathInput: {
    browse: "Browse",
    loadingSuggestions: "Loading path suggestions...",
    editedAfterAutofill: "Path edited after auto-fill.",
  },
};

export const appCopy = {
  brandTitle: "GoatCitadel",
  brandSubtitle: "Your AI operations home base",
  quickActionsButton: "Command Palette",
  nextStepTitle: "Start Here",
  streamBanner: "Live updates are {state}. GoatCitadel will reconnect automatically.",
  sidebar: {
    stream: "Stream",
    onboarding: "Onboarding",
    reconnects: "Reconnects",
    lastEvent: "Last event",
    mode: "Mode",
    localMode: "local herd",
    unknown: "unknown",
    complete: "complete",
    required: "required",
    notAvailable: "n/a",
  },
  navItems: [
    { id: "addons", label: "Add-ons", code: "ADD" },
    { id: "onboarding", label: "Launch Wizard", code: "NEW" },
    { id: "dashboard", label: "Work", code: "SUM" },
    { id: "system", label: "System", code: "ENG" },
    { id: "files", label: "Files", code: "FS" },
    { id: "memory", label: "Memory", code: "MEM" },
    { id: "agents", label: "Agents", code: "AGT" },
    { id: "office", label: "Office", code: "OFC" },
    { id: "officeLab", label: "Herd Lab", code: "LAB" },
    { id: "activity", label: "Activity", code: "ACT" },
    { id: "cron", label: "Scheduler", code: "CRN" },
    { id: "sessions", label: "Sessions", code: "SES" },
    { id: "chat", label: "Chat", code: "CHT" },
    { id: "assembly", label: "Cowork", code: "AOM" },
    { id: "promptLab", label: "Quality", code: "PLB" },
    { id: "improvement", label: "Improvement", code: "IMP" },
    { id: "skills", label: "Skills", code: "SKL" },
    { id: "costs", label: "Costs", code: "USD" },
    { id: "settings", label: "Settings", code: "CFG" },
    { id: "workspaces", label: "Workspace Control", code: "WSP" },
    { id: "tools", label: "Tool Access", code: "TLS" },
    { id: "approvals", label: "Approvals", code: "APR" },
    { id: "tasks", label: "Work Queue", code: "WRK" },
    { id: "integrations", label: "Integrations", code: "CNX" },
    { id: "mcp", label: "MCP Servers", code: "MCP" },
    { id: "mesh", label: "Mesh", code: "MSH" },
    { id: "npu", label: "Local Runtime", code: "NPU" },
  ] satisfies NavItemCopy[],
  navSections: [
    { label: "Configure", items: ["onboarding", "settings", "workspaces", "integrations", "tools", "addons"] },
    {
      label: "Work",
      items: [
        "dashboard",
        "chat",
        "assembly",
        "promptLab",
        "improvement",
        "tasks",
        "agents",
        "office",
        "officeLab",
        "approvals",
        "sessions",
      ],
    },
    { label: "Observe", items: ["activity", "system", "memory", "files", "costs", "mesh", "npu", "cron"] },
    { label: "Admin", items: ["skills", "mcp"] },
  ] satisfies NavSectionCopy[],
  nextStepByTab: {
    addons: "Install optional extras only after reviewing trust, source, and runtime notes.",
    onboarding: "Finish setup once, then move into Summit or Chat.",
    dashboard: "Start in Work when you want the fastest path into Chat, Cowork, or Code.",
    system: "If anything feels slow, check vitals here first.",
    files: "Create or update a file, then review path and risk hints before saving.",
    memory: "Use this when replies feel off-context or forgetful.",
    agents: "Configure crew roles so each agent has a clear job.",
    office: "Pick an agent station to see what it is doing right now.",
    officeLab: "Use Herd Lab to watch deck load, approvals, and live crew activity in the 2D operations view.",
    activity: "Keep this open while you test actions in other tabs.",
    cron: "Review scheduled jobs and confirm recent runs look healthy.",
    sessions: "Choose a session and inspect timeline, usage, and outcomes.",
    chat: "Pick a project, open a session, and send a message.",
    assembly: "Use Cowork when the task needs decomposition, orchestration, checkpoints, or multi-model debate.",
    promptLab: "Use Quality to run prompt tests, review regressions, and compare reliability over time.",
    improvement: "Review weekly replay findings, then apply or revert low-risk adjustments.",
    skills: "Decide which skills are always on, guarded, or off.",
    costs: "Review spend and switch to a lighter mode when needed.",
    settings: "Update providers and safety defaults in one place.",
    workspaces: "Select workspace context, then edit global or workspace guidance safely.",
    tools: "Grant only what you need; approval previews still require an operator before execution.",
    approvals: "Approve or reject risky actions waiting on you.",
    tasks: "Keep tasks organized and archive stale work as you go.",
    integrations: "Use guided setup first, then advanced JSON only if needed.",
    mcp: "Connect MCP servers, set trust level, then test safely.",
    mesh: "Check multi-node health before running distributed work.",
    npu: "NPU acceleration is retired from the shipped 1.0 runtime.",
  } as Record<TabId, string>,
};

export const pageCopy: Record<PageId, PageCopy> = {
  dashboard: {
    title: "Work",
    subtitle: "Choose the right mode for fast chat, structured orchestration, or focused implementation.",
    guide: {
      what: "Work is the main entry point into Chat, Cowork, and Code.",
      when: "Open this first when you want to choose the right mode before diving into the work.",
      actions: [
        "Jump into Chat for a fast answer or drafting loop.",
        "Switch to Cowork when the task needs orchestration, checkpoints, or multiple roles.",
        "Use Code when correctness, diffs, and validation matter most.",
      ],
      terms: [
        { term: "Chat", meaning: "Fast conversation and lightweight help." },
        { term: "Cowork", meaning: "Structured agentic work with visible workflow state." },
        { term: "Code", meaning: "Implementation-focused help with tighter engineering discipline." },
      ],
    },
  },
  addons: {
    title: "Add-ons",
    subtitle: "Optional extras that live outside the GoatCitadel core app checkout.",
    guide: {
      what: "Use Add-ons to review, install, update, and supervise optional extras like Arena without mixing them into the core GoatCitadel repo.",
      when: "Use this when you want something beyond the core agentic/control-plane feature set and you are comfortable reviewing a separate repository first.",
      actions: [
        "Review trust and provenance before every install.",
        "Install the add-on into the dedicated GoatCitadel add-ons root.",
        "Use readiness checks to confirm whether the add-on is display-ready and safe to open.",
      ],
      terms: [
        {
          term: "Same owner",
          meaning:
            "Configured metadata that says the add-on repository is published by the same owner as GoatCitadel. It is still separate code that you should review.",
        },
        {
          term: "Display-ready",
          meaning:
            "The add-on exposes a stable web entry path that GoatCitadel can open externally or embed. Arena currently uses an external local URL instead of an embedded surface.",
        },
      ],
    },
  },
  system: {
    title: "System",
    subtitle: "Machine and runtime health for this GoatCitadel node.",
    guide: {
      what: "Shows machine and process vitals so you can spot bottlenecks quickly.",
      when: "Use this when the system feels slow or unstable.",
      actions: [
        "Check memory and process usage.",
        "Watch CPU and load trends.",
        "Verify host uptime and platform details.",
      ],
    },
  },
  files: {
    title: "Files",
    subtitle: "Create and edit workspace files inside safe write limits.",
    guide: {
      what: "Trail Files is your safe workspace editor for notes, docs, reports, and other artifacts.",
      when: "Use this when you need direct file control without leaving Mission Control, especially for artifacts and workspace notes.",
      actions: [
        "Filter or browse Workspace Trails, then click a file to preview it.",
        "Use Selected Path to safely prefill where you want to save updates.",
        "Use Edit Selected File for text files, or image preview for image files.",
        "Create a new file from templates when you need a fast starting point.",
        "Review path risk and change-review hints before writing.",
      ],
      terms: [
        { term: "Artifact", meaning: "A useful output file like a report, brief, note, or release doc." },
        { term: "Write jail", meaning: "Allowed folders where file writes are permitted." },
        {
          term: "Trail preview",
          meaning: "Shows text directly, renders image files visually, and flags unsupported binary previews.",
        },
      ],
    },
  },
  memory: {
    title: "Memory",
    subtitle: "See what memory exists and how it is being used in replies.",
    guide: {
      what: "Shows what memory is available and how QMD context is being generated.",
      when: "Use this when answers lose context or memory quality drops.",
      actions: [
        "Inspect workspace memory files.",
        "Review QMD stats and recent packs.",
        "Compose a context pack for a test prompt.",
      ],
      terms: [
        { term: "QMD", meaning: "Query-time distilled memory used to keep prompts concise and relevant." },
        {
          term: "Context impact",
          meaning: "How much QMD reduced or expanded token usage versus the original context payload.",
        },
        {
          term: "Pinned memory",
          meaning: "Pinned items stay favored and are less likely to be forgotten automatically.",
        },
        { term: "TTL override", meaning: "Optional time-to-live override in seconds for a specific memory item." },
      ],
    },
  },
  agents: {
    title: "Agents",
    subtitle: "Manage built-in and custom agent roles for your workflows.",
    guide: {
      what: "This is your persistent agent roster for long-lived roles and responsibilities.",
      when: "Use this when adding a specialist, updating role descriptions, or cleaning unused roles.",
      actions: [
        "Create custom agent roles.",
        "Edit built-in display fields safely.",
        "Archive or restore roles as your workflow evolves.",
      ],
      terms: [
        { term: "Role ID", meaning: "Stable identity key for a role. Built-in Role IDs are immutable." },
        { term: "Archived", meaning: "Hidden from active views but still recoverable." },
      ],
    },
  },
  office: {
    title: "Office",
    subtitle: "Live floor view of what your agents are doing right now.",
    guide: {
      what: "Visual operations room for real-time agent activity and triage.",
      when: "Use this for live observability and quick agent-by-agent inspection.",
      actions: [
        "Select an agent station to inspect details.",
        "Review thought/action overlays.",
        "Track active and idle roles at a glance.",
      ],
    },
  },
  officeLab: {
    title: "Herd Lab",
    subtitle: "A separate 2D pixel-style office view mapped onto GoatCitadel decks and live agent activity.",
    guide: {
      what: "Herd Lab is the non-3D office surface: deck-based, pixel-inspired, and fed by the same live GoatCitadel runtime data.",
      when: "Use this when you want a clearer 2D operations floor instead of the immersive 3D office.",
      actions: [
        "Scan which deck is carrying live load or waiting on approvals.",
        "Pick an operator tile to inspect what that role is doing right now.",
        "Use the live rail to see event traffic without opening the full activity stream.",
      ],
      terms: [
        {
          term: "Deck",
          meaning: "A named citadel area like Command Deck or Build Bay that groups related agent roles.",
        },
        { term: "Live rail", meaning: "The recent event feed driving the office floor state and urgency indicators." },
      ],
    },
  },
  activity: {
    title: "Activity",
    subtitle: "Live event stream across gateway, tools, approvals, and workflows.",
    guide: {
      what: "Shows live events so you can verify system behavior while actions run.",
      when: "Use this while testing, debugging, or validating automation.",
      actions: [
        "Perform an action in another tab.",
        "Watch events appear in real time.",
        "Confirm expected order and payloads.",
      ],
    },
  },
  cron: {
    title: "Scheduler",
    subtitle: "Create, edit, run, and monitor recurring automation jobs.",
    guide: {
      what: "Manage scheduled jobs end-to-end, including run controls and job details.",
      when: "Use this when operating recurring automations in production-like environments.",
      actions: [
        "Create new jobs or edit existing schedules.",
        "Start, pause, run-now, or delete jobs directly.",
        "Review last/next run timing and update history.",
      ],
    },
  },
  sessions: {
    title: "Sessions",
    subtitle: "Session health, transcript timeline, and spend for active conversations.",
    guide: {
      what: "Summarizes current sessions and lets you inspect each session in detail.",
      when: "Use this to monitor conversation quality and investigate issues.",
      actions: [
        "Filter by health and search.",
        "Select a session from the list.",
        "Inspect summary and timeline details.",
      ],
      terms: [
        { term: "Session", meaning: "A routed conversation keyed by channel/account/peer or room/thread." },
        { term: "Timeline", meaning: "Chronological transcript events for the selected run." },
      ],
    },
  },
  chat: {
    title: "Chat",
    subtitle: "Your everyday chat hub for projects, files, and agent help.",
    guide: {
      what: "This is your daily chat surface for both mission and external sessions.",
      when: "Use this when you want a smooth chat flow with tool and safety controls.",
      actions: [
        "Click New Chat to start immediately, even if you never create a project.",
        "Create or select a project only when you want organization.",
        "Switch between sessions from the sidebar.",
        "Send messages with optional file attachments.",
      ],
      terms: [
        { term: "Mission session", meaning: "A local GoatCitadel chat session using configured model providers." },
        { term: "External session", meaning: "A routed chat that can write back to an integration target." },
        {
          term: "Writeback binding",
          meaning: "Connection + target mapping required before posting to external sessions.",
        },
        {
          term: "Learned memory confidence",
          meaning:
            "Estimate of how reliable a saved memory item is for future replies. It is not a completion percentage.",
        },
      ],
    },
  },
  assembly: {
    title: "Cowork",
    subtitle: "Run structured agentic workflows with visible stages, checkpoints, and deliberate model coordination.",
    guide: {
      what: "Cowork is the home for deeper agentic work: task decomposition, research + synthesis, model coordination, and checkpointed execution.",
      when: "Use this when the task deserves more than a simple chat loop and you want first-class orchestration instead of an ad hoc thread.",
      actions: [
        "Start with a concise problem statement and a domain preset.",
        "Pick a small but meaningfully diverse participant set when you need multi-model debate.",
        "Use checkpoints and approvals when the workflow needs human judgment between steps.",
        "Watch the stage timeline, then export the result to artifact, task, or chat when it is stable enough.",
      ],
      terms: [
        { term: "Blind review", meaning: "A proposal is reviewed by ID without exposing the author model." },
        {
          term: "Minority report",
          meaning:
            "A preserved dissent when the top options remain too close or a critical objection stays unresolved.",
        },
        {
          term: "Convergence",
          meaning:
            "A weighted measure of whether the models are aligning on cause, solution, risks, scope, and test plan.",
        },
      ],
    },
  },
  promptLab: {
    title: "Quality",
    subtitle: "Run prompt tests, spot weak replies quickly, and track regressions over time.",
    guide: {
      what: "Quality is the evaluation lane for prompt tests, benchmark runs, and regression review.",
      when: "Use this when tuning models, tools, or prompt policies against a fixed test set.",
      actions: [
        "Import markdown prompt packs with [TEST-##] blocks.",
        "Run one test, run next, or batch-run all tests.",
        "Score each run on the 0-2 rubric and review pass/fail clusters.",
      ],
      terms: [
        { term: "Pass threshold", meaning: "Default pass threshold is 7/10 total score." },
        { term: "Run trace", meaning: "Per-test execution trace including routing and tool behavior." },
      ],
    },
  },
  improvement: {
    title: "Improvement",
    subtitle: "Weekly decision replay audit for long-term agent quality and safe auto-tuning.",
    guide: {
      what: "Replays last week's chat/tool decisions, scores likely misses, and clusters root causes.",
      when: "Use this weekly (or after major changes) to keep behavior improving without guessing.",
      actions: [
        "Run replay manually if you shipped major runtime changes.",
        "Review top clusters and compare trend changes versus last week.",
        "Revert any low-risk auto-tune instantly if behavior regresses.",
      ],
      terms: [
        { term: "Likely wrong", meaning: "A replay item with high wrongness probability after rule + model scoring." },
        {
          term: "Duplicate suppressed",
          meaning: "Repeated finding fingerprint from prior reports, hidden from top list.",
        },
      ],
    },
  },
  skills: {
    title: "Skills",
    subtitle: "Choose which skills are active, guarded (sleep), or fully off.",
    guide: {
      what: "Manage runtime skill posture so activation stays useful without burning tokens.",
      when: "Use this when testing prompt packs, reducing noise, or hardening automation.",
      actions: [
        "Reload skills after adding or editing SKILL.md files.",
        "Set each skill to enabled, sleep, or disabled.",
        "Tune guarded-auto threshold and first-use confirmation behavior.",
        "Use Skill Sources to validate imports before install.",
      ],
      terms: [
        { term: "Sleep", meaning: "Skill is auto-eligible only when confidence is high enough." },
        { term: "Guarded auto threshold", meaning: "Minimum confidence required before a sleep skill auto-activates." },
        { term: "Import validation", meaning: "Checks SKILL.md integrity and risk signals before install." },
        {
          term: "Disabled by default",
          meaning: "Imported skills stay off until you review and enable them explicitly.",
        },
        {
          term: "Source provider",
          meaning: "Where a suggested skill came from, such as a curated marketplace or GitHub.",
        },
      ],
    },
  },
  costs: {
    title: "Costs",
    subtitle: "Track token usage and cost so runs stay predictable.",
    guide: {
      what: "Tracks token and dollar usage by day, session, agent, or task.",
      when: "Use this before and during larger runs to control spend.",
      mostCommonAction: "Pick day scope, then check usage coverage and top spend rows.",
      actions: [
        "Choose a scope (day/session/agent/task).",
        "Review hot spots.",
        "Apply run-cheaper recommendations if needed.",
      ],
    },
  },
  settings: {
    title: "Settings",
    subtitle: "Set up auth, safety defaults, budgets, and model providers.",
    guide: {
      what: "Forge controls how GoatCitadel runs, what it can access, and which models it uses.",
      when: "Use this for first-time setup and policy/provider updates.",
      actions: [
        "Set provider and model defaults.",
        "Review auth and allowlist posture.",
        "Keep credentials session-only unless you explicitly enable remember-me.",
        "Apply and verify configuration safely.",
      ],
      terms: [
        { term: "Approval mode", meaning: "How often GoatCitadel asks before allowed tool actions run." },
        {
          term: "Remember credentials",
          meaning: "Stores gateway credentials in browser local storage for convenience; leave off on shared devices.",
        },
        {
          term: "Provider ID",
          meaning: "Stable machine name GoatCitadel uses internally for a provider, such as glm or moonshot.",
        },
        {
          term: "Network allowlist",
          meaning: "Outbound hosts GoatCitadel is allowed to contact. This is not your machine's LAN IP.",
        },
      ],
    },
  },
  workspaces: {
    title: "Workspaces",
    subtitle: "Scope your data and customize runtime guidance per workspace.",
    guide: {
      what: "Manage logical workspace isolation and edit global or workspace-specific guidance docs.",
      when: "Use this when switching contexts (personal/client/project) or tuning assistant behavior.",
      actions: [
        "Create or archive workspaces.",
        "Select the active workspace for your current session.",
        "Edit guidance docs globally or as workspace overrides.",
      ],
      terms: [
        { term: "Global guidance", meaning: "Default instruction docs applied to every workspace unless overridden." },
        { term: "Workspace override", meaning: "Workspace-specific guidance that takes precedence over global docs." },
      ],
    },
  },
  tools: {
    title: "Tool Access",
    subtitle: "Decide which tools can run, where, and with what approval level.",
    guide: {
      what: "Control tool access by scope and approval rules.",
      when: "Use this before enabling higher-risk actions.",
      actions: [
        "Review tool catalog and risk levels.",
        "Create scoped grants with expiry where needed.",
        "Dry-run risky tool calls first.",
      ],
      terms: [
        {
          term: "Scope precedence",
          meaning:
            "Deny grants win across matching scopes; allow grants then follow task > agent > session > workspace > global.",
        },
        {
          term: "Grant",
          meaning: "An explicit allow or deny rule layered on top of approval mode and hard safety policy.",
        },
        {
          term: "Dry-run",
          meaning: "Validation-focused tool execution used to confirm args and policy before a live call.",
        },
      ],
    },
  },
  approvals: {
    title: "Approvals & Recovery",
    subtitle: "Persisted approval history, audit context, and runtime recovery.",
    guide: {
      what: "Persisted backend approval records, replay trails, and recovery checkpoints for work that already surfaced inline.",
      when: "Use this after the inline decision lane or when you need history, audit context, or checkpoint recovery.",
      actions: [
        "Review persisted approval records and replay trails.",
        "Inspect traceability, durable linkage, and checkpoint status.",
        "Resume or audit blocked work without turning this into the primary decision lane.",
      ],
      terms: [
        { term: "Replay", meaning: "Auditable event timeline for each approval decision." },
        { term: "Recovery", meaning: "Checkpoint-aware path for resuming durable work after an approval pause." },
      ],
    },
  },
  tasks: {
    title: "Work Queue",
    subtitle: "Track tasks, activity, deliverables, and linked subagent sessions.",
    guide: {
      what: "Task hub for planning, execution tracking, and output management.",
      when: "Use this when you want structured delivery over ad-hoc prompting.",
      actions: [
        "Create and prioritize tasks.",
        "Track activity and attach deliverables.",
        "Manage subagent sessions tied to task work.",
      ],
      terms: [{ term: "Subagent session", meaning: "A linked agent conversation doing part of a task." }],
    },
  },
  integrations: {
    title: "Integrations",
    subtitle: "Set up and control external services GoatCitadel can use.",
    guide: {
      what: "Connections store service credentials/settings, then let other workflows safely use them.",
      when: "Use this before chat writeback, automation, or provider routing that depends on an external service.",
      mostCommonAction: "Choose a catalog entry and finish Guided setup before touching advanced JSON.",
      actions: [
        "Choose a catalog entry that matches the service you want.",
        "Complete Guided setup first, then save the connection.",
        "Keep it connected or paused, and monitor status/error signals.",
        "Use optional Obsidian config only if you want local vault integration.",
      ],
      terms: [
        { term: "Catalog entry", meaning: "Template describing required fields and auth for a service." },
        { term: "Connection", meaning: "Saved config instance of a catalog entry used by runtime workflows." },
        { term: "Plugin adapter", meaning: "Optional extension for integrations not built in yet." },
        { term: "Obsidian mode", meaning: "read_append allows note appends; read_only blocks writes." },
        { term: "Connected", meaning: "The saved integration is enabled and intended for live runtime use." },
        { term: "Paused", meaning: "The connection exists but should not be used for live work until resumed." },
      ],
    },
  },
  mcp: {
    title: "MCP Servers",
    subtitle: "Register local stdio MCP servers and runtime-supported templates with trust and safety controls.",
    guide: {
      what: "Control Model Context Protocol servers with explicit trust tiers and per-server tool policy.",
      when: "Use this before enabling external MCP tooling in chat or task workflows.",
      mostCommonAction: "Install from template, keep disabled by default, then connect and test one tool safely.",
      actions: [
        "Register a local stdio server or the built-in Approval Inbox template.",
        "Connect/disconnect and confirm trust/cost posture.",
        "Set redaction and allow/block patterns before live invocation.",
      ],
      terms: [
        { term: "MCP Server", meaning: "A process or endpoint exposing tools/resources over MCP." },
        { term: "Auth", meaning: "Local credentials or configuration needed by a registered MCP server." },
        { term: "Trust tier", meaning: "Trusted, restricted, or quarantined execution posture." },
        {
          term: "Template library",
          meaning: "Starter MCP definitions you can add quickly. They still need review before live use.",
        },
        {
          term: "Redaction mode",
          meaning: "How aggressively GoatCitadel strips sensitive data before sending it to the MCP server.",
        },
      ],
    },
  },
  mesh: {
    title: "Mesh",
    subtitle: "Multi-node status, lease health, and session ownership.",
    guide: {
      what: "Shows distributed coordination state for multi-node operation.",
      when: "Use this when running GoatCitadel across multiple machines.",
      mostCommonAction: "Confirm every node is online before running cross-machine tasks.",
      actions: [
        "Check node status and connectivity.",
        "Verify leadership leases.",
        "Review session ownership and replication offsets.",
      ],
      terms: [
        { term: "Session ownership", meaning: "Single-writer lock for a session across nodes." },
        { term: "Node ID", meaning: "Stable identity for one GoatCitadel machine in the mesh." },
        {
          term: "Static peers",
          meaning: "Explicitly configured peer nodes. Leave blank unless you intend to connect machines directly.",
        },
        { term: "mDNS", meaning: "Local-network discovery for simple LAN setups." },
        { term: "Tailnet", meaning: "Private-network mode for Tailscale-style connectivity." },
      ],
    },
  },
  npu: {
    title: "Local Acceleration",
    subtitle: "Retired from the 1.0 runtime surface.",
    guide: {
      what: "Records that the former NPU sidecar path is not shipped in 1.0.",
      when: "Use llama.cpp, Ollama, LM Studio, or external providers for local model work.",
      mostCommonAction: "Leave this retired path disabled.",
      actions: ["Confirm no NPU sidecar is required for 1.0 readiness."],
      terms: [{ term: "Retired", meaning: "Removed from the shipped runtime until real hardware proof justifies it." }],
    },
  },
  onboarding: {
    title: "Launch Wizard",
    subtitle: "Guided first-time setup for auth, providers, defaults, and optional mesh.",
    guide: {
      what: "Walks you through a safe setup with practical defaults.",
      when: "Use this after install or when resetting your baseline configuration.",
      actions: [
        "Set auth and provider defaults.",
        "Review safety and runtime options.",
        "Apply setup and continue to testing tabs.",
      ],
      terms: [
        {
          term: "Provider ID",
          meaning:
            "GoatCitadel's internal machine name for a provider. The label is just the human-facing display name.",
        },
        {
          term: "API key env var",
          meaning: "Name of the environment variable GoatCitadel should read, not the key value itself.",
        },
        {
          term: "Network allowlist",
          meaning: "Outbound hosts GoatCitadel is allowed to contact. It is not the IP address of your machine.",
        },
      ],
    },
  },
  liveFeed: {
    title: "Live Feed",
    subtitle: "Raw realtime stream for deep debugging and event validation.",
    guide: {
      what: "Displays unfiltered realtime event payloads.",
      when: "Use this when you need exact raw events for debugging.",
      actions: ["Trigger an action elsewhere.", "Observe raw payloads here.", "Compare with processed page views."],
    },
  },
};
