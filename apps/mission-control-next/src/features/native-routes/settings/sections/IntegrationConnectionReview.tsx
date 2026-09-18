import type { IntegrationConnection } from "@goatcitadel/contracts";
import { NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NoticeBanner } from "../../primitives";
import { humanizeEnumToken } from "../../shared/native-helpers";
import "./integration-connection-review.css";

export function IntegrationConnectionReview({ connection, loading, error, missing, onAccept, onReload }: {
  connection: IntegrationConnection | null; loading: boolean; error: string | null; missing: boolean; onAccept: () => void; onReload: () => void;
}) {
  return <section className="mc-next-integration-review" aria-label="Current connection review">
    <NoticeBanner tone="warning" message="Review the current saved connection before retrying. Your draft is retained." />
    {error ? <NoticeBanner tone="error" message={error} /> : null}
    {loading ? <p role="status">Loading current connection…</p> : null}
    {connection && !missing && !error && !loading ? <>
      <h3>Current saved connection</h3>
      <dl><dt>Label</dt><dd>{connection.label}</dd><dt>Status</dt><dd>{connection.status} · {connection.enabled ? "Enabled" : "Disabled"}</dd>
        <dt>Workspace</dt><dd>{connection.workspaceId ?? "Unbound · Personal Citadel policy"}</dd><dt>Updated</dt><dd>{connection.updatedAt}</dd>
        <dt>Plugin</dt><dd>{connection.pluginId ?? "None"}{connection.pluginVersion ? ` · ${connection.pluginVersion}` : ""}{connection.pluginEnabled ? " · Enabled" : ""}</dd>
        <dt>Last sync</dt><dd>{connection.lastSyncAt ?? "Never"}</dd><dt>Last error</dt><dd>{connection.lastError ?? "None"}</dd></dl>
      <NativeDisclosureCard id="integration-current-config" title="Current configuration">
        {Object.keys(connection.config).length ? <dl>{Object.entries(connection.config).map(([key, value]) => <div key={key}><dt>{humanizeEnumToken(key)}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl> : <p>No configuration fields saved.</p>}
        <p>Stored credentials remain masked. A credential change also requires a new review.</p>
      </NativeDisclosureCard>
      <NativeButton variant="outline" onClick={onAccept}>Use current connection review</NativeButton>
    </> : !missing ? <NativeButton variant="outline" disabled={loading} onClick={onReload}>Reload connection review</NativeButton> : null}
  </section>;
}
