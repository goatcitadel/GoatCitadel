import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ImportedAgentCatalogLifecycleStatus,
  ImportedAgentCatalogRecord,
  RichAgentParseSupportStatus,
} from "@goatcitadel/contracts";
import ReactMarkdown from "react-markdown";
import {
  activateImportedAgentCatalogEntry,
  fetchImportedAgentCatalog,
  importAgencyAgentCatalog,
  patchImportedAgentCatalogState,
} from "../api/client";
import { DataToolbar } from "../components/DataToolbar";
import { OperatorSplitLayout } from "../components/OperatorSplitLayout";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { GCSelect, Input } from "../components/ui";
import { GCEmptyState } from "../components/ui/GCEmptyState";
import { buildRouteSearch } from "../content/page-registry";

const STATE_OPTIONS: Array<{ value: ImportedAgentCatalogLifecycleStatus | "all"; label: string }> = [
  { value: "all", label: "All states" },
  { value: "disabled", label: "Disabled" },
  { value: "approved", label: "Approved" },
  { value: "active", label: "Active" },
  { value: "retired", label: "Retired" },
];

const PARSE_OPTIONS: Array<{ value: RichAgentParseSupportStatus | "all"; label: string }> = [
  { value: "all", label: "All parse states" },
  { value: "supported", label: "Supported" },
  { value: "supported_with_warnings", label: "Supported with warnings" },
  { value: "unsupported", label: "Unsupported" },
];

