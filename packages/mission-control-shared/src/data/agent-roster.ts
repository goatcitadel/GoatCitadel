import type { AgentProfileRecord } from "@goatcitadel/contracts";

export type RuntimeAgent = AgentProfileRecord;
export type AgentDirectoryStatus = "active" | "idle" | "ready";

export interface AgentRoleTemplate {
  roleId: string;
  name: string;
  title: string;
  summary: string;
  specialties: string[];
  defaultTools: string[];
  aliases: string[];
  priority: number;
}

export interface AgentDirectoryRecord {
  agentId: string;
  roleId: string;
  name: string;
  title: string;
  summary: string;
  specialties: string[];
  defaultTools: string[];
  aliases: string[];
  status: AgentDirectoryStatus;
  sessionCount: number;
  activeSessions: number;
  lastUpdatedAt?: string;
  runtimeAgentId?: string;
  runtimeName?: string;
  isBuiltin: boolean;
  editable: boolean;
  lifecycleStatus: "active" | "archived";
}

const BUILTIN_PRIORITY = {
  architect: 10,
  coder: 20,
  qa: 30,
  researcher: 40,
  assistant: 50,
  product: 60,
  ops: 70,
} as const;

export const BUILTIN_AGENT_ROSTER: AgentRoleTemplate[] = [
  {
    roleId: "architect",
    name: "Architect Goat",
    title: "Systems Architect",
    summary: "Designs system boundaries, contracts, and sequencing decisions.",
    specialties: ["Architecture", "APIs", "Tradeoffs"],
    defaultTools: ["session.status", "memory.read", "fs.read", "browser.search"],
    aliases: ["architect", "system architect", "staff engineer"],
    priority: BUILTIN_PRIORITY.architect,
  },
  {
    roleId: "coder",
    name: "Coder Goat",
    title: "Implementation Engineer",
    summary: "Implements features, refactors safely, and keeps delivery moving.",
    specialties: ["TypeScript", "Refactors", "Integration"],
    defaultTools: ["fs.read", "fs.write", "shell.exec", "git.exec"],
    aliases: ["coder", "developer", "implementation", "engineer"],
    priority: BUILTIN_PRIORITY.coder,
  },
  {
    roleId: "qa",
    name: "QA Goat",
    title: "Verification Lead",
    summary: "Finds regressions early, validates acceptance criteria, and hardens behavior.",
    specialties: ["Testing", "Edge cases", "Regression checks"],
    defaultTools: ["shell.exec", "fs.read", "memory.read"],
    aliases: ["qa", "quality", "tester", "verification"],
    priority: BUILTIN_PRIORITY.qa,
  },
  {
    roleId: "researcher",
    name: "Researcher Goat",
    title: "Research Analyst",
    summary: "Gathers primary-source facts, compares options, and summarizes decisions.",
    specialties: ["Discovery", "Comparative analysis", "Sourcing"],
    defaultTools: ["browser.search", "http.get", "citations.build"],
    aliases: ["researcher", "research", "analyst"],
    priority: BUILTIN_PRIORITY.researcher,
  },
  {
    roleId: "assistant",
    name: "Personal Assistant Goat",
    title: "Operations Assistant",
    summary: "Handles routine organization, reminders, and operator-facing workflows.",
    specialties: ["Coordination", "Summaries", "Ops support"],
    defaultTools: ["session.status", "memory.read", "http.get"],
    aliases: ["assistant", "personal assistant", "pa", "operator assistant"],
    priority: BUILTIN_PRIORITY.assistant,
  },
  {
    roleId: "product",
    name: "Product Goat",
    title: "Product Strategist",
    summary: "Turns user goals into scoped deliverables and measurable milestones.",
    specialties: ["Scoping", "Prioritization", "Roadmaps"],
    defaultTools: ["memory.read", "browser.search"],
    aliases: ["product", "pm", "product manager", "planner"],
    priority: BUILTIN_PRIORITY.product,
  },
  {
    roleId: "ops",
    name: "Ops Goat",
    title: "Runtime Operator",
    summary: "Monitors runtime health, safety posture, and operational constraints.",
    specialties: ["Reliability", "Safety", "Incident response"],
    defaultTools: ["session.status", "http.get", "shell.exec"],
    aliases: ["ops", "sre", "operations", "infra"],
    priority: BUILTIN_PRIORITY.ops,
  },
];

const ROLE_INDEX = new Map(BUILTIN_AGENT_ROSTER.map((role) => [role.roleId, role]));
const ACTIVE_STATUS_SCORE: Record<AgentDirectoryStatus, number> = {
  active: 3,
  idle: 2,
  ready: 1,
};

export function inferRoleId(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }
  const normalized = normalize(input);
  if (!normalized) {
    return undefined;
  }

  for (const role of BUILTIN_AGENT_ROSTER) {
    if (normalize(role.roleId) === normalized || normalize(role.name) === normalized) {
      return role.roleId;
    }

    for (const alias of role.aliases) {
      const aliasKey = normalize(alias);
      if (normalized === aliasKey || normalized.includes(aliasKey)) {
        return role.roleId;
      }
    }
  }

  return undefined;
}

export function buildAgentDirectory(runtimeAgents: RuntimeAgent[]): AgentDirectoryRecord[] {
  if (runtimeAgents.length === 0) {
    return BUILTIN_AGENT_ROSTER.map((builtin) => ({
      agentId: `fallback:${builtin.roleId}`,
      roleId: builtin.roleId,
      name: builtin.name,
      title: builtin.title,
      summary: builtin.summary,
      specialties: builtin.specialties,
      defaultTools: builtin.defaultTools,
      aliases: builtin.aliases,
      status: "ready",
      sessionCount: 0,
      activeSessions: 0,
      lastUpdatedAt: undefined,
      runtimeAgentId: undefined,
      runtimeName: undefined,
      isBuiltin: true,
      editable: true,
      lifecycleStatus: "active",
    }));
  }

  const byRoleId = new Map<string, AgentDirectoryRecord>();

  for (const agent of runtimeAgents) {
    const status: AgentDirectoryStatus =
      agent.status === "active" ? "active" : agent.sessionCount > 0 ? "idle" : "ready";

    byRoleId.set(agent.roleId, {
      agentId: agent.agentId,
      roleId: agent.roleId,
      name: agent.name,
      title: agent.title,
      summary: agent.summary,
      specialties: agent.specialties,
      defaultTools: agent.defaultTools,
      aliases: agent.aliases,
      status,
      sessionCount: agent.sessionCount,
      activeSessions: agent.activeSessions,
      lastUpdatedAt: agent.lastUpdatedAt,
      runtimeAgentId: agent.activeSessions > 0 ? agent.agentId : undefined,
      runtimeName: agent.name,
      isBuiltin: agent.isBuiltin,
      editable: agent.editable,
      lifecycleStatus: agent.lifecycleStatus,
    });
  }

  return [...byRoleId.values()].sort((left, right) => {
    const statusDelta = ACTIVE_STATUS_SCORE[right.status] - ACTIVE_STATUS_SCORE[left.status];
    if (statusDelta !== 0) {
      return statusDelta;
    }

    const leftPriority = ROLE_INDEX.get(left.roleId)?.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = ROLE_INDEX.get(right.roleId)?.priority ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return left.name.localeCompare(right.name);
  });
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
