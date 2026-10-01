import { fetchChatSessionSearch } from "@goatcitadel/mission-control-shared/api/chat";
import { fetchOperatorInbox } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import { fetchWorkspaces } from "@goatcitadel/mission-control-shared/api/workspaces";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { presentCapabilityTitle } from "@goatcitadel/mission-control-shared/content/capability-rows";
import { inboxMatchesWorkspace, inboxKnownCount, inboxItemKindLabel } from "../areas/inbox/inbox-presentation";
import { loadCapabilityCatalog, filterCapabilities } from "../areas/library/capability-catalog";
import { catalogHref } from "../areas/library/capability-catalog-route";
import {
  loadLibraryResources,
  RESOURCE_KINDS,
  resourceId,
  resourceTitle,
  resourceDescription,
  type LibraryResource,
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
}
export const PALETTE_GROUP_LIMIT = 5;

export async function assertPaletteWorkspace(scope: PaletteScope): Promise<void> {
  if (!scope.workspaceId.trim() || !scope.citadelId.trim()) throw new Error("Choose a workspace and Citadel first.");
  const response = await fetchWorkspaces("active", 500, scope.citadelId, { signal: new AbortController().signal });
  const workspace = response.items.find((item) => item.workspaceId === scope.workspaceId);
  if (!workspace || workspace.citadelId !== scope.citadelId || workspace.lifecycleStatus !== "active") {
    throw new Error(
      "The selected workspace could not be verified in this Citadel. Choose an active workspace before continuing.",
    );
  }
}

/** Search evidence is never action authority. Every result opens its existing owner. */
export async function searchPaletteObjects(scope: PaletteScope, query: string): Promise<PaletteSearchGroup[]> {
  await assertPaletteWorkspace(scope);
  const text = query.trim().slice(0, 200);
  if (!text) return [];
  const filters = { search: text, kind: "all", status: "all" as const, trust: "all" };
  const definitions: { id: string; label: string; read: () => Promise<Omit<PaletteSearchGroup, "id" | "label">> }[] = [
    {
      id: "threads",
      label: "Conversations",
      read: async () => {
        const result = await fetchChatSessionSearch({
          query: text,
          mode: "discovery",
          view: "all",
          ...scope,
          surface: "chat",
          limit: 10,
          includeHidden: false,
        });
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
      },
    },
    {
      id: "inbox",
      label: "Inbox",
      read: async () => {
        const result = await fetchOperatorInbox(scope.workspaceId);
        if (!inboxMatchesWorkspace(result, scope.workspaceId))
          throw new Error("The Inbox projection does not match this workspace.");
        const count = inboxKnownCount(result);
        const hasReadGap = result.coverage.some(
          (source) => source.state === "partial" || source.state === "unavailable",
        );
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
      },
    },
    {
      id: "capabilities",
      label: "Library capabilities",
      read: async () => {
        const catalog = await loadCapabilityCatalog();
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
      },
    },
    ...RESOURCE_KINDS.map((kind) => ({
      id: kind,
      label: `Library ${kind}`,
      read: async () => {
        const page = await loadLibraryResources({ ...scope, kind, query: text, status: "active" });
        return {
          items: page.items.map((resource) => ({
            id: resourceId(resource),
            label: resourceTitle(resource),
            description: resourceDescription(resource),
            target: { resource },
          })),
          coverage: page.coverage,
        };
      },
    })),
  ];
  const settled = await Promise.allSettled(definitions.map(({ read }) => read()));
  return settled.map((result, index) => {
    const { id, label } = definitions[index]!;
    if (result.status === "rejected")
      return {
        id,
        label,
        items: [],
        coverage: "This source is unavailable, not empty.",
        error: describeApiError(result.reason).summary,
      };
    return {
      id,
      label,
      ...result.value,
      items: result.value.items.slice(0, PALETTE_GROUP_LIMIT),
      coverage: `${result.value.coverage} Showing up to ${PALETTE_GROUP_LIMIT} matches here; narrow the search or open the area for more.`,
    };
  });
}
