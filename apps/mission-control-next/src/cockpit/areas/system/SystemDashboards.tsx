import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { fetchOpsSavedBoard, fetchOpsSavedBoards } from "@goatcitadel/mission-control-shared/api/ops-saved-boards";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../data/query-keys";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { SystemDashboardWidget } from "./SystemDashboardWidget";
import { CockpitBoardEditor } from "./CockpitBoardEditor";
import { BoardLifecycle } from "./BoardLifecycle";
import { BoardDetails } from "./BoardDetails";
import { useBoardMutationState } from "../../../features/native-routes/ops/board-mutation-state";
import "./system-dashboard.css";

export function SystemDashboards() {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const { rest, search, navigate } = useCockpitRoute();
  if (rest[1]) {
    try { return <BoardDetail key={`${workspaceId}:${rest[1]}`} workspaceId={workspaceId} boardId={decodeURIComponent(rest[1])} navigate={navigate} />; }
    catch { return <EmptyState title="Board link unavailable" description="This saved-board link could not be read." />; }
  }
  const includeArchived = new URLSearchParams(search).get("archived") === "1";
  return <BoardIndex key={workspaceId} workspaceId={workspaceId} includeArchived={includeArchived} navigate={navigate} />;
}

function BoardIndex({ workspaceId, includeArchived, navigate }: {
  workspaceId: string; includeArchived: boolean; navigate: ReturnType<typeof useCockpitRoute>["navigate"];
}) {
  const [creating, setCreating] = useState(false);
  const boards = useQuery({ queryKey: includeArchived ? [...queryKeys.systemBoards(workspaceId), "archived"] : queryKeys.systemBoards(workspaceId),
    queryFn: () => fetchOpsSavedBoards(includeArchived ? { workspaceId, includeArchived: true } : { workspaceId }), refetchOnMount: "always",
    refetchInterval: (query) => describeApiError(query.state.error).retryable === false ? false : 60_000 });
  const access = describeApiError(boards.error);
  const writable = boards.isSuccess && boards.isFetchedAfterMount && !boards.isFetching && !boards.isPlaceholderData && Boolean(boards.data);
  return <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="font-display text-xl font-semibold text-fg">Dashboards</h1>
        <p className="text-sm text-fg-secondary">Saved boards for this workspace.</p>
        <p className="mt-1 text-xs text-fg-muted">Open a board for live Gateway-backed widgets or create a saved layout.</p>
      </div>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={boards.isFetching || (boards.isError && access.retryable === false)} onClick={() => void boards.refetch()}><RefreshCw aria-hidden="true" className="size-4" /> Refresh</Button>
        <Button size="sm" variant="primary" disabled={!writable} onClick={() => setCreating(true)}>New board</Button></div>
    </header>
    <label className="flex min-h-11 items-center gap-2 text-sm text-fg-secondary">
      <input type="checkbox" className="size-4" checked={includeArchived}
        onChange={(event) => navigate(event.target.checked ? "/system/dashboards?archived=1" : "/system/dashboards", { replace: true })} />
      Show archived boards
    </label>
    {creating ? <CockpitBoardEditor key={workspaceId} workspaceId={workspaceId} accessAvailable={writable} onClose={() => setCreating(false)}
      onSaved={(saved) => { setCreating(false); navigate(`/system/dashboards/${encodeURIComponent(saved.boardId)}`); }} /> : null}
    {boards.isLoading ? <p role="status" className="text-sm text-fg-muted">Loading saved boards…</p> : null}
    {boards.isError ? <EmptyState title="Dashboards unavailable" description={access.summary} action={<BoardReadRecovery error={boards.error} retry={() => void boards.refetch()} navigate={navigate} />} /> : null}
    {boards.data && !boards.isError ? boards.data.items.length ? <ul className="grid gap-3 sm:grid-cols-2">{boards.data.items.map((board) => <li key={board.boardId} className="rounded-lg border border-line bg-raised p-4">
      <h2 className="text-sm font-semibold text-fg">{board.name}{board.status === "archived" ? <span className="ml-2 rounded-full border border-line px-2 py-0.5 text-xs font-normal text-fg-secondary">Archived</span> : null}</h2>
      {board.description ? <p className="mt-1 text-sm text-fg-secondary">{board.description}</p> : null}
      <p className="mt-2 text-xs text-fg-muted">{board.placements.length} {board.placements.length === 1 ? "widget" : "widgets"}</p>
      <ul className="mt-2 flex flex-wrap gap-1">{board.placements.map((placement) => <li key={placement.widgetId} className="rounded-full border border-line px-2 py-0.5 text-xs text-fg-secondary">{humanizeToken(placement.kind)}</li>)}</ul>
      <a href={`/system/dashboards/${encodeURIComponent(board.boardId)}`} onClick={(event) => { event.preventDefault(); navigate(`/system/dashboards/${encodeURIComponent(board.boardId)}`); }}
        className="mt-3 inline-block text-sm font-medium text-accent hover:underline">Open board</a>
    </li>)}</ul> : <EmptyState title="No saved boards returned" description="Create a board to save a custom layout for this workspace." /> : null}
  </section>;
}

