import type { McpServerRecord, McpServerTemplateRecord, SkillListItem } from "@goatcitadel/contracts";
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
  if (!SHOULD_REUSE_DEV_BOOTSTRAP_FETCHES || options.bypassCache) {
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
  // Only cache successful results: evict the entry immediately on rejection so a single
  // transient failure is not replayed from cache for the whole TTL window (which made the
  // sidebar/runtime catalog appear broken until the entry expired). `promise` itself still
  // rejects for the caller.
  promise.then(
    () => {
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
    expiresAt: now + DEV_BOOTSTRAP_CACHE_TTL_MS,
  });
  return promise;
}
