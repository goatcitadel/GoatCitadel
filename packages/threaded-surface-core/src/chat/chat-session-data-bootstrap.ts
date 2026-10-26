import type { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import type { recordChatRefreshPhase } from "./chat-causality";
import type {
  ChatMode,
  ChatSessionSearchResponse,
  ChatThreadResponse,
  McpServerRecord,
  McpServerTemplateRecord,
  SkillListItem,
} from "@goatcitadel/contracts";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  ChatProjectsResponse,
  ChatSessionsResponse,
  RuntimeSettingsResponse,
} from "@goatcitadel/mission-control-shared/api/client";

export interface CommandCatalogItem {
  command: string;
  usage: string;
  description: string;
}

export type ChatHistoryView = "active" | "archived";

const INITIAL_ACTIVE_SESSION_LIMIT = 100;
const INITIAL_ARCHIVED_SESSION_LIMIT = 150;
// The Gateway discovery search owner accepts at most 200 results.
const SEARCH_SESSION_LIMIT = 200;
const DEV_BOOTSTRAP_CACHE_TTL_MS = 5000;
const SHOULD_REUSE_DEV_BOOTSTRAP_FETCHES = process.env.NODE_ENV !== "production";

export type BootstrapCacheEntry<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

export type SidebarBootstrapResult = {
  projects: ChatProjectsResponse;
  sessions: ChatSessionsResponse;
};

export type ChatSidebarLoadOptions = {
  routeOnly?: boolean;
  bypassCache?: boolean;
  preferredSessionId?: string | null;
  /** Refresh records without reselecting after an owner has already adopted a canonical session. */
  preserveSelection?: boolean;
  append?: boolean;
  /** Reconcile canonical projections without replacing loaded rows, order, cursor or selection. */
  reconcileLoadedRange?: boolean;
};

export type RuntimeCatalogBootstrapResult = {
  runtimeSettings: RuntimeSettingsResponse;
  commands: { items: CommandCatalogItem[] };
  skills: { items: SkillListItem[] };
  servers: { items: McpServerRecord[] };
  templates: { items: Array<McpServerTemplateRecord & { installed: boolean }> };
};

export const sidebarBootstrapCache = new Map<string, BootstrapCacheEntry<SidebarBootstrapResult>>();
export const runtimeCatalogBootstrapCache = new Map<string, BootstrapCacheEntry<RuntimeCatalogBootstrapResult>>();

export function resolveSidebarSessionLimit(historyView: ChatHistoryView, searchQuery: string): number {
  if (searchQuery.trim()) {
    return SEARCH_SESSION_LIMIT;
  }
  return historyView === "archived" ? INITIAL_ARCHIVED_SESSION_LIMIT : INITIAL_ACTIVE_SESSION_LIMIT;
}

export function getDevBootstrapPromise<T>(
  cache: Map<string, BootstrapCacheEntry<T>>,
  key: string,
  factory: () => Promise<T>,
  options: { bypassCache?: boolean } = {},
): Promise<T> {
  if (options.bypassCache) {
    if (options.bypassCache) {
      cache.delete(key);
    }
    return factory();
  }

  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = factory();
  // Share pending reads in every build. Production evicts on settlement so an explicit
  // refresh never replays stale evidence; development also retains its short bootstrap TTL.
  // Evict the entry immediately on rejection so a single
  // transient failure is not replayed from cache for the whole TTL window (which made the
  // sidebar/runtime catalog appear broken until the entry expired). `promise` itself still
  // rejects for the caller.
  promise.then(
    () => {
      const settled = cache.get(key);
      if (settled?.promise !== promise) return;
      if (!SHOULD_REUSE_DEV_BOOTSTRAP_FETCHES) {
        cache.delete(key);
        return;
      }
      settled.expiresAt = Date.now() + DEV_BOOTSTRAP_CACHE_TTL_MS;
      globalThis.setTimeout(() => {
        const current = cache.get(key);
        if (current?.promise === promise && current.expiresAt <= Date.now()) {
          cache.delete(key);
        }
      }, DEV_BOOTSTRAP_CACHE_TTL_MS);
    },
    () => {
      const current = cache.get(key);
      if (current?.promise === promise) {
        cache.delete(key);
      }
    },
  );

  cache.set(key, {
    promise,
    expiresAt: Number.POSITIVE_INFINITY,
  });
  return promise;
}

