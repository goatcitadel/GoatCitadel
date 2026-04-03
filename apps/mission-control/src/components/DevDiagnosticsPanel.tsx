import { useEffect, useMemo, useState } from "react";
import type { DevDiagnosticsCategory, DevDiagnosticsEvent, DevDiagnosticsLevel } from "@goatcitadel/contracts";
import {
  buildDevDiagnosticsBundle,
  clearClientDiagnostics,
  isDevDiagnosticsEnabled,
  listClientDiagnostics,
  useDevDiagnosticsState,
} from "../state/dev-diagnostics-store";
import { connectDevDiagnosticsStream, fetchDevDiagnostics } from "../api/client";

const CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All categories" },
  { value: "ui", label: "UI" },
  { value: "api", label: "API" },
  { value: "sse", label: "SSE" },
  { value: "refresh", label: "Refresh" },
  { value: "chat", label: "Chat" },
  { value: "orchestration", label: "Orchestration" },
  { value: "gateway", label: "Gateway" },
  { value: "startup", label: "Startup" },
  { value: "tools", label: "Tools" },
  { value: "voice", label: "Voice" },
  { value: "addons", label: "Add-ons" },
  { value: "office", label: "Office" },
];

const LEVEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All levels" },
  { value: "debug", label: "Debug" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
];

