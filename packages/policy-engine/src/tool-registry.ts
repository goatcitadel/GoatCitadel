/* eslint-disable max-lines */
import type { ToolCatalogEntry, ToolCategory, ToolPack, ToolRiskLevel } from "@goatcitadel/contracts";

export interface ToolDefinition {
  name: string;
  category: ToolCategory;
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
  description: string;
  argSchema?: Record<string, unknown>;
  examples?: Array<{ title: string; args: Record<string, unknown> }>;
  pack: ToolPack;
  recommendedContexts?: string[];
  preferredForIntents?: string[];
  usageHints?: string[];
  readOnly?: boolean;
  deterministic?: boolean;
  codeModeAllowed?: boolean;
}

const ARTIFACT_DESIGN_ARG_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["auto", "polished", "minimal", "plain"] },
    preset: {
      type: "string",
      enum: ["auto", "clean-professional", "education", "wellness", "pitch", "technical-report", "cyberpunk-ops"],
    },
    visualLevel: { type: "string", enum: ["minimal", "polished", "rich"] },
    assetPolicy: { type: "string", enum: ["auto", "generated-first", "web-first", "built-in-only", "none"] },
    audience: { type: "string" },
    brand: {
      type: "object",
      properties: {
        name: { type: "string" },
        colors: { type: "array", items: { type: "string" } },
        fonts: { type: "array", items: { type: "string" } },
        logoPath: { type: "string" },
      },
    },
  },
} as const;

const ARTIFACT_DESTINATION_ARG_SCHEMA = {
  oneOf: [
    { type: "string", enum: ["local", "google", "google-drive", "google-docs", "google-slides"] },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["local", "google", "google-drive", "google-docs", "google-slides"] },
        folderId: { type: "string" },
        title: { type: "string" },
        convert: { type: "boolean" },
      },
    },
  ],
} as const;

