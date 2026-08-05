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
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
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
  getSession: (sessionId: string) => unknown | Promise<unknown>;
  getChatSessionPrefs: (sessionId: string) => { mode: ChatMode } | Promise<{ mode: ChatMode }>;
  createChatSessionSpecialistCandidate: (
    sessionId: string,
    input: {
      turnId?: string;
      suggestion: ChatSpecialistCandidateSuggestionRecord;
    },
  ) => ChatSpecialistCandidateRecord | Promise<ChatSpecialistCandidateRecord>;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => Promise<unknown>;
  requireTypedRunVariables: () => void | Promise<void>;
}

export function createAgentsRoutePort(deps: AgentsRoutePortDependencies): AgentsRoutePort {
  const getAgent = async (agentId: string): Promise<AgentProfileRecord> => {
    const profile = await deps.storage.agentProfiles.get(agentId);
    const runtime = (await buildAgentRuntimeRollups(deps.storage, [profile])).get(profile.roleId);
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
    activateImportedAgentCatalogEntryForSession: async (
      sessionId: string,
      entryId: string,
    ): Promise<{
      catalogEntry: ImportedAgentCatalogRecord;
      specialist: ChatSpecialistCandidateRecord;
    }> => {
      await deps.getSession(sessionId);
      const sessionWorkspaceId = deps.normalizeWorkspaceId(
        (await deps.storage.chatSessionMeta.ensure(sessionId)).workspaceId,
      );
      const entry = await deps.storage.importedAgentCatalog.get(entryId);
      if (entry.workspaceId !== sessionWorkspaceId) {
        throw new Error("Imported catalog entry belongs to a different workspace.");
      }

      const prefs = await deps.getChatSessionPrefs(sessionId);
      const draft = await deps.createChatSessionSpecialistCandidate(sessionId, {
        suggestion: buildCatalogSpecialistSuggestion(
          entry,
          prefs.mode,
          extractSpecialistObjectiveKeywords(entry.definition.frontmatter.description),
        ),
      });
      const specialist = await deps.storage.chatSpecialistCandidates.patch(draft.candidateId, {
        status: "active",
        routingMode: "manual_only",
      });
      const catalogEntry =
        entry.state === "active"
          ? entry
          : await deps.storage.importedAgentCatalog.patchState(entryId, {
              state: "active",
            });
      await deps.publishRealtime("system", "agents", {
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
    archiveAgentProfile: async (agentId: string, input: AgentProfileArchiveInput): Promise<AgentProfileRecord> => {
      const archived = await deps.storage.agentProfiles.archive(agentId, input);
      const agent = await getAgent(archived.agentId);
      await deps.publishRealtime("system", "agents", {
        type: "agent_profile_archived",
        agentId: agent.agentId,
        roleId: agent.roleId,
        archivedBy: input.archivedBy,
      });
      return agent;
    },
    createAgentProfile: async (input: AgentProfileCreateInput): Promise<AgentProfileRecord> => {
      if (input.presetDefaults?.runVariableSchema) await deps.requireTypedRunVariables();
      const created = await deps.storage.agentProfiles.create(input);
      const agent = await getAgent(created.agentId);
      await deps.publishRealtime("system", "agents", {
        type: "agent_profile_created",
        agentId: agent.agentId,
        roleId: agent.roleId,
        name: agent.name,
        isBuiltin: agent.isBuiltin,
      });
      return agent;
    },
    getAgent,
    getImportedAgentCatalogEntry: async (entryId: string): Promise<ImportedAgentCatalogRecord> =>
      deps.storage.importedAgentCatalog.get(entryId),
    hardDeleteAgentProfile: async (agentId: string): Promise<boolean> => {
      const deleted = await deps.storage.agentProfiles.hardDelete(agentId);
      if (deleted) {
        await deps.publishRealtime("system", "agents", {
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
      await deps.publishRealtime("system", "agents", {
        type: "imported_agent_catalog_imported",
        workspaceId,
        importedCount: imported.importedCount,
        ref: imported.ref,
        repoUrl: imported.repoUrl,
      });
      return imported;
    },
    listAgents: async (view = "active", limit = 500): Promise<AgentProfileRecord[]> => {
      const profiles = await deps.storage.agentProfiles.list(view, limit);
      const runtime = await buildAgentRuntimeRollups(deps.storage, profiles);

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
    listImportedAgentCatalog: async (
      input: ImportedAgentCatalogListInput = {},
    ): Promise<{
      workspaceId: string;
      divisions: string[];
      items: ImportedAgentCatalogRecord[];
    }> => {
      const workspaceId = deps.normalizeWorkspaceId(input.workspaceId);
      return {
        workspaceId,
        divisions: await deps.storage.importedAgentCatalog.listDivisions(workspaceId),
        items: await deps.storage.importedAgentCatalog.list({
          ...input,
          workspaceId,
        }),
      };
    },
    patchImportedAgentCatalogEntryState: async (
      entryId: string,
      input: ImportedAgentCatalogStatePatchInput,
    ): Promise<ImportedAgentCatalogRecord> => {
      const updated = await deps.storage.importedAgentCatalog.patchState(entryId, input);
      await deps.publishRealtime("system", "agents", {
        type: "imported_agent_catalog_updated",
        entryId: updated.entryId,
        workspaceId: updated.workspaceId,
        state: updated.state,
      });
      return updated;
    },
    restoreAgentProfile: async (agentId: string): Promise<AgentProfileRecord> => {
      const restored = await deps.storage.agentProfiles.restore(agentId);
      const agent = await getAgent(restored.agentId);
      await deps.publishRealtime("system", "agents", {
        type: "agent_profile_restored",
        agentId: agent.agentId,
        roleId: agent.roleId,
      });
      return agent;
    },
    updateAgentProfile: async (agentId: string, input: AgentProfileUpdateInput): Promise<AgentProfileRecord> => {
      if (input.presetDefaults?.runVariableSchema) await deps.requireTypedRunVariables();
      const updated = await deps.storage.agentProfiles.update(agentId, input);
      const agent = await getAgent(updated.agentId);
      await deps.publishRealtime("system", "agents", {
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

async function buildAgentRuntimeRollups(
  storage: Pick<Storage, "taskSubagents">,
  profiles: Pick<AgentProfileRecord, "roleId" | "name" | "aliases">[],
): Promise<Map<string, { sessionCount: number; activeSessions: number; lastUpdatedAt?: string }>> {
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

  const sessions = await storage.taskSubagents.listAll(5000);
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
