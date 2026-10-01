import { useState } from "react";
import type { McpModeEvidence } from "../../../features/native-routes/settings/mcp-mode-evidence";
import { Button } from "../../ui/Button";

const PAGE_SIZE = 20;
const readable = (value: string) => value.replaceAll("_", " ");
function Notes({ title, items }: { title: string; items: string[] }) {
  return items.length ? (
    <details className="mt-2">
      <summary className="cursor-pointer text-fg">
        {title} ({items.length})
      </summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {items.slice(0, 30).map((item, index) => (
          <li key={index} className="break-words">
            {item}
          </li>
        ))}
      </ul>
      {items.length > 30 ? <p>Showing the first 30 notes.</p> : null}
    </details>
  ) : null;
}

export function McpModePanels({ evidence }: { evidence: McpModeEvidence }) {
  const [descriptorLimit, setDescriptorLimit] = useState(PAGE_SIZE);
  const [remoteLimit, setRemoteLimit] = useState(PAGE_SIZE);
  const [source, setSource] = useState<"all" | "server" | "template">("all");
  const { serverMode, remotePreview } = evidence;
  const remotes = remotePreview?.items.filter((item) => source === "all" || item.source === source) ?? [];
  return (
    <div className="space-y-5 text-sm text-fg-secondary">
      {evidence.issues.map((issue) => (
        <p key={issue} role="alert" className="text-status-waiting">
          {issue}
        </p>
      ))}
      <section aria-label="MCP server mode evidence" className="space-y-3 rounded-md border border-line p-3">
        <h4 className="font-display text-md font-semibold text-fg">Server mode preview</h4>
        {serverMode ? (
          <>
            <p className="text-xs text-fg-muted">
              Gateway snapshot: <time dateTime={serverMode.generatedAt}>{serverMode.generatedAt}</time>
            </p>
            <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2">
              <dt>Runtime support</dt>
              <dd>{readable(serverMode.runtimeSupport)}</dd>
              <dt>Exported descriptors</dt>
              <dd>{serverMode.summary.exportedToolDescriptors}</dd>
              <dt>Blocked descriptors</dt>
              <dd>{serverMode.summary.blockedDescriptors}</dd>
              <dt>Governed call preview</dt>
              <dd>{serverMode.runtime.callPreview.supported ? "Advertised by Gateway" : "Unavailable"}</dd>
            </dl>
            <p>
              Descriptors come from the Gateway callable catalog. Availability here does not grant this workspace
              permission or prove a tool ran.
            </p>
            <details>
              <summary className="cursor-pointer text-fg">Proxy and call requirements</summary>
              <p className="mt-2 break-words">{serverMode.launch.reason}</p>
              {serverMode.launch.command ? (
                <code className="block break-all font-mono">
                  {[serverMode.launch.command, ...(serverMode.launch.args ?? [])].join(" ")}
                </code>
              ) : null}
              <p className="mt-2 break-words">{serverMode.runtime.stdio.reason}</p>
              <p>
                Calls require Gateway authentication and an agent and session context, then re-enter policy and
                approvals. This inspection makes no calls.
              </p>
            </details>
            <Notes title="Governance" items={serverMode.governance} />
            <Notes title="Limitations" items={serverMode.limitations} />
            <p className="text-xs text-fg-muted">
              Showing {Math.min(descriptorLimit, serverMode.tools.length)} of {serverMode.tools.length} loaded
              descriptors.
            </p>
            <ul aria-label="MCP server-mode descriptors" className="space-y-2">
              {serverMode.tools.slice(0, descriptorLimit).map((item) => (
                <li key={item.name} className="rounded-md border border-line-subtle p-3">
                  <h5 className="break-words font-semibold text-fg">{item.title}</h5>
                  <code className="block break-all font-mono text-xs">{item.name}</code>
                  <p className="mt-1">
                    {readable(item.serverModeState)} · {readable(item.capabilityKind)}
                  </p>
                  <p className="break-words">{item.description}</p>
                  <Notes title="Descriptor blockers" items={item.blockers} />
                  <Notes title="Descriptor governance" items={item.governance} />
                </li>
              ))}
            </ul>
            {!serverMode.tools.length ? (
              <p>No callable capability descriptors were exported in this snapshot.</p>
            ) : null}
            {descriptorLimit < serverMode.tools.length ? (
              <Button size="sm" onClick={() => setDescriptorLimit((value) => value + PAGE_SIZE)}>
                Show more descriptors
              </Button>
            ) : null}
          </>
        ) : (
          <p>Server mode evidence is unavailable.</p>
        )}
      </section>
      <section aria-label="Remote MCP preview evidence" className="space-y-3 rounded-md border border-line p-3">
        <h4 className="font-display text-md font-semibold text-fg">Remote MCP preview</h4>
        {remotePreview ? (
          <>
            <p className="text-xs text-fg-muted">
              Gateway snapshot: <time dateTime={remotePreview.generatedAt}>{remotePreview.generatedAt}</time>
            </p>
            <p>
              {remotePreview.summary.remoteServers} saved remote servers · {remotePreview.summary.remoteTemplates}{" "}
              catalog templates · {remotePreview.summary.runtimeSupported} eligible according to this projection.
            </p>
            <p>
              Configuration and catalog evidence only. Eligibility is not a connection check, grant or successful tool
              invocation.
            </p>
            <label className="block">
              Preview records
              <select
                aria-label="Preview records"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value as typeof source);
                  setRemoteLimit(PAGE_SIZE);
                }}
                className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 text-fg focus-visible:outline-accent"
              >
                <option value="all">All remote records</option>
                <option value="server">Saved remote servers</option>
                <option value="template">Catalog templates</option>
              </select>
            </label>
            <p className="text-xs text-fg-muted">
              Showing {Math.min(remoteLimit, remotes.length)} of {remotes.length} loaded records.
            </p>
            <ul aria-label="Remote MCP preview records" className="space-y-2">
              {remotes.slice(0, remoteLimit).map((item) => (
                <li key={`${item.source}:${item.id}`} className="rounded-md border border-line-subtle p-3">
                  <h5 className="break-words font-semibold text-fg">{item.label}</h5>
                  <p>
                    {item.source === "server" ? "Saved server" : "Catalog template"} · {item.transport} ·{" "}
                    {readable(item.invocationState)}
                  </p>
                  <p>
                    Authentication: {readable(item.authReadiness)} · Trust: {readable(item.trustTier)}
                  </p>
                  <p className="break-words">{item.operatorNextAction}</p>
                  <code className="block break-all font-mono text-xs">{item.id}</code>
                  <Notes title="Record blockers" items={item.blockers} />
                  <Notes title="Record governance" items={item.governance} />
                </li>
              ))}
            </ul>
            {!remotes.length ? <p>No remote records match this snapshot view.</p> : null}
            {remoteLimit < remotes.length ? (
              <Button size="sm" onClick={() => setRemoteLimit((value) => value + PAGE_SIZE)}>
                Show more preview records
              </Button>
            ) : null}
          </>
        ) : (
          <p>Remote MCP evidence is unavailable.</p>
        )}
      </section>
    </div>
  );
}
