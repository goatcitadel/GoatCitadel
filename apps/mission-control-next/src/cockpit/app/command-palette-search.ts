import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import { fetchChatSessionSearch } from "@goatcitadel/mission-control-shared/api/chat";
import { fetchWorkspaces } from "@goatcitadel/mission-control-shared/api/workspaces";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { presentCapabilityTitle } from "@goatcitadel/mission-control-shared/content/capability-rows";
import { inboxMatchesWorkspace, inboxKnownCount, inboxItemKindLabel } from "../areas/inbox/inbox-presentation";
import { filterCapabilities, type CapabilityCatalogView } from "../areas/library/capability-catalog";
import { catalogHref } from "../areas/library/capability-catalog-route";
import {
  loadLibraryResources,
  resourceId,
  resourceTitle,
  resourceDescription,
  type LibraryResource,
  type ResourceKind,
} from "../areas/library/library-resources";

export interface PaletteScope {
  workspaceId: string;
  citadelId: string;
}
export interface PaletteObject {
  id: string;
  label: string;
  description: string;
  target: { href: string } | { resource: LibraryResource };
}
export interface PaletteSearchGroup {
  id: string;
  label: string;
  items: PaletteObject[];
  coverage: string;
  error?: string;
  /** This source has not answered the current search yet and has nothing earlier to show. */
  searching?: boolean;
}
/** What one source found, before the palette bounds it. */
export type PaletteSourceResult = Pick<PaletteSearchGroup, "items" | "coverage">;
export const PALETTE_GROUP_LIMIT = 5;

export async function assertPaletteWorkspace(scope: PaletteScope, signal?: AbortSignal): Promise<void> {
  if (!scope.workspaceId.trim() || !scope.citadelId.trim()) throw new Error("Choose a workspace and Citadel first.");
  const response = await fetchWorkspaces("active", 500, scope.citadelId, {
    signal: signal ?? new AbortController().signal,
  });
  const workspace = response.items.find((item) => item.workspaceId === scope.workspaceId);
  if (!workspace || workspace.citadelId !== scope.citadelId || workspace.lifecycleStatus !== "active") {
    throw new Error(
      "The selected workspace could not be verified in this Citadel. Choose an active workspace before continuing.",
    );
  }
}

/** Search evidence is never action authority. Every result opens its existing owner. */
export async function searchThreads(
  scope: PaletteScope,
  text: string,
  signal?: AbortSignal,
): Promise<PaletteSourceResult> {
  const result = await fetchChatSessionSearch(
    {
      query: text,
      mode: "discovery",
      view: "all",
      ...scope,
      surface: "chat",
      limit: 10,
      includeHidden: false,
    },
    { signal },
  );
  if (result.query !== text) throw new Error("The conversation search response does not match this query.");
  const scoped = result.items.filter(
    ({ session }) =>
      session.workspaceId === scope.workspaceId && session.scope === "mission" && session.includeInHistory,
  );
  return {
    items: scoped.map(({ session, hits }) => ({
      id: session.sessionId,
      label: session.title || "Untitled conversation",
      description: `${session.lifecycleStatus === "archived" ? "Archived" : "Workspace conversation"}${hits.length ? " · Matching conversation content" : ""}`,
      target: { href: `/chat?${new URLSearchParams({ shell: "cockpit", sessionId: session.sessionId })}` },
    })),
    coverage: `Up to 10 Gateway search matches, including archived conversations.${result.nextCursor ? " More matches are available in Chat." : ""}${scoped.length !== result.items.length ? " Records outside this workspace were withheld." : ""}`,
  };
}

/** Filters the Inbox the cockpit already keeps; it never reads the Inbox itself. */
export function searchInbox(result: OperatorInboxResponse, scope: PaletteScope, text: string): PaletteSourceResult {
  if (!inboxMatchesWorkspace(result, scope.workspaceId))
    throw new Error("The Inbox projection does not match this workspace.");
  const count = inboxKnownCount(result);
  const hasReadGap = result.coverage.some((source) => source.state === "partial" || source.state === "unavailable");
  const hasDefinedLimit = result.coverage.some((source) => source.state === "limited");
  return {
    items: result.items
      .filter((item) => `${item.title} ${item.summary}`.toLocaleLowerCase().includes(text.toLocaleLowerCase()))
      .map((item) => ({
        id: item.id,
        label: item.title,
        description: `${inboxItemKindLabel(item.kind)} · Review the current owner before acting`,
        target: {
          href: `/inbox?${new URLSearchParams({ shell: "cockpit", workspaceId: scope.workspaceId, item: item.id })}`,
        },
      })),
    coverage: `${count.known} known workspace items. ${
      count.complete
        ? "Current projection; resolved items may disappear."
        : hasReadGap || !hasDefinedLimit
          ? "Coverage is incomplete; more items may be missing."
          : "Inbox has a defined scope; other work stays in its owner."
    }`,
  };
}

/** Filters the installation capability catalog the cockpit already caches. */
export function searchCapabilities(catalog: CapabilityCatalogView, text: string): PaletteSourceResult {
  const filters = { search: text, kind: "all", status: "all" as const, trust: "all" };
  return {
    items: filterCapabilities(catalog.items, filters).map((item) => ({
      id: `${item.kind}:${item.capabilityId}`,
      label: presentCapabilityTitle(item),
      description: `${item.kind} · Installation catalog; availability is reviewed in Library`,
      target: { href: catalogHref(filters, item) },
    })),
    coverage: [
      "Installation catalog, shared across workspaces. Search does not grant tool or skill access.",
      ...catalog.issues,
    ].join(" "),
  };
}

export function searchLibrary(kind: ResourceKind) {
  return async (scope: PaletteScope, text: string, signal?: AbortSignal): Promise<PaletteSourceResult> => {
    const page = await loadLibraryResources({ ...scope, kind, query: text, status: "active", signal });
    return {
      items: page.items.map((resource) => ({
        id: resourceId(resource),
        label: resourceTitle(resource),
        description: resourceDescription(resource),
        target: { resource },
      })),
      coverage: page.coverage,
    };
  };
}

/** One bounded group, or the source's failure: unavailable is never shown as empty. */
export function paletteGroup(
  id: string,
  label: string,
  outcome: { result: PaletteSourceResult } | { error: unknown },
): PaletteSearchGroup {
  if ("error" in outcome)
    return {
      id,
      label,
      items: [],
      coverage: "This source is unavailable, not empty.",
      error: describeApiError(outcome.error).summary,
    };
  return {
    id,
    label,
    ...outcome.result,
    items: outcome.result.items.slice(0, PALETTE_GROUP_LIMIT),
    coverage: `${outcome.result.coverage} Showing up to ${PALETTE_GROUP_LIMIT} matches here; narrow the search or open the area for more.`,
  };
}
