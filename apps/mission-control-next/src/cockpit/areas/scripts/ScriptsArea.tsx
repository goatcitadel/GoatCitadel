import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScriptInventoryItem } from "@goatcitadel/contracts";
import {
  fetchScripts,
  fetchScriptPreview,
  updateScriptRetention,
} from "@goatcitadel/mission-control-shared/api/scripts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_COLUMN, AREA_PAGE } from "../../ui/area-layout";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { Sheet } from "../../ui/Sheet";
import { TimeText } from "../../ui/TimeText";
import { ScriptRunDetail } from "./ScriptRunDetail";

const labels: Record<ScriptInventoryItem["kind"], string> = {
  generated: "Chat artifact",
  managed: "Managed project file",
  workspace: "Created file",
  tool: "Tool output",
  code: "Code Mode source",
};
export function ScriptsArea() {
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const access = useProjectAccess(JSON.stringify([workspaceId, activeCitadelId]));
  return (
    <ScriptsDirectory
      key={JSON.stringify([workspaceId, access.identity])}
      workspaceId={workspaceId}
      citadelId={activeCitadelId ?? "personal"}
      current={access.current}
      identity={access.identity}
    />
  );
}
function ScriptsDirectory({
  workspaceId,
  citadelId,
  current,
  identity,
}: {
  workspaceId: string;
  citadelId: string;
  current: () => boolean;
  identity: string;
}) {
  const client = useQueryClient();
  const key = ["scripts", workspaceId, identity];
  const inventory = useQuery({ queryKey: key, queryFn: ({ signal }) => fetchScripts(workspaceId, signal) });
  const [search, setSearch] = useState("");
  const [retention, setRetention] = useState("all");
  const [kind, setKind] = useState("all");
  const [visibleLimit, setVisibleLimit] = useState(100);
  const [selected, setSelected] = useState<ScriptInventoryItem>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const change = useMutation({
    mutationFn: async (item: ScriptInventoryItem) => {
      if (!current()) throw new Error("Workspace access changed. Reopen Scripts.");
      return updateScriptRetention({
        workspaceId,
        id: item.id,
        retention: item.retention === "permanent" ? "temporary" : "permanent",
        expectedVersion: item.retentionVersion,
      });
    },
    onSuccess: (item) => {
      if (!current()) return;
      setNotice(`${item.title} marked ${item.retention}. No files were removed.`);
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const items =
    inventory.data?.items.filter(
      (item) =>
        (retention === "all" || item.retention === retention) &&
        (kind === "all" || item.kind === kind) &&
        `${item.title} ${labels[item.kind]}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  const href = (path: string, item: ScriptInventoryItem) =>
    path +
    "?" +
    new URLSearchParams({
      workspaceId,
      citadelId,
      ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      ...(item.turnId ? { turnId: item.turnId } : {}),
      ...(item.projectId ? { projectId: item.projectId } : {}),
      ...(item.runId ? { runId: item.runId } : {}),
    });
  return (
    <div className={AREA_COLUMN}>
      <section className={AREA_PAGE} aria-label="Scripts">
        <AreaHeader
          title="Scripts"
          description="Files and artifacts created in this workspace, with their sources and retention."
          actions={
            <Button size="sm" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}>
              Refresh
            </Button>
          }
        />
        <p className="text-sm text-fg-secondary">
          Temporary items have no automatic expiration. Changing retention does not delete files or change execution
          records.
        </p>
        <div role="status" className="text-sm text-fg-secondary">
          {inventory.isPending ? <p>Loading Scripts…</p> : null}
          {inventory.isError ? (
            <p>
              {describeApiError(inventory.error).summary}{" "}
              {inventory.data ? "Showing the last loaded list." : "Use Refresh to try again."}
            </p>
          ) : null}
          {change.isPending ? <p>Saving retention…</p> : notice ? <p>{notice}</p> : null}
          {change.isError ? <p>{describeApiError(change.error).summary} Refresh Scripts before trying again.</p> : null}
        </div>
        {inventory.data?.items.length ? (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-0 flex-1 basis-full text-sm sm:basis-64">
                Search Scripts
                <input
                  type="search"
                  value={search}
                  maxLength={200}
                  onChange={(event) => setSearch(event.target.value)}
                  className="mt-1 block min-h-10 w-full rounded-md border border-line-control bg-raised px-3 text-fg"
                />
              </label>
              <label className="text-sm">
                Retention
                <select
                  aria-label="Retention"
                  value={retention}
                  onChange={(event) => setRetention(event.target.value)}
                  className="mt-1 block min-h-10 rounded-md border border-line-control bg-raised px-2 text-fg"
                >
                  <option value="all">All retention</option>
                  <option value="temporary">Temporary</option>
                  <option value="permanent">Permanent</option>
                </select>
              </label>
              <label className="text-sm">
                Created as
                <select
                  aria-label="Created as"
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                  className="mt-1 block min-h-10 rounded-md border border-line-control bg-raised px-2 text-fg"
                >
                  <option value="all">All types</option>
                  {Object.entries(labels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <ul className="divide-y divide-line-subtle">
              {items.slice(0, visibleLimit).map((item) => (
                <li key={item.id} className="grid min-w-0 gap-3 py-4">
                  <div>
                    <h2 className="break-words text-base font-semibold">{item.title}</h2>
                    <p className="text-sm text-fg-secondary">
                      {labels[item.kind]} · {item.retention === "temporary" ? "Temporary" : "Permanent"} · No scheduled
                      expiration
                    </p>
                    {item.createdAt ? (
                      <p className="text-xs text-fg-muted">
                        <TimeText prefix="Created" value={item.createdAt} />
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setSelected(item);
                        setRunOpen(false);
                        setPreviewOpen(true);
                      }}
                    >
                      Preview
                    </Button>
                    {item.sessionId ? (
                      <NativeOwnerLink href={href("/chat", item)} scope={`script-source-${item.id}`}>
                        Open source conversation
                      </NativeOwnerLink>
                    ) : item.projectId ? (
                      <NativeOwnerLink href={href("/projects", item)} scope={`script-project-${item.id}`}>
                        Open project
                      </NativeOwnerLink>
                    ) : null}
                    {item.runId ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          setSelected(item);
                          setRunOpen(true);
                          setPreviewOpen(true);
                        }}
                      >
                        Open run
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      disabled={change.isPending || inventory.isFetching}
                      onClick={() => {
                        setNotice("");
                        change.mutate(item);
                      }}
                      aria-label={`Mark ${item.retention === "permanent" ? "temporary" : "permanent"}: ${item.title}`}
                    >
                      Mark {item.retention === "permanent" ? "temporary" : "permanent"}
                    </Button>
                  </div>
                  {item.kind === "managed" && !item.sessionId ? (
                    <p className="text-xs text-fg-muted">
                      Source conversation not recorded for this version. Open the project to find its managed workspace.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            {items.length > visibleLimit ? (
              <div>
                <p className="text-sm text-fg-secondary">More matching records are available.</p>
                <Button onClick={() => setVisibleLimit((value) => value + 100)}>Show more scripts</Button>
              </div>
            ) : null}
            {!items.length ? (
              <EmptyState title="No matching scripts" description="Try another search or filter." />
            ) : null}
          </>
        ) : inventory.data ? (
          <EmptyState
            title="No scripts yet"
            description="Files and artifacts saved by Chat and agent runs will appear here."
          />
        ) : null}
        {inventory.data ? <p className="text-xs text-fg-muted">{inventory.data.coverage}</p> : null}
        <Sheet
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          title={runOpen ? "Source run" : (selected?.title ?? "Script preview")}
          sideOnDesktop
        >
          {selected ? (
            runOpen ? (
              <ScriptRunDetail key={selected.id} item={selected} identity={identity} current={current} />
            ) : (
              <ScriptPreview key={selected.id} item={selected} identity={identity} current={current} />
            )
          ) : null}
        </Sheet>
      </section>
    </div>
  );
}
function ScriptPreview({
  item,
  identity,
  current,
}: {
  item: ScriptInventoryItem;
  identity: string;
  current: () => boolean;
}) {
  const query = useQuery({
    queryKey: ["script-preview", item.workspaceId, identity, item.id, item.revision],
    queryFn: async ({ signal }) => {
      const value = await fetchScriptPreview(item.workspaceId, item.id, signal);
      if (!current()) throw new Error("Workspace access changed. Reopen Scripts.");
      return value;
    },
  });
  return (
    <div className="grid min-w-0 gap-3">
      <div role="status">
        {query.isPending ? <p>Loading preview…</p> : null}
        {query.isError ? <p>{describeApiError(query.error).summary}</p> : null}
      </div>
      {query.data && current() ? (
        <>
          <p className="text-sm text-fg-secondary">Read-only preview. Scripts are never executed here.</p>
          <pre className="max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-3 text-sm">
            {query.data.content}
          </pre>
          {query.data.truncated ? <p>Preview shortened.</p> : null}
        </>
      ) : null}
    </div>
  );
}