export function DevDiagnosticsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const diagnosticsState = useDevDiagnosticsState();
  const [gatewayItems, setGatewayItems] = useState<DevDiagnosticsEvent[]>([]);
  const [category, setCategory] = useState<string>("");
  const [level, setLevel] = useState<string>("");
  const [correlationIdFilter, setCorrelationIdFilter] = useState("");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !isDevDiagnosticsEnabled()) {
      return;
    }
    let cancelled = false;
    void fetchDevDiagnostics({ limit: 120 }).then((response) => {
      if (!cancelled) {
        setGatewayItems(response.items);
      }
    }).catch(() => undefined);
    const close = connectDevDiagnosticsStream((event) => {
      setGatewayItems((current) => [event, ...current].slice(0, 300));
    });
    return () => {
      cancelled = true;
      close();
    };
  }, [open]);

  const mergedItems = useMemo(() => {
    const localItems = listClientDiagnostics({ limit: 200 });
    const items = [...gatewayItems, ...localItems]
      .filter((item) => {
        if (category && item.category !== category) {
          return false;
        }
        if (level && item.level !== level) {
          return false;
        }
        if (correlationIdFilter.trim() && item.correlationId !== correlationIdFilter.trim()) {
          return false;
        }
        return true;
      })
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
    return items.slice(0, 300);
  }, [category, correlationIdFilter, gatewayItems, level]);

  const selectedEvent = mergedItems.find((item) => item.id === selectedEventId) ?? mergedItems[0] ?? null;

  useEffect(() => {
    if (!selectedEventId && mergedItems[0]) {
      setSelectedEventId(mergedItems[0].id);
    } else if (selectedEventId && !mergedItems.some((item) => item.id === selectedEventId)) {
      setSelectedEventId(mergedItems[0]?.id ?? null);
    }
  }, [mergedItems, selectedEventId]);

  if (!open || !isDevDiagnosticsEnabled()) {
    return null;
  }

  const handleCopyRecent = async () => {
    await navigator.clipboard.writeText(JSON.stringify(buildDevDiagnosticsBundle(gatewayItems), null, 2));
  };

  const handleCopySession = async () => {
    const bundle = buildDevDiagnosticsBundle(gatewayItems.filter((item) => (
      !diagnosticsState.activeChatSessionId || item.sessionId === diagnosticsState.activeChatSessionId
    )));
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
  };

  return (
    <aside className="dev-diagnostics-panel" role="dialog" aria-modal="false" aria-label="Developer diagnostics">
      <header className="dev-diagnostics-header">
        <div>
          <p className="dev-diagnostics-kicker">Development</p>
          <h3>Diagnostics</h3>
        </div>
        <button type="button" className="dev-diagnostics-close" onClick={onClose}>Close</button>
      </header>
      <div className="dev-diagnostics-status-grid">
        <div><span>Gateway</span><strong>{diagnosticsState.gatewayReachable ? "Reachable" : "Unknown"}</strong></div>
        <div><span>SSE</span><strong>{diagnosticsState.sseState ?? "n/a"}</strong></div>
        <div><span>Session</span><strong>{diagnosticsState.activeChatSessionId ?? "n/a"}</strong></div>
        <div><span>Effects</span><strong>{diagnosticsState.currentEffectsMode ?? "n/a"}</strong></div>
      </div>
      {diagnosticsState.startupSummary ? (
        <div className="dev-diagnostics-startup">
          <div className="dev-diagnostics-startup-header">
            <div>
              <span className="dev-diagnostics-kicker">Startup</span>
              <h4>Latest startup run</h4>
            </div>
            <strong>{diagnosticsState.startupSummary.durationMs} ms</strong>
          </div>
          <div className="dev-diagnostics-startup-meta">
            <span>Outcome: {diagnosticsState.startupSummary.outcome}</span>
            <span>Started: {new Date(diagnosticsState.startupSummary.startedAt).toLocaleTimeString()}</span>
          </div>
          <div className="dev-diagnostics-startup-phases">
            {diagnosticsState.startupSummary.phases.map((phase) => (
              <div key={phase.key} className={`dev-diagnostics-startup-phase is-${phase.status}`}>
                <div className="dev-diagnostics-startup-phase-row">
                  <strong>{phase.label}</strong>
                  <span>{phase.durationMs} ms</span>
                </div>
                <div className="dev-diagnostics-startup-phase-row dev-diagnostics-startup-phase-detail">
                  <span>{phase.status}</span>
                  <span>{phase.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="dev-diagnostics-toolbar">
        <select value={category} onChange={(event) => setCategory(event.target.value)}>
          {CATEGORY_OPTIONS.map((option) => (
            <option key={option.value || "all"} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select value={level} onChange={(event) => setLevel(event.target.value)}>
          {LEVEL_OPTIONS.map((option) => (
            <option key={option.value || "all"} value={option.value}>{option.label}</option>
          ))}
        </select>
        <input
          value={correlationIdFilter}
          onChange={(event) => setCorrelationIdFilter(event.target.value)}
          placeholder="Correlation ID"
        />
      </div>
      <div className="dev-diagnostics-actions">
        <button type="button" onClick={() => void handleCopyRecent()}>Copy last 100</button>
        <button type="button" onClick={() => void handleCopySession()}>Copy session bundle</button>
        <button type="button" onClick={() => {
          clearClientDiagnostics();
          setGatewayItems([]);
        }}>Clear</button>
      </div>
      <div className="dev-diagnostics-layout">
        <div className="dev-diagnostics-list" role="list">
          {mergedItems.length === 0 ? (
            <div className="dev-diagnostics-empty">No diagnostics captured yet.</div>
          ) : mergedItems.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`dev-diagnostics-item${selectedEvent?.id === item.id ? " active" : ""}`}
              onClick={() => setSelectedEventId(item.id)}
            >
              <span className="dev-diagnostics-item-meta">
                <span>{item.source}</span>
                <span>{item.category}</span>
                <span>{item.level}</span>
              </span>
              <strong>{item.event}</strong>
              <span>{item.message}</span>
              <span className="dev-diagnostics-item-time">{new Date(item.timestamp).toLocaleTimeString()}</span>
            </button>
          ))}
        </div>
        <div className="dev-diagnostics-detail">
          {selectedEvent ? (
            <>
              <div className="dev-diagnostics-detail-meta">
                <span>{selectedEvent.source}</span>
                <span>{selectedEvent.category}</span>
                <span>{selectedEvent.level}</span>
                <span>{new Date(selectedEvent.timestamp).toLocaleString()}</span>
              </div>
              <h4>{selectedEvent.event}</h4>
              <p>{selectedEvent.message}</p>
              <pre>{JSON.stringify(selectedEvent, null, 2)}</pre>
            </>
          ) : (
            <div className="dev-diagnostics-empty">Select an event to inspect its details.</div>
          )}
        </div>
      </div>
    </aside>
  );
}
