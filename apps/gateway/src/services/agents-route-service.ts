import type {
  AgencyCatalogImportRequest,
  AgencyCatalogImportResponse,
  AgentProfileArchiveInput,
  AgentProfileCreateInput,
  AgentProfileRecord,
  AgentProfileUpdateInput,
  ChatMode,
  ChatSpecialistCandidateRecord,
  ChatSpecialistCandidateSuggestionRecord,
  ImportedAgentCatalogListInput,
  ImportedAgentCatalogRecord,
  ImportedAgentCatalogStatePatchInput,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { buildCatalogSpecialistSuggestion, importAgencyCatalog } from "./agency-agent-catalog-service.js";
import { extractSpecialistObjectiveKeywords } from "./chat-turn-planning-helpers.js";
import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const agentsRouteMethods = [
  "activateImportedAgentCatalogEntryForSession",
  "archiveAgentProfile",
  "createAgentProfile",
  "getAgent",
  "getImportedAgentCatalogEntry",
  "hardDeleteAgentProfile",
  "importAgencyAgentCatalog",
  "listAgents",
  "listImportedAgentCatalog",
  "patchImportedAgentCatalogEntryState",
  "restoreAgentProfile",
  "updateAgentProfile",
] as const;

export type AgentsRouteMethod = (typeof agentsRouteMethods)[number];
export type AgentsRoutePort = RoutePort<AgentsRouteMethod>;
export type AgentsRouteService = RouteService<AgentsRouteMethod>;

export interface AgentsRoutePortDependencies {
  storage: Storage;
  normalizeWorkspaceId: (workspaceId?: string) => string;
  getSession: (sessionId: string) => unknown;
  getChatSessionPrefs: (sessionId: string) => { mode: ChatMode };
  createChatSessionSpecialistCandidate: (
    sessionId: string,
    input: {
      turnId?: string;
      suggestion: ChatSpecialistCandidateSuggestionRecord;
    },
  ) => ChatSpecialistCandidateRecord;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => void;
}

export function createAgentsRoutePort(deps: AgentsRoutePortDependencies): AgentsRoutePort {
  const getAgent = (agentId: string): AgentProfileRecord => {
    const profile = deps.storage.agentProfiles.get(agentId);
    const runtime = buildAgentRuntimeRollups(deps.storage, [profile]).get(profile.roleId);
    const activeSessions = runtime?.activeSessions ?? 0;
    return {
      ...profile,
      status: activeSessions > 0 ? "active" : "idle",
      sessionCount: runtime?.sessionCount ?? 0,
      activeSessions,
      lastUpdatedAt: runtime?.lastUpdatedAt,
    };
  };

  return {
    activateImportedAgentCatalogEntryForSession: (
      sessionId: string,
      entryId: string,
    ): {
      catalogEntry: ImportedAgentCatalogRecord;
      specialist: ChatSpecialistCandidateRecord;
    } => {
      deps.getSession(sessionId);
      const sessionWorkspaceId = deps.normalizeWorkspaceId(deps.storage.chatSessionMeta.ensure(sessionId).workspaceId);
      const entry = deps.storage.importedAgentCatalog.get(entryId);
      if (entry.workspaceId !== sessionWorkspaceId) {
        throw new Error("Imported catalog entry belongs to a different workspace.");
      }

      const prefs = deps.getChatSessionPrefs(sessionId);
      const draft = deps.createChatSessionSpecialistCandidate(sessionId, {
        suggestion: buildCatalogSpecialistSuggestion(
          entry,
          prefs.mode,
          extractSpecialistObjectiveKeywords(entry.definition.frontmatter.description),
        ),
      });
      const specialist = deps.storage.chatSpecialistCandidates.patch(draft.candidateId, {
        status: "active",
        routingMode: "manual_only",
      });
      const catalogEntry =
        entry.state === "active"
          ? entry
          : deps.storage.importedAgentCatalog.patchState(entryId, {
              state: "active",
            });
      deps.publishRealtime("system", "agents", {
        type: "imported_agent_catalog_activated",
        entryId,
        workspaceId: catalogEntry.workspaceId,
        sessionId,
        candidateId: specialist.candidateId,
      });
      return {
        catalogEntry,
        specialist,
      };
    },
    archiveAgentProfile: (agentId: string, input: AgentProfileArchiveInput): AgentProfileRecord => {
      const archived = deps.storage.agentProfiles.archive(agentId, input);
      const agent = getAgent(archived.agentId);
      deps.publishRealtime("system", "agents", {
        type: "agent_profile_archived",
        agentId: agent.agentId,
        roleId: agent.roleId,
        archivedBy: input.archivedBy,
      });
      return agent;
    },
    createAgentProfile: (input: AgentProfileCreateInput): AgentProfileRecord => {
      const created = deps.storage.agentProfiles.create(input);
      const agent = getAgent(created.agentId);
      deps.publishRealtime("system", "agents", {
        type: "agent_profile_created",
        agentId: agent.agentId,
        roleId: agent.roleId,
        name: agent.name,
        isBuiltin: agent.isBuiltin,
      });
      return agent;
    },
    getAgent,
    getImportedAgentCatalogEntry: (entryId: string): ImportedAgentCatalogRecord =>
      deps.storage.importedAgentCatalog.get(entryId),
    hardDeleteAgentProfile: (agentId: string): boolean => {
      const deleted = deps.storage.agentProfiles.hardDelete(agentId);
      if (deleted) {
        deps.publishRealtime("system", "agents", {
          type: "agent_profile_deleted",
          agentId,
        });
      }
      return deleted;
    },
    importAgencyAgentCatalog: async (input: AgencyCatalogImportRequest = {}): Promise<AgencyCatalogImportResponse> => {
      const workspaceId = deps.normalizeWorkspaceId(input.workspaceId);
      const imported = await importAgencyCatalog({
        storage: deps.storage,
        workspaceId,
        repoUrl: input.repoUrl,
        ref: input.ref,
      });
      deps.publishRealtime("system", "agents", {
        type: "imported_agent_catalog_imported",
        workspaceId,
        importedCount: imported.importedCount,
        ref: imported.ref,
        repoUrl: imported.repoUrl,
      });
      return imported;
    },
    listAgents: (view = "active", limit = 500): AgentProfileRecord[] => {
      const profiles = deps.storage.agentProfiles.list(view, limit);
      const runtime = buildAgentRuntimeRollups(deps.storage, profiles);

      const merged = profiles.map((profile) => {
        const runtimeStats = runtime.get(profile.roleId);
        const activeSessions = runtimeStats?.activeSessions ?? 0;
        const sessionCount = runtimeStats?.sessionCount ?? 0;
        const lastUpdatedAt = runtimeStats?.lastUpdatedAt;
        return {
          ...profile,
          status: activeSessions > 0 ? "active" : "idle",
          sessionCount,
          activeSessions,
          lastUpdatedAt,
        } satisfies AgentProfileRecord;
      });

      return merged.sort((left, right) => {
        if (left.status !== right.status) {
          return left.status === "active" ? -1 : 1;
        }
        if (left.isBuiltin !== right.isBuiltin) {
          return left.isBuiltin ? -1 : 1;
        }
        const leftUpdated = Date.parse(left.lastUpdatedAt ?? left.updatedAt);
        const rightUpdated = Date.parse(right.lastUpdatedAt ?? right.updatedAt);
        if (leftUpdated !== rightUpdated) {
          return rightUpdated - leftUpdated;
        }
        return left.name.localeCompare(right.name);
      });
    },
    listImportedAgentCatalog: (
      input: ImportedAgentCatalogListInput = {},
    ): {
      workspaceId: string;
      divisions: string[];
      items: ImportedAgentCatalogRecord[];
    } => {
      const workspaceId = deps.normalizeWorkspaceId(input.workspaceId);
      return {
        workspaceId,
        divisions: deps.storage.importedAgentCatalog.listDivisions(workspaceId),
        items: deps.storage.importedAgentCatalog.list({
          ...input,
          workspaceId,
        }),
      };
    },
    patchImportedAgentCatalogEntryState: (
      entryId: string,
      input: ImportedAgentCatalogStatePatchInput,
    ): ImportedAgentCatalogRecord => {
      const updated = deps.storage.importedAgentCatalog.patchState(entryId, input);
      deps.publishRealtime("system", "agents", {
        type: "imported_agent_catalog_updated",
        entryId: updated.entryId,
        workspaceId: updated.workspaceId,
        state: updated.state,
      });
      return updated;
    },
    restoreAgentProfile: (agentId: string): AgentProfileRecord => {
      const restored = deps.storage.agentProfiles.restore(agentId);
      const agent = getAgent(restored.agentId);
      deps.publishRealtime("system", "agents", {
        type: "agent_profile_restored",
        agentId: agent.agentId,
        roleId: agent.roleId,
      });
      return agent;
    },
    updateAgentProfile: (agentId: string, input: AgentProfileUpdateInput): AgentProfileRecord => {
      const updated = deps.storage.agentProfiles.update(agentId, input);
      const agent = getAgent(updated.agentId);
      deps.publishRealtime("system", "agents", {
        type: "agent_profile_updated",
        agentId: agent.agentId,
        roleId: agent.roleId,
        name: agent.name,
      });
      return agent;
    },
  };
}

export function createAgentsRouteService(port: AgentsRoutePort): AgentsRouteService {
  return createRouteService(port, agentsRouteMethods);
}

function buildAgentRuntimeRollups(
  storage: Pick<Storage, "taskSubagents">,
  profiles: Pick<AgentProfileRecord, "roleId" | "name" | "aliases">[],
): Map<string, { sessionCount: number; activeSessions: number; lastUpdatedAt?: string }> {
  const byRoleId = new Map<string, { sessionCount: number; activeSessions: number; lastUpdatedAt?: string }>();
  const lookup = new Map<string, string>();

  for (const profile of profiles) {
    const roleKey = normalizeLookupValue(profile.roleId);
    if (roleKey) {
      lookup.set(roleKey, profile.roleId);
    }
    const nameKey = normalizeLookupValue(profile.name);
    if (nameKey) {
      lookup.set(nameKey, profile.roleId);
    }
    for (const alias of profile.aliases) {
      const aliasKey = normalizeLookupValue(alias);
      if (aliasKey) {
        lookup.set(aliasKey, profile.roleId);
      }
    }
  }

  const sessions = storage.taskSubagents.listAll(5000);
  for (const session of sessions) {
    const roleId = inferSessionRoleId(session.agentName, session.agentSessionId, lookup);
    if (!roleId) {
      continue;
    }

    const current = byRoleId.get(roleId) ?? {
      sessionCount: 0,
      activeSessions: 0,
      lastUpdatedAt: undefined as string | undefined,
    };
    current.sessionCount += 1;
    if (session.status === "active") {
      current.activeSessions += 1;
    }
    if (!current.lastUpdatedAt || Date.parse(session.updatedAt) > Date.parse(current.lastUpdatedAt)) {
      current.lastUpdatedAt = session.updatedAt;
    }
    byRoleId.set(roleId, current);
  }

  return byRoleId;
}

function inferSessionRoleId(
  agentName: string | undefined,
  agentSessionId: string,
  lookup: Map<string, string>,
): string | undefined {
  const directCandidates = [agentName, agentSessionId];
  for (const candidate of directCandidates) {
    if (!candidate) {
      continue;
    }
    const found = lookup.get(normalizeLookupValue(candidate));
    if (found) {
      return found;
    }
  }

  const normalizedName = normalizeLookupValue(agentName ?? "");
  const normalizedSessionId = normalizeLookupValue(agentSessionId);
  for (const [key, roleId] of lookup.entries()) {
    if (!key) {
      continue;
    }
    if (normalizedName.includes(key) || normalizedSessionId.includes(key)) {
      return roleId;
    }
  }

  return undefined;
}

function normalizeLookupValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
