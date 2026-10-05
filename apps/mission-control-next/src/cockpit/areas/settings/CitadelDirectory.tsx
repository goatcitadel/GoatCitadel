import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listCitadels } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCitadelEditor } from "../../../features/native-routes/settings/use-citadel-editor";
import { useDirectoryLifecycle } from "../../../features/native-routes/settings/use-directory-lifecycle";
import {
  hasCitadelRecord,
  type DirectoryLifecycleReview,
} from "../../../features/native-routes/settings/directory-lifecycle-binding";
import { Button } from "../../ui/Button";
import { CitadelMetadataEditor } from "./CitadelMetadataEditor";
import { CitadelGovernanceLink } from "./CitadelGovernanceLink";
import { DirectoryLifecycleReview as LifecycleReview } from "./DirectoryLifecycleReview";
const PAGE_SIZE = 20;

export function CitadelDirectory({ activeCitadelId }: { activeCitadelId: string }) {
  const { setActiveCitadelId } = useUiPreferences();
  const query = useQuery({ queryKey: ["settings", "citadels", "all"], queryFn: () => listCitadels("all", 500) });
  const [selectedId, setSelectedId] = useState("");
  const [mode, setMode] = useState<"create" | "edit" | null>(null);
  const [search, setSearch] = useState(""),
    [limit, setLimit] = useState(PAGE_SIZE);
  const [filter, setFilter] = useState<"all" | "active" | "archived">("all");
  const rows = query.data?.items;
  const ready =
    !query.isError &&
    Array.isArray(rows) &&
    rows.every(hasCitadelRecord) &&
    new Set(rows.map((row) => row.citadelId)).size === rows.length;
  const available = ready && !query.isFetching,
    records = ready ? rows! : [];
  const selected = records.find((item) => item.citadelId === selectedId) ?? null;
  const editor = useCitadelEditor({
    ownerKey: activeCitadelId,
    selectedId,
    selected,
    mode,
    available,
    reload: () => query.refetch(),
    onCreated: (created) => {
      setSelectedId(created.citadelId);
      setMode("edit");
    },
  });
  const lifecycle = useDirectoryLifecycle({
    ownerKey: activeCitadelId,
    available,
    reload: () => query.refetch(),
    onConfirmed: (review) => {
      if (review.kind === "citadel" && review.record.citadelId === selectedId) setMode(null);
    },
  });
  const filtered = records.filter(
    (item) =>
      (filter === "all" || item.lifecycleStatus === filter) &&
      [item.name, item.slug, item.description, item.kind].join(" ").toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section
      id="citadel-directory"
      aria-label="Citadel directory"
      className="mt-4 space-y-4 border-t border-line-subtle pt-4"
    >
      <header>
        <h3 className="font-display text-md font-semibold text-fg">Citadel directory</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Organize separate operating spaces. Create, edit, archive, or restore their directory records.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!available || editor.locked} onClick={() => setMode("create")}>
          New Citadel
        </Button>
        <Button
          size="sm"
          disabled={query.isFetching || editor.pending || lifecycle.pending}
          onClick={() => void query.refetch()}
        >
          Refresh Citadels
        </Button>
      </div>
      {query.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading Citadel directory…
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          Citadel directory unavailable: {describeApiError(query.error).summary}
        </p>
      ) : !query.isLoading && !ready ? (
        <p role="alert" className="text-sm text-status-failed">
          Citadel record evidence is unavailable. Refresh before editing.
        </p>
      ) : null}
      {mode ? (
        <CitadelMetadataEditor
          editor={editor}
          mode={mode}
          selected={selected}
          available={available}
          onClose={() => setMode(null)}
        />
      ) : null}
      {editor.notice ? (
        <p role={editor.uncertain ? "alert" : "status"} className="text-sm text-fg-secondary">
          {editor.notice}
        </p>
      ) : null}
      {lifecycle.notice ? (
        <p role="status" className="text-sm text-fg-secondary">
          {lifecycle.notice}
        </p>
      ) : null}
      {ready ? (
        <>
          <label className="block text-sm text-fg-secondary">
            Search Citadels
            <input
              type="search"
              className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(PAGE_SIZE);
              }}
            />
          </label>
          <label className="block text-sm text-fg-secondary">
            Citadel lifecycle view
            <select
              className="mt-1 block min-h-10 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value as typeof filter);
                setLimit(PAGE_SIZE);
              }}
            >
              <option value="all">All Citadels</option>
              <option value="active">Active Citadels</option>
              <option value="archived">Archived Citadels</option>
            </select>
          </label>
          <p className="text-xs text-fg-muted">
            Showing {Math.min(limit, filtered.length)} of {filtered.length} loaded Citadels
            {records.length === 500 ? " · Directory limited to 500 records" : ""}.
          </p>
          <ul className="space-y-2">
            {filtered.slice(0, limit).map((record) => {
              const target: DirectoryLifecycleReview = {
                kind: "citadel",
                record,
                action: record.lifecycleStatus === "active" ? "archive" : "restore",
              };
              const locked = lifecycle.locked(target),
                attempt = lifecycle.attempt(target);
              return (
                <li key={record.citadelId} className="space-y-2 rounded-md border border-line-subtle bg-sunken p-3">
                  <h4 className="break-words text-sm font-semibold text-fg">{record.name}</h4>
                  <p className="text-xs text-fg-muted">
                    {record.lifecycleStatus === "active" ? "Active" : "Archived"} · {record.kind}
                    {record.citadelId === activeCitadelId ? " · Current Citadel" : ""}
                  </p>
                  <p className="break-words text-sm text-fg-secondary">{record.description || "No description"}</p>
                  <details className="text-xs text-fg-muted">
                    <summary className="cursor-pointer text-fg-secondary">Saved directory record</summary>
                    <dl className="mt-2 space-y-1">
                      <dt>Citadel ID</dt>
                      <dd className="break-all font-mono">{record.citadelId}</dd>
                      <dt>Slug</dt>
                      <dd className="break-all">{record.slug}</dd>
                      <dt>Revision</dt>
                      <dd className="break-all font-mono">{record.revision}</dd>
                      <dt>Default workspace</dt>
                      <dd className="break-all">{record.defaultWorkspaceId || "None saved"}</dd>
                    </dl>
                  </details>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={!available || locked}
                      aria-label={`Edit Citadel ${record.name}`}
                      onClick={() => {
                        setSelectedId(record.citadelId);
                        setMode("edit");
                      }}
                    >
                      Edit metadata
                    </Button>
                    <Button
                      size="sm"
                      variant={target.action === "archive" ? "danger" : "secondary"}
                      disabled={!available || locked}
                      aria-label={`${target.action === "archive" ? "Archive" : "Restore"} Citadel ${record.name}`}
                      onClick={() => lifecycle.request(target)}
                    >
                      {target.action === "archive" ? "Archive" : "Restore"}
                    </Button>
                    <Button
                      size="sm"
                      disabled={
                        !available ||
                        locked ||
                        record.lifecycleStatus !== "active" ||
                        record.citadelId === activeCitadelId
                      }
                      aria-label={`Make active Citadel ${record.name}`}
                      onClick={() => setActiveCitadelId(record.citadelId)}
                    >
                      Make active
                    </Button>
                  </div>
                  {locked && attempt.message ? (
                    <p
                      role={attempt.phase === "uncertain" ? "alert" : "status"}
                      className="text-sm text-status-waiting"
                    >
                      {attempt.message}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {!filtered.length ? <p className="text-sm text-fg-muted">No Citadels match this view.</p> : null}
          {filtered.length > limit ? (
            <Button size="sm" onClick={() => setLimit((count) => count + PAGE_SIZE)}>
              Show more Citadels
            </Button>
          ) : null}
        </>
      ) : null}
      <p className="text-xs text-fg-muted">
        Charters, blueprints, membership, wards, and other governance controls are available in the Citadel workspace.
      </p>
      <CitadelGovernanceLink key={activeCitadelId} activeCitadelId={activeCitadelId} />
      <LifecycleReview lifecycle={lifecycle} />
    </section>
  );
}