const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: "session.status",
    category: "session",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    description: "Return basic status for the active session.",
    pack: "core",
  },
  {
    name: "session.search",
    category: "session",
    riskLevel: "safe",
    requiresApproval: false,
    description:
      "Full-text search over past messages in this conversation's history (tier-2 recall). Use to pull older context that is no longer in the active window.",
    argSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string", enum: ["session", "all"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        contextRadius: { type: "integer", minimum: 0, maximum: 10 },
      },
      required: ["query"],
    },
    examples: [
      {
        title: "Recall what was decided earlier about deployment",
        args: { query: "deployment decision", limit: 5 },
      },
    ],
    pack: "core",
    readOnly: true,
    deterministic: true,
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["recall_history", "memory_lookup"],
    usageHints: [
      "Use when the user references something from earlier in the conversation that you can no longer see.",
      "Defaults to this session; pass scope:'all' only when you must search across other conversations.",
    ],
  },
  {
    name: "memory.read",
    category: "memory",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    description: "Read memory context from local memory sources.",
    argSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        query: { type: "string" },
        title: { type: "string" },
        key: { type: "string" },
        limit: { type: "number" },
      },
      required: [],
    },
    pack: "core",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["memory_lookup", "project_context"],
    usageHints: [
      "Use when you need to retrieve existing memory context or recent saved notes.",
      "Provide query, title, or key when you want a focused lookup.",
    ],
  },
  {
    name: "time.now",
    category: "session",
    riskLevel: "safe",
    requiresApproval: false,
    readOnly: true,
    description: "Return current local time and UTC time on this host.",
    pack: "core",
  },
  {
    name: "fs.read",
    category: "fs",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Read a file inside allowed read roots.",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    examples: [
      {
        title: "Read a project file",
        args: { path: "./apps/gateway/src/services/gateway-service.ts" },
      },
    ],
    pack: "core",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: ["chat", "cowork", "code", "project_bound"],
    preferredForIntents: ["local_file", "read_file"],
    usageHints: [
      "Use for a single whole-file read when you already know the path.",
      "Prefer file.read_range when you only need a focused section.",
    ],
  },
  {
    name: "file.read_range",
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Read a specific line range from a file inside allowed read roots.",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["path", "startLine", "endLine"],
    },
    examples: [
      {
        title: "Read a focused TypeScript range",
        args: {
          path: "./apps/gateway/src/services/chat-agent-orchestrator.ts",
          startLine: 880,
          endLine: 980,
        },
      },
    ],
    pack: "devops",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["local_file", "inspect_code", "targeted_read"],
    usageHints: ["Prefer this over fs.read when you only need a local slice of a file."],
  },
  {
    name: "file.find",
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Search file contents under an allowed path for a text pattern.",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        pattern: { type: "string" },
        caseSensitive: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["path", "pattern"],
    },
    examples: [
      {
        title: "Find a symbol in one package",
        args: { path: "./apps/gateway/src", pattern: "failureGuidance", limit: 20 },
      },
    ],
    pack: "devops",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["local_file", "search_text", "inspect_code"],
    usageHints: ["Use for recursive text search when you know the directory root."],
  },
  {
    name: "code.search",
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Search code and config files under an allowed path for a code/text query.",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        query: { type: "string" },
        caseSensitive: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["path", "query"],
    },
    examples: [
      {
        title: "Search gateway code for a helper",
        args: { path: "./apps/gateway/src", query: "buildToolFailureFallbackMessage", limit: 20 },
      },
    ],
    pack: "devops",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["local_file", "inspect_code", "search_code"],
    usageHints: ["Prefer this over file.find for code-oriented symbol or helper lookup."],
  },
  {
    name: "code.search_files",
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Search file and directory names under an allowed path.",
    argSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        query: { type: "string" },
        caseSensitive: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["path", "query"],
    },
    examples: [
      {
        title: "Find test files for a service",
        args: { path: "./apps/gateway/src", query: "chat-agent-orchestrator", limit: 20 },
      },
    ],
    pack: "devops",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["local_file", "search_files", "inspect_code"],
    usageHints: ["Use when you need candidate file paths before reading contents."],
  },
  {
    name: "fs.write",
    category: "fs",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Write a file inside write jail roots.",
    pack: "core",
  },
  {
    name: "fs.list",
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: "List files and directories under an allowed path.",
    pack: "devops",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
  },
  {
    name: "fs.stat",
    category: "fs",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Read file or directory metadata.",
    pack: "devops",
    readOnly: true,
    deterministic: true,
    codeModeAllowed: true,
  },
  {
    name: "fs.copy",
    category: "fs",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Copy file from source to destination inside write jail.",
    pack: "devops",
  },
  {
    name: "fs.move",
    category: "fs",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Move or rename a file inside write jail.",
    pack: "devops",
  },
  {
    name: "fs.delete",
    category: "fs",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Delete a file or directory in write jail.",
    pack: "devops",
  },
  {
    name: "http.get",
    category: "http",
    riskLevel: "caution",
    requiresApproval: false,
    description: "HTTP GET request to allowlisted hosts.",
    pack: "core",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["live_data", "fetch_url", "api_lookup"],
    usageHints: ["Prefer for direct URL/API fetches when full browser automation is unnecessary."],
    argSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
      },
      required: ["url"],
    },
    examples: [
      {
        title: "Fetch an allowlisted JSON endpoint",
        args: { url: "https://example.com/api/status" },
      },
    ],
  },
  {
    name: "http.post",
    category: "http",
    riskLevel: "danger",
    requiresApproval: true,
    description: "HTTP POST request to allowlisted hosts.",
    pack: "core",
    argSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        body: { type: "object" },
      },
      required: ["url"],
    },
    examples: [
      {
        title: "POST JSON to an allowlisted endpoint",
        args: { url: "https://example.com/api/search", body: { query: "latest status" } },
      },
    ],
  },
  {
    name: "shell.exec",
    category: "shell",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Run shell command with policy gating.",
    argSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["command"],
    },
    examples: [
      {
        title: "Run a targeted test command",
        args: { command: "pnpm --filter @goatcitadel/gateway test -- src/routes/chat.routes.test.ts" },
      },
    ],
    pack: "core",
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["run_command", "verify_change", "project_task"],
    usageHints: ["Use for foreground commands where captured stdout/stderr matters."],
  },
  {
    name: "shell.exec_background",
    category: "shell",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Start a shell command in the background and return its process details.",
    argSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["command"],
    },
    examples: [
      {
        title: "Start the local dev server in the background",
        args: { command: "pnpm dev", cwd: "./apps/mission-control-next" },
      },
    ],
    pack: "devops",
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["background_process", "long_running_command", "project_task"],
    usageHints: ["Use for long-running dev servers or watchers that should not block the turn."],
  },
  {
    name: "git.exec",
    category: "git",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Run low-level git command with approval gates.",
    pack: "core",
  },
  {
    name: "git.status",
    category: "git",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Get repository status summary.",
    pack: "devops",
  },
  {
    name: "git.diff",
    category: "git",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Get repository diff summary.",
    pack: "devops",
  },
  {
    name: "git.add",
    category: "git",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Stage files by path.",
    pack: "devops",
  },
  {
    name: "git.commit",
    category: "git",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Create git commit from staged changes.",
    pack: "devops",
  },
  {
    name: "git.branch.create",
    category: "git",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Create a new git branch.",
    pack: "devops",
  },
  {
    name: "git.branch.switch",
    category: "git",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Switch git branch.",
    pack: "devops",
  },
  {
    name: "git.worktree.create",
    category: "git",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Create git worktree at target path.",
    pack: "devops",
  },
  {
    name: "git.worktree.remove",
    category: "git",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Remove git worktree at target path.",
    pack: "devops",
  },
  {
    name: "tests.run",
    category: "ops",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Run restricted test commands.",
    pack: "devops",
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["verify_change", "run_tests"],
    usageHints: ["Prefer this over shell.exec when you specifically want a test run."],
  },
  {
    name: "lint.run",
    category: "ops",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Run restricted lint commands.",
    pack: "devops",
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["verify_change", "lint"],
    usageHints: ["Prefer this over shell.exec for lint-only validation."],
  },
  {
    name: "build.run",
    category: "ops",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Run restricted build commands.",
    pack: "devops",
    recommendedContexts: ["cowork", "code", "project_bound"],
    preferredForIntents: ["verify_change", "build"],
    usageHints: ["Prefer this over shell.exec for build verification."],
  },
  {
    name: "browser.search",
    category: "research",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Search web using browser automation.",
    pack: "core",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["live_data", "web_lookup", "research"],
    usageHints: ["Use to discover candidate sources before navigating to a page."],
    argSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 10 },
        backend: { type: "string", enum: ["native", "firecrawl"] },
      },
      required: ["query"],
    },
    examples: [
      {
        title: "Search for authoritative sources before extracting",
        args: { query: "OpenAI background mode docs", maxResults: 5, backend: "firecrawl" },
      },
    ],
  },
  {
    name: "browser.navigate",
    category: "research",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Navigate to page and extract page text.",
    pack: "core",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["web_lookup", "fetch_url", "research"],
    usageHints: ["Use when you already have a specific page URL to inspect."],
    argSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        maxChars: { type: "integer", minimum: 200, maximum: 50000 },
        backend: { type: "string", enum: ["native", "firecrawl"] },
      },
      required: ["url"],
    },
    examples: [
      {
        title: "Read a known documentation page",
        args: { url: "https://example.com/docs/guide", maxChars: 12000, backend: "firecrawl" },
      },
    ],
  },
  {
    name: "browser.extract",
    category: "research",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Extract text from selected CSS selector.",
    pack: "core",
    recommendedContexts: ["cowork", "code"],
    preferredForIntents: ["web_extract", "research"],
    usageHints: ["Use for targeted extraction when a generic page read is too noisy."],
    argSchema: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        selector: { type: "string" },
        maxChars: { type: "integer", minimum: 200, maximum: 50000 },
        backend: { type: "string", enum: ["native", "firecrawl"] },
      },
      required: ["url", "selector"],
    },
    examples: [
      {
        title: "Extract a specific results panel",
        args: { url: "https://example.com/results", selector: "main article", maxChars: 8000, backend: "firecrawl" },
      },
    ],
  },
  {
    name: "local_business.research",
    category: "research",
    riskLevel: "safe",
    requiresApproval: false,
    description:
      "Build a structured, source-backed local business contact research plan, evidence summary, verification status, and blockers.",
    pack: "core",
    readOnly: true,
    deterministic: true,
    recommendedContexts: ["cowork"],
    preferredForIntents: ["local_business_research", "contact_research", "research"],
    usageHints: [
      "Use for local-business contact discovery tasks that need candidate, source, email, contact-name, and blocker state.",
      "Treat public official/contact/about/profile sources as evidence and blocked listings as secondary leads only.",
    ],
    argSchema: {
      type: "object",
      properties: {
        objective: { type: "string" },
        location: { type: "string" },
        radiusMiles: { type: "number", minimum: 1, maximum: 250 },
        categories: { type: "array", items: { type: "string" } },
        requiredContactFields: { type: "array", items: { type: "string", enum: ["email", "contact_name"] } },
        citations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              snippet: { type: "string" },
            },
            required: ["url"],
          },
        },
      },
      required: ["objective"],
    },
    examples: [
      {
        title: "Research local tabletop game stores",
        args: {
          objective:
            "Locate boardgame/tabletop game stores within 10 miles of 91303 and find public email/contact-name evidence.",
          location: "91303",
          radiusMiles: 10,
          categories: ["board game and tabletop game store"],
          requiredContactFields: ["email", "contact_name"],
        },
      },
    ],
  },
  {
    name: "browser.screenshot",
    category: "research",
    riskLevel: "danger",
    requiresApproval: false,
    description: "Capture screenshot into jailed output path.",
    pack: "core",
  },
  {
    name: "browser.interact",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Perform interactive browser actions from step sequence.",
    pack: "core",
  },
  {
    name: "browser.cookies.get",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Read browser cookies from the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "browser.cookies.set",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Write browser cookies into the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "browser.cookies.clear",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Clear browser cookies from the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "browser.storage.get",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Read localStorage/sessionStorage from the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "browser.storage.set",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Write localStorage/sessionStorage into the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "browser.storage.clear",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Clear localStorage/sessionStorage from the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "browser.context.configure",
    category: "research",
    riskLevel: "danger",
    requiresApproval: true,
    description:
      "Configure locale, timezone, headers, credentials, and geolocation for the active in-memory browser session.",
    pack: "core",
  },
  {
    name: "mcp.invoke",
    category: "ops",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Invoke a managed MCP tool through policy-gated execution.",
    argSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        toolName: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["serverId", "toolName"],
    },
    pack: "core",
  },
  {
    name: "schedule.manage",
    category: "ops",
    riskLevel: "danger",
    requiresApproval: true,
    description:
      "Create, list, or cancel the agent's own scheduled work (an agent_turn cron job that wakes the agent on a recurring schedule). Creating or cancelling a schedule requires approval.",
    argSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["create", "list", "cancel"] },
        jobId: { type: "string", description: "Target job id for the cancel op (or the explicit id for create)." },
        name: { type: "string", description: "Human-readable name for a created schedule." },
        schedule: {
          type: "string",
          description: "Cron-style schedule, e.g. '0 9 * * 1' (every Monday 09:00). Must not be finer than 15 minutes.",
        },
        prompt: {
          type: "string",
          description: "The instruction the scheduled turn wakes the agent with.",
        },
        deliveryChannel: {
          type: "object",
          properties: {
            channelKey: { type: "string" },
            target: { type: "string" },
          },
        },
        endAt: { type: "string", description: "Optional ISO date/time after which the schedule stops firing." },
      },
      required: ["op"],
    },
    examples: [
      {
        title: "List the agent's own scheduled jobs",
        args: { op: "list" },
      },
      {
        title: "Schedule a recurring morning briefing",
        args: {
          op: "create",
          name: "Morning briefing",
          schedule: "0 9 * * 1-5",
          prompt: "Summarize overnight updates and surface anything that needs my attention.",
        },
      },
      {
        title: "Cancel a scheduled job",
        args: { op: "cancel", jobId: "morning-briefing" },
      },
    ],
    pack: "core",
    recommendedContexts: ["chat", "cowork"],
    preferredForIntents: ["schedule_work", "recurring_task", "remind_me", "self_schedule"],
    usageHints: [
      "Use to set up, review, or cancel the agent's own recurring scheduled turns.",
      "Creating or cancelling a schedule is a governed action and requires operator approval.",
    ],
  },
  {
    name: "citations.build",
    category: "research",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Build citation bundle from gathered sources.",
    pack: "core",
  },
  {
    name: "memory.write",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Write structured memory note into knowledge index.",
    pack: "knowledge",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["memory_persist"],
    usageHints: ["Use only when the user explicitly asks to save or remember something."],
  },
  {
    name: "memory.upsert",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Upsert structured memory note by deterministic key.",
    pack: "knowledge",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["memory_persist"],
  },
  {
    name: "memory.search",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Search indexed memory and return ranked snippets.",
    pack: "knowledge",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["memory_lookup", "project_context"],
    usageHints: ["Use before re-asking the same project or user-context question."],
  },
  {
    name: "docs.ingest",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Ingest file/url/text documents into normalized knowledge chunks with TTL-aware caching.",
    pack: "knowledge",
    argSchema: {
      type: "object",
      properties: {
        sourceType: { type: "string", enum: ["file", "url", "text"] },
        source: { type: "string" },
        namespace: { type: "string" },
        title: { type: "string" },
        backend: { type: "string", enum: ["native", "firecrawl"] },
        cacheTtlSeconds: { type: "integer", minimum: 0 },
        forceRefresh: { type: "boolean" },
      },
      required: ["sourceType", "source", "namespace"],
    },
  },
  {
    name: "docs.search",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Search normalized ingested context and return attributed chunks.",
    pack: "knowledge",
    argSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "embeddings.index",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Generate/update embeddings for knowledge chunks.",
    pack: "knowledge",
    argSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        documentId: { type: "string" },
        force: { type: "boolean" },
        embeddingProfile: {
          type: "object",
          properties: {
            provider: { type: "string" },
            modelId: { type: "string" },
            dimensions: { type: "integer", minimum: 1 },
            profileId: { type: "string" },
          },
        },
      },
    },
  },
  {
    name: "embeddings.query",
    category: "knowledge",
    riskLevel: "safe",
    requiresApproval: false,
    description: "Search chunks by vector similarity with lexical fallback.",
    pack: "knowledge",
    argSchema: {
      type: "object",
      properties: {
        namespace: { type: "string" },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        embeddingProfile: {
          type: "object",
          properties: {
            provider: { type: "string" },
            modelId: { type: "string" },
            dimensions: { type: "integer", minimum: 1 },
            profileId: { type: "string" },
          },
        },
      },
      required: ["query"],
    },
  },
  {
    name: "artifacts.create",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Create artifact file from template into workspace.",
    pack: "knowledge",
  },
  {
    name: "documents.create",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Create a real document artifact in a jailed workspace path.",
    argSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Output path for the document. Supported extensions include .md, .txt, .html, .json, .csv, .docx, and .pdf.",
        },
        format: {
          type: "string",
          enum: ["markdown", "md", "txt", "html", "json", "csv", "docx", "pdf"],
        },
        title: { type: "string" },
        body: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              title: { type: "string" },
              body: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
            },
          },
        },
        rows: { type: "array" },
        design: ARTIFACT_DESIGN_ARG_SCHEMA,
        destination: ARTIFACT_DESTINATION_ARG_SCHEMA,
      },
      required: ["path", "title"],
    },
    examples: [
      {
        title: "Create a Word document",
        args: {
          path: "./workspace/artifacts/free-time-report.docx",
          format: "docx",
          title: "Free Time Report",
          sections: [
            {
              heading: "Recommended Activities",
              bullets: ["Read", "Walk", "Cook something new"],
            },
          ],
        },
      },
    ],
    pack: "knowledge",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["document_generation", "artifact_output", "report", "pdf", "docx", "markdown"],
    usageHints: [
      "Use when the user asks for a real document file such as DOCX, PDF, HTML, Markdown, text, JSON, or CSV.",
      "Do not satisfy a requested document artifact with text-only prose when this tool is available.",
      "Use design.mode minimal or plain for raw data, logs, JSON, CSV, code, or explicitly plain outputs.",
    ],
  },
  {
    name: "presentations.create",
    category: "knowledge",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Create a real PowerPoint .pptx deck in a jailed workspace path.",
    argSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Output path for the .pptx file. Use a safe workspace or artifacts path when none is provided.",
        },
        title: { type: "string" },
        subtitle: { type: "string" },
        slides: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              bullets: {
                type: "array",
                items: { type: "string" },
              },
              speakerNotes: { type: "string" },
            },
            required: ["title"],
          },
        },
        theme: { type: "string" },
        design: ARTIFACT_DESIGN_ARG_SCHEMA,
        visualAsset: {
          type: "object",
          description:
            "Optional generated supporting image for the deck. Prefer gateway-generated image assets with source/model provenance.",
          properties: {
            bytesBase64: { type: "string" },
            b64Json: { type: "string" },
            dataBase64: { type: "string" },
            mimeType: { type: "string" },
            altText: { type: "string" },
            source: { type: "string" },
            sourceModel: { type: "string" },
            revisedPrompt: { type: "string" },
          },
        },
        destination: ARTIFACT_DESTINATION_ARG_SCHEMA,
      },
      required: ["path", "title", "slides"],
    },
    examples: [
      {
        title: "Create a PowerPoint deck",
        args: {
          path: "./workspace/artifacts/free-time-activities.pptx",
          title: "Top Things To Do In Free Time",
          slides: [
            {
              title: "Go Outside",
              bullets: ["Pick a nearby park or trail.", "Keep the plan lightweight and repeatable."],
            },
          ],
        },
      },
    ],
    pack: "knowledge",
    recommendedContexts: ["chat", "cowork", "code"],
    preferredForIntents: ["presentation", "slide_deck", "powerpoint", "artifact_output", "document_generation"],
    usageHints: [
      "Use when the user asks for PowerPoint, PPTX, slides, a slide deck, or a presentation file.",
      "Do not satisfy a requested PowerPoint by returning markdown-only slide text unless this tool is unavailable or blocked.",
      "Use design.mode polished or design.preset when the user asks for a visually appealing deck.",
    ],
  },
  {
    name: "channel.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send channel message via configured integration connection.",
    pack: "comms",
  },
  {
    name: "channel.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send a reaction via a configured integration connection when the provider supports it.",
    pack: "comms",
  },
  {
    name: "channel.unsend",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description:
      "Unsend a previously sent message via a configured integration connection when the provider supports it.",
    pack: "comms",
  },
  {
    name: "webhook.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send signed webhook payload to configured endpoint.",
    pack: "comms",
  },
  {
    name: "gmail.read",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Read Gmail messages with configured query.",
    pack: "comms",
  },
  {
    name: "gmail.send",
    category: "comms",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Send Gmail message from configured account.",
    pack: "comms",
  },
  {
    name: "calendar.list",
    category: "comms",
    riskLevel: "safe",
    requiresApproval: false,
    description: "List calendar events in time window.",
    pack: "comms",
  },
  {
    name: "calendar.create_event",
    category: "comms",
    riskLevel: "danger",
    requiresApproval: true,
    description: "Create calendar event with attendees.",
    pack: "comms",
  },
  {
    name: "discord.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Discord webhook/channel integration.",
    pack: "comms",
  },
  {
    name: "discord.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Add a reaction through a Discord bot or compatible webhook-backed connector.",
    pack: "comms",
  },
  {
    name: "discord.unsend",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Delete a previously sent Discord message when the connector credentials permit it.",
    pack: "comms",
  },
  {
    name: "imessage.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to iMessage BlueBubbles bridge integration.",
    pack: "comms",
  },
  {
    name: "imessage.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "React to an iMessage message via BlueBubbles.",
    pack: "comms",
  },
  {
    name: "imessage.unsend",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Unsend a previously sent iMessage via BlueBubbles.",
    pack: "comms",
  },
  {
    name: "line.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to LINE Messaging API integration.",
    pack: "comms",
  },
  {
    name: "mattermost.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Mattermost bot/channel integration.",
    pack: "comms",
  },
  {
    name: "mattermost.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Add a reaction to a Mattermost post.",
    pack: "comms",
  },
  {
    name: "mattermost.unsend",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Delete a previously sent Mattermost post.",
    pack: "comms",
  },
  {
    name: "nextcloud-talk.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Nextcloud Talk bot integration.",
    pack: "comms",
  },
  {
    name: "nextcloud-talk.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Add a reaction to a Nextcloud Talk message through the bot integration.",
    pack: "comms",
  },
  {
    name: "telegram.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Telegram bot integration.",
    pack: "comms",
  },
  {
    name: "telegram.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Add a reaction to a Telegram message through the Telegram Bot API.",
    pack: "comms",
  },
  {
    name: "signal.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Signal bridge integration.",
    pack: "comms",
  },
  {
    name: "whatsapp.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to WhatsApp Cloud API integration.",
    pack: "comms",
  },
  {
    name: "whatsapp.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Add a reaction through the WhatsApp Cloud API.",
    pack: "comms",
  },
  {
    name: "slack.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Slack webhook/channel integration.",
    pack: "comms",
  },
  {
    name: "slack.react",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Add a reaction to a Slack message through the Slack Web API.",
    pack: "comms",
  },
  {
    name: "slack.unsend",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Delete a previously sent Slack message through the Slack Web API.",
    pack: "comms",
  },
  {
    name: "telegram.unsend",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Delete a previously sent Telegram bot message.",
    pack: "comms",
  },
  {
    name: "google-chat.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Google Chat webhook integration.",
    pack: "comms",
  },
  {
    name: "teams.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Microsoft Teams webhook integration.",
    pack: "comms",
  },
  {
    name: "zalo.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Zalo OA bot integration.",
    pack: "comms",
  },
  {
    name: "zalouser.send",
    category: "comms",
    riskLevel: "caution",
    requiresApproval: false,
    description: "Send message to Zalo personal zca bridge integration.",
    pack: "comms",
  },
];

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();

  public constructor(initial: ToolDefinition[] = BUILTIN_TOOLS) {
    for (const tool of initial) {
      this.byName.set(tool.name, tool);
    }
  }

  public get(name: string): ToolDefinition | undefined {
    return this.byName.get(name);
  }

  public list(): ToolDefinition[] {
    return [...this.byName.values()];
  }

  public toCatalog(): ToolCatalogEntry[] {
    return this.list().map((tool) => ({
      toolName: tool.name,
      category: tool.category,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      description: tool.description,
      argSchema: tool.argSchema ?? {},
      examples: tool.examples ?? [],
      pack: tool.pack,
      recommendedContexts: tool.recommendedContexts,
      preferredForIntents: tool.preferredForIntents,
      usageHints: tool.usageHints,
      readOnly: tool.readOnly,
      deterministic: tool.deterministic,
      codeModeAllowed: tool.codeModeAllowed,
    }));
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry(BUILTIN_TOOLS);
}

let readOnlyBuiltinToolNames: ReadonlySet<string> | undefined;

/**
 * Builtin tools that are safe to execute concurrently within one model turn:
 * declared read-only, never approval-gated at the definition level, and
 * risk-classified safe. Callers still run full per-call policy evaluation —
 * this set only decides whether calls may OVERLAP, never whether they run.
 */
export function listReadOnlyBuiltinToolNames(): ReadonlySet<string> {
  if (!readOnlyBuiltinToolNames) {
    readOnlyBuiltinToolNames = new Set(
      BUILTIN_TOOLS.filter(
        (tool) => tool.readOnly === true && tool.requiresApproval === false && tool.riskLevel === "safe",
      ).map((tool) => tool.name),
    );
  }
  return readOnlyBuiltinToolNames;
}