export type ChatSessionDataInput = {
  workspaceId: string;
  viewIdentity?: string;
  historyView: ChatHistoryView;
  searchQuery: string;
  routeSessionId?: string | null;
  selectedSessionId: string | null;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  runtimeLlmConfig: RuntimeSettingsResponse["llm"] | null;
  setError: (value: string | null) => void;
  applyFetchedThreadRef: MutableRefObject<(thread: ChatThreadResponse, requestVersion: number | null) => boolean>;
  messageMutationVersionRef: MutableRefObject<number>;
  lastLocalPrefMutationAtRef: MutableRefObject<number>;
  surfaceMode?: ChatMode;
  /**
   * A URL named a conversation that is not visible in this workspace and view (deleted, archived
   * or never existed). The list still loads; `fallbackSessionId` is the conversation shown instead.
   */
  onRouteSessionUnavailable?: (requestedSessionId: string, fallbackSessionId: string | null) => void;
  /** Native shells request secondary evidence when its inspector opens. */
  secondaryEnabled?: boolean;
  /** Native optional catalogs load on inspector or composer-palette intent. */
  catalogEnabled?: boolean;
};
export type ChatCoreLoadOptions = {
  background?: boolean;
  includeThread?: boolean;
};
export type ChatSecondaryLoadOptions = {
  background?: boolean;
};
export type ChatSessionLoadOptions = {
  background?: boolean;
  includeThread?: boolean;
  deferSecondary?: boolean;
};
export type ChatViewRefreshOptions = {
  refreshSidebar?: boolean;
  refreshSession?: "none" | "light" | "full";
  showIndicator?: boolean;
};
export function projectChatSessionSearch(response: ChatSessionSearchResponse): ChatSessionsResponse {
  return {
    items: response.items.map((item) => ({ ...item.session, searchHits: item.hits })),
    nextCursor: response.nextCursor,
  };
}
export function appendSidebarSessions(
  current: ChatSessionsResponse | null,
  nextSessions: ChatSessionsResponse,
): ChatSessionsResponse {
  if (!current) {
    return nextSessions;
  }
  const seenSessionIds = new Set(current.items.map((item) => item.sessionId));
  return {
    ...nextSessions,
    items: [
      ...current.items,
      ...nextSessions.items.filter((item) => {
        if (seenSessionIds.has(item.sessionId)) {
          return false;
        }
        seenSessionIds.add(item.sessionId);
        return true;
      }),
    ],
  };
}
export function reconcileSidebarSessions(
  current: ChatSessionsResponse,
  members: Map<string, ChatSessionsResponse["items"][number]>,
  records: Map<string, ChatSessionsResponse["items"][number]>,
): ChatSessionsResponse {
  const retained = new Set(current.items.map((record) => record.sessionId));
  const survivors = current.items.flatMap((record) => {
    const member = members.get(record.sessionId);
    return member
      ? [
          {
            ...record,
            ...member,
            searchHits: member.searchHits ?? records.get(record.sessionId)?.searchHits ?? record.searchHits,
          },
        ]
      : [];
  });
  return {
    ...current,
    items: [...survivors, ...[...records.values()].filter((record) => !retained.has(record.sessionId))],
  };
}
/** The conversation shown instead when the address named one that is not visible. */
export function routeFallbackSessionId(
  current: string | null,
  sessions: ChatSessionsResponse | null,
  options: ChatSidebarLoadOptions = {},
): string | null {
  return sessions ? selectSidebarSession(current, sessions, options, undefined) : null;
}
export function selectSidebarSession(
  current: string | null,
  nextSessions: ChatSessionsResponse,
  options: ChatSidebarLoadOptions,
  initialRouteSelection: string | undefined,
): string | null {
  const preferredSessionId = options.preferredSessionId?.trim() || initialRouteSelection;
  if (preferredSessionId && nextSessions.items.some((item) => item.sessionId === preferredSessionId)) {
    return preferredSessionId;
  }
  if (!current) {
    return nextSessions.items[0]?.sessionId ?? null;
  }
  return nextSessions.items.some((item) => item.sessionId === current)
    ? current
    : (nextSessions.items[0]?.sessionId ?? null);
}
/**
 * A conversation an address or a Messaging row may name: a mission conversation, or an external one a channel
 * carries. Any other external session (a delegated run's, say) stays unreachable by address.
 */
