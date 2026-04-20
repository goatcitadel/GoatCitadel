export type AgentRuntimeStatus = "active" | "idle";
export type AgentLifecycleStatus = "active" | "archived";
export type RichAgentSourceProvider = "agency_agents" | "manual" | "workspace";
export type RichAgentParseSupportStatus = "supported" | "supported_with_warnings" | "unsupported";
export type ImportedAgentCatalogLifecycleStatus = "disabled" | "approved" | "active" | "retired";
export type RichAgentSectionKind = "persona" | "operations" | "reference" | "other";

export interface AgentProfileRecord {
  agentId: string;
  roleId: string;
  name: string;
  title: string;
  summary: string;
  specialties: string[];
  defaultTools: string[];
  aliases: string[];
  isBuiltin: boolean;
  editable: boolean;
  lifecycleStatus: AgentLifecycleStatus;
  archivedAt?: string;
  archivedBy?: string;
  archiveReason?: string;
  richDefinitionId?: string;
  richDefinitionParseStatus?: RichAgentParseSupportStatus;
  richDefinitionSource?: RichAgentSourceProvider;
  status: AgentRuntimeStatus;
  sessionCount: number;
  activeSessions: number;
  lastUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileCreateInput {
  roleId: string;
  name: string;
  title: string;
  summary: string;
  specialties?: string[];
  defaultTools?: string[];
  aliases?: string[];
}

export interface AgentProfileUpdateInput {
  name?: string;
  title?: string;
  summary?: string;
  specialties?: string[];
  defaultTools?: string[];
  aliases?: string[];
}

export interface AgentProfileArchiveInput {
  archivedBy?: string;
  archiveReason?: string;
}

export interface BuiltinAgentProfileSeed {
  agentId: string;
  roleId: string;
  name: string;
  title: string;
  summary: string;
  specialties: string[];
  defaultTools: string[];
  aliases: string[];
}

export interface RichAgentFrontmatter {
  name: string;
  description: string;
  color?: string;
  services?: string[];
  presentation?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface RichAgentSectionRecord {
  key: string;
  slug: string;
  heading: string;
  level: number;
  kind: RichAgentSectionKind;
  content: string;
  canonicalKey?: string;
}

export type RichAgentSectionMap = Record<string, RichAgentSectionRecord>;

export interface RichAgentSourceProvenance {
  provider: RichAgentSourceProvider;
  repoUrl?: string;
  ref?: string;
  commit?: string;
  path: string;
  sha256: string;
  importedAt: string;
}

export interface RichAgentDefinitionRecord {
  definitionId: string;
  slug: string;
  frontmatter: RichAgentFrontmatter;
  rawMarkdown: string;
  bodyMarkdown: string;
  sectionOrder: string[];
  sectionMap: RichAgentSectionMap;
  parseStatus: RichAgentParseSupportStatus;
  parseWarnings: string[];
  provenance: RichAgentSourceProvenance;
}

export interface ImportedAgentCatalogRecord {
  entryId: string;
  workspaceId: string;
  division: string;
  state: ImportedAgentCatalogLifecycleStatus;
  createdAt: string;
  updatedAt: string;
  activatedAt?: string;
  retiredAt?: string;
  definition: RichAgentDefinitionRecord;
}

export interface ImportedAgentCatalogListInput {
  workspaceId?: string;
  division?: string;
  search?: string;
  state?: ImportedAgentCatalogLifecycleStatus | "all";
  parseStatus?: RichAgentParseSupportStatus | "all";
  limit?: number;
}

export interface ImportedAgentCatalogStatePatchInput {
  state: ImportedAgentCatalogLifecycleStatus;
}

export interface AgencyCatalogImportRequest {
  workspaceId?: string;
  repoUrl?: string;
  ref?: string;
}

export interface AgencyCatalogImportResponse {
  workspaceId: string;
  repoUrl: string;
  ref: string;
  commit?: string;
  importedAt: string;
  importedCount: number;
  divisions: string[];
  parseCounts: Record<RichAgentParseSupportStatus, number>;
}

export interface CatalogSessionActivationRequest {
  sessionId: string;
}

export const BUILTIN_AGENT_PROFILES: BuiltinAgentProfileSeed[] = [
  {
    agentId: "builtin-architect",
    roleId: "architect",
    name: "Architect Goat",
    title: "Systems Architect",
    summary: "Designs system boundaries, contracts, and sequencing decisions.",
    specialties: ["Architecture", "APIs", "Tradeoffs"],
    defaultTools: ["session.status", "memory.read", "fs.read", "browser.search"],
    aliases: ["architect", "system architect", "staff engineer"],
  },
  {
    agentId: "builtin-coder",
    roleId: "coder",
    name: "Coder Goat",
    title: "Implementation Engineer",
    summary: "Implements features, refactors safely, and keeps delivery moving.",
    specialties: ["TypeScript", "Refactors", "Integration"],
    defaultTools: ["fs.read", "fs.write", "shell.exec", "git.exec"],
    aliases: ["coder", "developer", "implementation", "engineer"],
  },
  {
    agentId: "builtin-qa",
    roleId: "qa",
    name: "QA Goat",
    title: "Verification Lead",
    summary: "Finds regressions early, validates acceptance criteria, and hardens behavior.",
    specialties: ["Testing", "Edge cases", "Regression checks"],
    defaultTools: ["shell.exec", "fs.read", "memory.read"],
    aliases: ["qa", "quality", "tester", "verification"],
  },
  {
    agentId: "builtin-researcher",
    roleId: "researcher",
    name: "Researcher Goat",
    title: "Research Analyst",
    summary: "Gathers primary-source facts, compares options, and summarizes decisions.",
    specialties: ["Discovery", "Comparative analysis", "Sourcing"],
    defaultTools: ["browser.search", "http.get", "citations.build"],
    aliases: ["researcher", "research", "analyst"],
  },
  {
    agentId: "builtin-assistant",
    roleId: "assistant",
    name: "Personal Assistant Goat",
    title: "Operations Assistant",
    summary: "Handles routine organization, reminders, and operator-facing workflows.",
    specialties: ["Coordination", "Summaries", "Ops support"],
    defaultTools: ["session.status", "memory.read", "http.get"],
    aliases: ["assistant", "personal assistant", "pa", "operator assistant"],
  },
  {
    agentId: "builtin-product",
    roleId: "product",
    name: "Product Goat",
    title: "Product Strategist",
    summary: "Turns user goals into scoped deliverables and measurable milestones.",
    specialties: ["Scoping", "Prioritization", "Roadmaps"],
    defaultTools: ["memory.read", "browser.search"],
    aliases: ["product", "pm", "product manager", "planner"],
  },
  {
    agentId: "builtin-ops",
    roleId: "ops",
    name: "Ops Goat",
    title: "Runtime Operator",
    summary: "Monitors runtime health, safety posture, and operational constraints.",
    specialties: ["Reliability", "Safety", "Incident response"],
    defaultTools: ["session.status", "http.get", "shell.exec"],
    aliases: ["ops", "sre", "operations", "infra"],
  },
];
