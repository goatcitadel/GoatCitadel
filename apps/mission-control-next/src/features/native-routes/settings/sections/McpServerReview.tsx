import type { McpServerRecord } from "@goatcitadel/contracts";
import { NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NoticeBanner } from "../../primitives";
import "./mcp-server-review.css";

export function McpServerReview({ server, loading, error, missing, onAccept, onReload }: {
  server: McpServerRecord | null; loading: boolean; error: string | null; missing: boolean; onAccept: () => void; onReload: () => void;
}) {
  return <section className="mc-next-mcp-review" aria-label="Current MCP server review">
    <NoticeBanner tone="warning" message="Review the current saved server before retrying. Your draft is retained." />
    {error ? <NoticeBanner tone="error" message={error} /> : null}
    {loading ? <p role="status">Loading current MCP server…</p> : null}
    {server && !missing && !error && !loading ? <>
      <h3>Current saved server</h3>
      <dl><dt>Label</dt><dd>{server.label}</dd><dt>Transport</dt><dd>{server.transport}</dd>
        <dt>Command or URL</dt><dd>{server.command || server.url || "None"}</dd>
        <dt>Enabled</dt><dd>{server.enabled ? "Enabled" : "Disabled"}</dd><dt>Category</dt><dd>{server.category}</dd>
        <dt>Trust</dt><dd>{server.trustTier}</dd><dt>Authentication</dt><dd>{server.authType}</dd></dl>
      <NativeDisclosureCard id="mcp-current-policy" title="Current arguments and policy">
        <dl><dt>Arguments</dt><dd>{server.args?.join("\n") || "None"}</dd>
          <dt>Allowed tools</dt><dd>{server.policy.allowedToolPatterns.join(", ") || "No additional restriction"}</dd>
          <dt>Blocked tools</dt><dd>{server.policy.blockedToolPatterns.join(", ") || "None"}</dd>
          <dt>Environment keys</dt><dd>{server.policy.allowedEnvKeys?.join(", ") || "None"}</dd>
          <dt>First-use approval</dt><dd>{server.policy.requireFirstToolApproval ? "Required" : "Subject to runtime policy"}</dd>
        </dl>
        <p>Stored credentials remain masked. Credential changes also require a new review.</p>
      </NativeDisclosureCard>
      <NativeButton variant="outline" onClick={onAccept}>Use current server review</NativeButton>
    </> : !missing ? <NativeButton variant="outline" disabled={loading} onClick={onReload}>Reload server review</NativeButton> : null}
  </section>;
}