function BoardDetail({ workspaceId, boardId, navigate }: {
  workspaceId: string; boardId: string; navigate: ReturnType<typeof useCockpitRoute>["navigate"];
}) {
  const [editing, setEditing] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string>();
  const client = useQueryClient();
  const board = useQuery({ queryKey: ["surface", "saved-board", workspaceId, boardId],
    queryFn: () => fetchOpsSavedBoard(workspaceId, boardId), refetchOnMount: "always",
    refetchInterval: (query) => describeApiError(query.state.error).retryable === false ? false : 60_000 });
  const mutation = useBoardMutationState(workspaceId, boardId);
  const writable = board.isSuccess && board.isFetchedAfterMount && !board.isFetching && !board.isPlaceholderData && mutation.phase === "idle";
  const record = board.data;
  const detailKey = ["surface", "saved-board", workspaceId, boardId];
  const placements = record?.placements.slice().sort((left, right) => left.y - right.y || left.x - right.x) ?? [];
  return <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
    <a href="/system/dashboards" onClick={(event) => { event.preventDefault(); navigate("/system/dashboards"); }} className="inline-flex items-center gap-2 text-sm font-medium text-accent">
      <ArrowLeft aria-hidden="true" className="size-4" />Back to Dashboards
    </a>
    {board.isLoading ? <p role="status" className="text-sm text-fg-muted">Loading saved board…</p> : null}
    {board.isError ? <EmptyState title="Board unavailable" description={describeApiError(board.error).summary} action={<BoardReadRecovery error={board.error} retry={() => void board.refetch()} navigate={navigate} />} /> : null}
    {editing && record?.status === "active" ? <CockpitBoardEditor key={`${workspaceId}:${boardId}`} workspaceId={workspaceId} board={record} accessAvailable={writable}
      onClose={() => setEditing(false)} onSaved={() => setEditing(false)} onConfirmed={(saved) => { client.setQueryData(["surface", "saved-board", workspaceId, boardId], saved); setSavedMessage(`Board saved and confirmed at revision ${saved.revision}.`); setEditing(false); }} /> : null}
    {savedMessage ? <p role="status" className="rounded-md border border-line bg-sunken p-3 text-sm text-fg">{savedMessage}</p> : null}
    {record && !board.isError ? <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="font-display text-xl font-semibold text-fg">{record.name}</h1>
          {record.description ? <p className="mt-1 text-sm text-fg-secondary">{record.description}</p> : null}
          <p className="mt-1 text-xs text-fg-muted">Saved layout revision {record.revision} · {record.status}. Desktop follows saved positions; phone stacks widgets. Values read current owner APIs and are not historical snapshots.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">{/* Opening the editor writes nothing; saving stays gated on a fresh read (accessAvailable). */}
          {record.status === "active" ? <Button size="sm" variant="primary" disabled={!board.isSuccess || mutation.phase !== "idle"} onClick={() => setEditing(true)}>Edit layout</Button> : null}
          {editing ? null : <BoardLifecycle board={record}
            onSettled={(saved, message) => { client.setQueryData(detailKey, saved); void client.invalidateQueries({ queryKey: queryKeys.systemBoards(workspaceId) }); setSavedMessage(message); }}
            onConflict={(current) => { if (current) client.setQueryData(detailKey, current); else void board.refetch(); }} />}
          <ClassicOwnerLink href="/ops/boards?shell=classic" className="text-sm font-medium text-accent hover:underline" scope={JSON.stringify([workspaceId, boardId])} label="Advanced board controls in Ops" /></div>
      </header>
      <BoardDetails board={record} />
      <div role="region" aria-label={`${record.name} widget grid`} className="cockpit-saved-board-grid">{placements.map((placement) => <div key={placement.widgetId}
        className="cockpit-saved-board-placement" style={{ "--board-column-start": placement.x + 1,
          "--board-column-span": placement.width, "--board-row-start": placement.y + 1,
          "--board-row-span": placement.height } as CSSProperties}>
        <SystemDashboardWidget kind={placement.kind} workspaceId={workspaceId} />
      </div>)}</div>
    </> : null}
  </section>;
}

function BoardReadRecovery({ error, retry, navigate }: { error: unknown; retry: () => void; navigate: ReturnType<typeof useCockpitRoute>["navigate"] }) {
  const description = describeApiError(error);
  if (description.category === "authentication" || description.category === "permission") return <a
    href="/settings/access#device-access" className="text-sm text-accent hover:underline"
    onClick={(event) => { event.preventDefault(); navigate("/settings/access#device-access"); }}>Review Gateway access</a>;
  return description.retryable === false ? null : <Button onClick={retry}>Try again</Button>;
}