export function AgentsCatalogPage({
  workspaceId = "default",
  sessionId,
}: {
  workspaceId?: string;
  sessionId?: string;
}) {
  const [entries, setEntries] = useState<ImportedAgentCatalogRecord[]>([]);
  const [divisions, setDivisions] = useState<string[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(readRequestedEntryId());
  const [search, setSearch] = useState("");
  const [division, setDivision] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<ImportedAgentCatalogLifecycleStatus | "all">("all");
  const [parseFilter, setParseFilter] = useState<RichAgentParseSupportStatus | "all">("all");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchImportedAgentCatalog({
        workspaceId,
        search: search.trim() || undefined,
        division: division === "all" ? undefined : division,
        state: stateFilter,
        parseStatus: parseFilter,
        limit: 500,
      });
      setEntries(response.items);
      setDivisions(response.divisions);
      setSelectedEntryId((current) => {
        const requested = readRequestedEntryId();
        if (requested && response.items.some((entry) => entry.entryId === requested)) {
          return requested;
        }
        if (current && response.items.some((entry) => entry.entryId === current)) {
          return current;
        }
        return response.items[0]?.entryId ?? null;
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [division, parseFilter, search, stateFilter, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => entries.find((entry) => entry.entryId === selectedEntryId) ?? entries[0] ?? null,
    [entries, selectedEntryId],
  );

  const handleImport = useCallback(async () => {
    setImporting(true);
    try {
      const imported = await importAgencyAgentCatalog({ workspaceId });
      setStatus(`Imported ${imported.importedCount} Agency specialists for ${workspaceId} from ${imported.ref}.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  }, [load, workspaceId]);

  const handleStatePatch = useCallback(async (entryId: string, state: ImportedAgentCatalogLifecycleStatus) => {
    setBusyEntryId(entryId);
    try {
      const updated = await patchImportedAgentCatalogState(entryId, { state });
      setEntries((current) => current.map((entry) => (entry.entryId === updated.entryId ? updated : entry)));
      setStatus(`${updated.definition.frontmatter.name} is now ${state}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyEntryId(null);
    }
  }, []);

  const handleActivate = useCallback(
    async (entryId: string) => {
      if (!sessionId) {
        setError("Open a chat, cowork, or code session first so GoatCitadel knows where to activate this specialist.");
        return;
      }
      setBusyEntryId(entryId);
      try {
        const activated = await activateImportedAgentCatalogEntry(entryId, { sessionId });
        setEntries((current) =>
          current.map((entry) => (entry.entryId === activated.catalogEntry.entryId ? activated.catalogEntry : entry)),
        );
        setStatus(
          `Activated ${activated.catalogEntry.definition.frontmatter.name} for session ${sessionId} as a manual-only specialist.`,
        );
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusyEntryId(null);
      }
    },
    [sessionId],
  );

  const catalogLink = selected
    ? `${buildRouteSearch({ space: "configure", page: "agents", tab: "catalog", sessionId })}&catalogEntryId=${encodeURIComponent(selected.entryId)}`
    : buildRouteSearch({ space: "configure", page: "agents", tab: "catalog", sessionId });

  const topbar = (
    <DataToolbar
      primary={
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "minmax(200px, 1.5fr) repeat(3, minmax(140px, 1fr))",
          }}
        >
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search catalog" />
          <GCSelect
            value={division}
            onChange={setDivision}
            options={[
              { value: "all", label: "All divisions" },
              ...divisions.map((item) => ({ value: item, label: item })),
            ]}
          />
          <GCSelect
            value={stateFilter}
            onChange={(value) => setStateFilter(value as ImportedAgentCatalogLifecycleStatus | "all")}
            options={STATE_OPTIONS}
          />
          <GCSelect
            value={parseFilter}
            onChange={(value) => setParseFilter(value as RichAgentParseSupportStatus | "all")}
            options={PARSE_OPTIONS}
          />
        </div>
      }
      center={
        <div className="inline-cluster">
          <StatusChip tone="muted">{entries.length} visible</StatusChip>
          <StatusChip tone="default">{divisions.length} divisions</StatusChip>
          <StatusChip tone="success">
            {entries.filter((entry) => entry.definition.parseStatus === "supported").length} supported
          </StatusChip>
          <StatusChip tone="warning">
            {entries.filter((entry) => entry.definition.parseStatus === "supported_with_warnings").length} warnings
          </StatusChip>
        </div>
      }
      secondary={
        <button type="button" onClick={() => void handleImport()} className="gc-button" disabled={importing}>
          {importing ? "Refreshing..." : "Import / Refresh Agency"}
        </button>
      }
    />
  );

  return (
    <section className="space-page stack-lg">
      {status ? <p className="status-callout success">{status}</p> : null}
      {error ? <p className="status-callout error">{error}</p> : null}
      <OperatorSplitLayout
        topbar={topbar}
        primary={
          <Panel
            title="Dormant specialist catalog"
            subtitle="Imported Agency specialists stay searchable and reviewable here until the operator activates one for a session."
          >
            {loading ? (
              <p className="chat-v11-muted">Loading imported specialists...</p>
            ) : entries.length === 0 ? (
              <GCEmptyState
                title="No imported specialists yet"
                description="Run the Agency import to populate the catalog for this workspace."
                primaryAction={
                  <button type="button" onClick={() => void handleImport()} className="gc-button" disabled={importing}>
                    {importing ? "Refreshing..." : "Import Agency"}
                  </button>
                }
              />
            ) : (
              <div className="stack-sm">
                {entries.map((entry) => (
                  <button
                    key={entry.entryId}
                    type="button"
                    onClick={() => setSelectedEntryId(entry.entryId)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "0.9rem",
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                      background: entry.entryId === selected?.entryId ? "var(--muted)" : "transparent",
                    }}
                  >
                    <div className="stack-xs">
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                        <strong>{entry.definition.frontmatter.name}</strong>
                        <div className="inline-cluster">
                          <StatusChip tone={toneForParseStatus(entry.definition.parseStatus)}>
                            {labelForParseStatus(entry.definition.parseStatus)}
                          </StatusChip>
                          <StatusChip tone={toneForCatalogState(entry.state)}>{entry.state}</StatusChip>
                        </div>
                      </div>
                      <p>{entry.definition.frontmatter.description}</p>
                      <p className="chat-v11-muted">
                        {entry.division} · {entry.definition.provenance.path}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        }
        inspector={
          selected ? (
            <div className="stack-md">
              <Panel
                title={selected.definition.frontmatter.name}
                subtitle={`${selected.division} · ${selected.definition.slug}`}
                actions={
                  <div className="inline-cluster">
                    <StatusChip tone={toneForParseStatus(selected.definition.parseStatus)}>
                      {labelForParseStatus(selected.definition.parseStatus)}
                    </StatusChip>
                    <StatusChip tone={toneForCatalogState(selected.state)}>{selected.state}</StatusChip>
                  </div>
                }
              >
                <div className="stack-sm">
                  <p>{selected.definition.frontmatter.description}</p>
                  <p className="chat-v11-muted">
                    Source: {selected.definition.provenance.provider} · {selected.definition.provenance.path}
                  </p>
                  <p className="chat-v11-muted">
                    Ref: {selected.definition.provenance.ref ?? "unknown"} · Commit:{" "}
                    {selected.definition.provenance.commit ?? "unknown"}
                  </p>
                  {selected.definition.parseWarnings.length > 0 ? (
                    <div className="stack-xs">
                      <strong>Warnings</strong>
                      <ul>
                        {selected.definition.parseWarnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="inline-cluster">
                    {selected.state !== "approved" ? (
                      <button
                        type="button"
                        className="gc-button"
                        disabled={busyEntryId === selected.entryId}
                        onClick={() => void handleStatePatch(selected.entryId, "approved")}
                      >
                        Approve
                      </button>
                    ) : null}
                    {selected.state !== "disabled" ? (
                      <button
                        type="button"
                        className="gc-button"
                        disabled={busyEntryId === selected.entryId}
                        onClick={() => void handleStatePatch(selected.entryId, "disabled")}
                      >
                        Disable
                      </button>
                    ) : null}
                    {selected.state !== "retired" ? (
                      <button
                        type="button"
                        className="gc-button"
                        disabled={busyEntryId === selected.entryId}
                        onClick={() => void handleStatePatch(selected.entryId, "retired")}
                      >
                        Retire
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="gc-button"
                      disabled={busyEntryId === selected.entryId || !sessionId}
                      onClick={() => void handleActivate(selected.entryId)}
                    >
                      Activate for session
                    </button>
                    <a href={catalogLink} className="gc-button" style={{ textDecoration: "none" }}>
                      Link
                    </a>
                  </div>
                </div>
              </Panel>

              <Panel title="Rich definition preview" subtitle="Parsed sections from the imported Markdown body.">
                <div className="stack-md">
                  {selected.definition.sectionOrder.map((key) => {
                    const section = selected.definition.sectionMap[key];
                    if (!section) {
                      return null;
                    }
                    return (
                      <section key={key} className="stack-xs">
                        <div className="inline-cluster">
                          <strong>{section.heading}</strong>
                          <StatusChip tone="muted">{section.kind}</StatusChip>
                        </div>
                        <ReactMarkdown>{section.content || "_No content_"}</ReactMarkdown>
                      </section>
                    );
                  })}
                </div>
              </Panel>

              <Panel title="Raw Markdown" subtitle="Original upstream source is preserved for inspection." collapsible>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontSize: "0.82rem",
                    lineHeight: 1.45,
                  }}
                >
                  {selected.definition.rawMarkdown}
                </pre>
              </Panel>
            </div>
          ) : (
            <Panel title="Catalog detail" subtitle="Choose an imported specialist to inspect the rich definition.">
              <p className="chat-v11-muted">
                Select a catalog entry to review frontmatter, sections, provenance, and activation status.
              </p>
            </Panel>
          )
        }
        inspectorMode="sticky"
      />
    </section>
  );
}

function readRequestedEntryId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return new URL(window.location.href).searchParams.get("catalogEntryId");
}

function labelForParseStatus(value: RichAgentParseSupportStatus): string {
  return value === "supported" ? "supported" : value === "supported_with_warnings" ? "warnings" : "unsupported";
}

function toneForParseStatus(value: RichAgentParseSupportStatus): "success" | "warning" | "critical" {
  return value === "supported" ? "success" : value === "supported_with_warnings" ? "warning" : "critical";
}

function toneForCatalogState(value: ImportedAgentCatalogLifecycleStatus): "default" | "warning" | "success" | "muted" {
  return value === "active" ? "success" : value === "approved" ? "default" : value === "retired" ? "muted" : "warning";
}