function isNameableSession(record: ChatSessionsResponse["items"][number]): boolean {
  return record.scope === "mission" || (record.scope === "external" && Boolean(record.channelConnectionId));
}
/** Returns the exact record only when it is a visible conversation of this workspace and history view. */
export function findScopedSidebarSession(
  exact: ChatSessionsResponse,
  requestedSessionId: string,
  workspaceId: string,
  nextHistoryView: ChatHistoryView,
): ChatSessionsResponse["items"][number] | null {
  const record = exact.items[0];
  if (
    exact.items.length !== 1 ||
    record?.sessionId !== requestedSessionId ||
    record.workspaceId !== workspaceId ||
    !isNameableSession(record) ||
    record.lifecycleStatus !== nextHistoryView ||
    record.includeInHistory === false
  ) {
    return null;
  }
  return record;
}
export function sidebarActivityReconcileKey(
  thread: ChatThreadResponse | null,
  sessions: ChatSessionsResponse | null,
  selectedSessionId: string | null,
  sidebarScopeKey: string,
): string | null {
  const latestThreadTurn =
    thread?.sessionId === selectedSessionId
      ? (thread.turns.find((turn) => turn.turnId === thread.activeLeafTurnId) ??
        thread.turns.filter((turn) => turn.branch?.isSelectedPath).at(-1))
      : undefined;
  const listedActivity = sessions?.items.find((item) => item.sessionId === selectedSessionId)?.activity?.latestTurn;
  return !latestThreadTurn ||
    !listedActivity ||
    latestThreadTurn.turnId !== listedActivity.turnId ||
    latestThreadTurn.trace.status === listedActivity.status
    ? null
    : JSON.stringify([
        sidebarScopeKey,
        selectedSessionId,
        latestThreadTurn.turnId,
        latestThreadTurn.trace.status,
        listedActivity?.status,
      ]);
}

export function chatViewRefreshPhase(
  phase: "plan_applied" | "plan_completed",
  sessionId: string | null,
  refreshSidebar: boolean,
  refreshSession: "none" | "light" | "full",
): Parameters<typeof recordChatRefreshPhase>[0] {
  return {
    phase,
    sessionId,
    signal: {
      eventType: "refresh_plan",
      reason: "chat-refresh-view-state",
      source: "useChatSessionData.refreshViewState",
    },
    plan: { refreshSidebar, refreshSession },
  };
}
export function sidebarLoadDiagnostic(
  workspaceId: string,
  historyView: ChatHistoryView,
  sessionLimit: number,
  append: boolean,
  surfaceMode: ChatMode | undefined,
): Parameters<typeof recordClientDiagnostic>[0] {
  return {
    level: "debug",
    category: "chat",
    event: "sidebar.load",
    message: "Refreshing chat sidebar data",
    context: { workspaceId, historyView, sessionLimit, append, surfaceMode: surfaceMode ?? null },
  };
}

export function sidebarMembershipIncomplete(response: ChatSessionsResponse, sessionIds: string[]): boolean {
  return (
    response.membership?.complete !== true ||
    JSON.stringify(response.membership.sessionIds) !== JSON.stringify(sessionIds) ||
    response.items.some((item) => !sessionIds.includes(item.sessionId))
  );
}
export function appendMissingSidebarSession(
  current: ChatSessionsResponse,
  requested: string,
  record: ChatSessionsResponse["items"][number],
): ChatSessionsResponse {
  return current.items.some((item) => item.sessionId === requested)
    ? current
    : { ...current, items: [...current.items, record] };
}
export function sidebarRefreshPriority(
  plan: NonNullable<Parameters<typeof recordChatRefreshPhase>[0]["plan"]>,
): number {
  return (plan.refreshSession === "full" ? 4 : plan.refreshSession === "light" ? 2 : 0) + Number(plan.refreshSidebar);
}
