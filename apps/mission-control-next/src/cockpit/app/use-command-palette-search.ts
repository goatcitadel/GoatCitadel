import { useEffect, useRef, useState } from "react";
import { useQuery, type Query, type UseQueryResult } from "@tanstack/react-query";
import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchOperatorInbox } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import { loadCapabilityCatalog } from "../areas/library/capability-catalog";
import { RESOURCE_KINDS } from "../areas/library/library-resources";
import { queryKeys } from "../data/query-keys";
import {
  assertPaletteWorkspace,
  paletteGroup,
  searchCapabilities,
  searchInbox,
  searchLibrary,
  searchThreads,
  type PaletteScope,
  type PaletteSearchGroup,
  type PaletteSourceResult,
} from "./command-palette-search";

export const PALETTE_SEARCH_DEBOUNCE_MS = 300;
const SEARCH_STALE_MS = 30_000;
type SourceRead = (scope: PaletteScope, text: string, signal?: AbortSignal) => Promise<PaletteSourceResult>;
const LIBRARY_SOURCES = RESOURCE_KINDS.map((kind) => ({
  id: kind,
  label: `Library ${kind}`,
  read: searchLibrary(kind),
}));

/**
 * One source's cached, cancellable read for the settled text. Each source has its own `useQuery`:
 * `useQueries` builds a new observer when a key changes, which would drop the earlier wave.
 */
function useSourceRead(id: string, read: SourceRead, scope: PaletteScope, text: string, enabled: boolean) {
  const { workspaceId, citadelId } = scope;
  return useQuery<PaletteSourceResult>({
    queryKey: ["palette", id, workspaceId, citadelId, text],
    queryFn: ({ signal }) => read({ workspaceId, citadelId }, text, signal),
    // Keep the previous wave on screen, but never across a workspace or Citadel change.
    placeholderData: (previous: PaletteSourceResult | undefined, previousQuery?: Query<PaletteSourceResult>) =>
      previousQuery?.queryKey[2] === workspaceId && previousQuery.queryKey[3] === citadelId ? previous : undefined,
    staleTime: SEARCH_STALE_MS,
    enabled,
  });
}

/** Debounce the typed text, not the queries: each settled text is one wave of cached, cancellable reads. */
function useSettledText(text: string): string {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(text), PALETTE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);
  return settled;
}

/** A number that changes each time the palette opens, so the workspace check runs once per open. */
function useOpening(open: boolean): number {
  const opening = useRef({ open, count: 0 });
  if (open && !opening.current.open) opening.current = { open, count: opening.current.count + 1 };
  else if (!open) opening.current.open = false;
  return opening.current.count;
}

function groupFromRead(id: string, label: string, read: UseQueryResult<PaletteSourceResult>): PaletteSearchGroup {
  if (read.data) {
    const group = paletteGroup(id, label, { result: read.data });
    return read.isError ? { ...group, error: describeApiError(read.error).summary } : group;
  }
  if (read.isError) return paletteGroup(id, label, { error: read.error });
  return { id, label, items: [], coverage: "", searching: true };
}

function groupFromCache(id: string, label: string, search: () => PaletteSourceResult): PaletteSearchGroup {
  try {
    return paletteGroup(id, label, { result: search() });
  } catch (error) {
    return paletteGroup(id, label, { error });
  }
}

/**
 * NV-12: one cached query per source keyed on the settled text, so a newer keystroke cancels the older
 * reads and the earlier results stay until the new ones arrive. The Inbox and capability groups filter
 * what the cockpit already holds. Nothing is shown until this opening has verified the workspace.
 */
export function useCommandPaletteSearch(open: boolean, scope: PaletteScope, query: string) {
  const typed = open ? query.trim().slice(0, 200) : "";
  const text = useSettledText(typed);
  const opening = useOpening(open);
  const { workspaceId, citadelId } = scope;
  const check = useQuery({
    queryKey: ["palette", "workspace-check", workspaceId, citadelId, opening],
    queryFn: async ({ signal }) => {
      await assertPaletteWorkspace({ workspaceId, citadelId }, signal);
      return true;
    },
    enabled: open,
    staleTime: Infinity,
    gcTime: 0,
  });
  const verified = check.isSuccess;
  const enabled = open && text.length >= 2 && verified;
  const threads = useSourceRead("threads", searchThreads, scope, text, enabled);
  const library = [
    useSourceRead(LIBRARY_SOURCES[0]!.id, LIBRARY_SOURCES[0]!.read, scope, text, enabled),
    useSourceRead(LIBRARY_SOURCES[1]!.id, LIBRARY_SOURCES[1]!.read, scope, text, enabled),
    useSourceRead(LIBRARY_SOURCES[2]!.id, LIBRARY_SOURCES[2]!.read, scope, text, enabled),
    useSourceRead(LIBRARY_SOURCES[3]!.id, LIBRARY_SOURCES[3]!.read, scope, text, enabled),
  ];
  const inbox = useQuery<OperatorInboxResponse>({
    queryKey: queryKeys.inbox(workspaceId),
    queryFn: () => fetchOperatorInbox(workspaceId),
    enabled: false,
  }).data;
  // The cached catalog; it is read only if nothing has cached it yet.
  const catalog = useQuery({
    queryKey: queryKeys.capabilities(),
    queryFn: loadCapabilityCatalog,
    enabled,
    staleTime: Infinity,
  });
  const visible = open && text.length >= 2 && verified;
  const groups: PaletteSearchGroup[] = visible
    ? [
        groupFromRead("threads", "Conversations", threads),
        inbox
          ? groupFromCache("inbox", "Inbox", () => searchInbox(inbox, scope, text))
          : paletteGroup("inbox", "Inbox", {
              error: new Error("The Inbox has not been read yet. Open Inbox to read it."),
            }),
        catalog.data
          ? groupFromCache("capabilities", "Library capabilities", () => searchCapabilities(catalog.data, text))
          : catalog.isError
            ? paletteGroup("capabilities", "Library capabilities", { error: catalog.error })
            : { id: "capabilities", label: "Library capabilities", items: [], coverage: "", searching: true },
        ...LIBRARY_SOURCES.map((source, index) => groupFromRead(source.id, source.label, library[index]!)),
      ]
    : [];
  const pendingText = typed.length >= 2 && typed !== text;
  // Earlier results stay on screen while a newer wave is read; say a search is still running.
  const refreshing = [threads, ...library].some((read) => read.isPlaceholderData);
  return {
    groups,
    error: check.isError ? describeApiError(check.error).summary : undefined,
    loading:
      open &&
      typed.length >= 2 &&
      (check.isPending || pendingText || refreshing || groups.some((group) => group.searching)),
  };
}
