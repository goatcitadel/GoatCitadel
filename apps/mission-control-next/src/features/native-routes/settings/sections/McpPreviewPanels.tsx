import { useState } from "react";
import { NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";
import { SettingsStack, SettingsNotice, SettingsActionList } from "../SettingsShared";
import { formatMcpRemotePreviewItem } from "../helpers/mcp-helpers";
import type { useMcpModeEvidence } from "../use-mcp-mode-evidence";

export function McpPreviewPanels({ evidence }: { evidence: ReturnType<typeof useMcpModeEvidence> }) {
  const [descriptorLimit, setDescriptorLimit] = useState(20);
  const [remoteLimit, setRemoteLimit] = useState(20);
  const { serverMode, remotePreview, issues = [] } = evidence.data ?? {};
  return (
    <SettingsStack>
      <p>
        Installation-wide Gateway projections, not filtered to the selected workspace. Inspection reads evidence only;
        it does not launch, connect, authorize or call a tool.
      </p>
      <p>These owners generate independent snapshots. Availability is not a grant or a successful execution check.</p>
      <NativeButton disabled={evidence.loading} onClick={() => void evidence.refresh()}>
        Refresh MCP previews
      </NativeButton>
      {evidence.loading ? <p role="status">Reading MCP installation previews…</p> : null}
      {issues.map((message) => (
        <SettingsNotice key={message} notice={{ tone: "warning", message }} />
      ))}
      {!evidence.loading ? (
        <>
          <NativeDisclosureCard id="mcp-previews" title="Server mode preview" defaultOpen>
            {serverMode ? (
              <>
                <p>
                  Gateway snapshot: <time dateTime={serverMode.generatedAt}>{serverMode.generatedAt}</time>
                </p>
                <NativeMetricGrid
                  items={[
                    {
                      label: "Runtime",
                      value: serverMode.runtimeSupport.replaceAll("_", " "),
                      meta: serverMode.status,
                    },
                    {
                      label: "Descriptors",
                      value: String(serverMode.summary.exportedToolDescriptors),
                      meta: `${serverMode.summary.blockedDescriptors} blocked`,
                    },
                    {
                      label: "Call preview",
                      value: serverMode.runtime.callPreview.supported ? "advertised" : "not available",
                      meta: "governed, read-only descriptors",
                    },
                  ]}
                />
                <p>
                  Calls require Gateway authentication and an agent and session context, then re-enter policy and
                  approvals. This view makes no calls.
                </p>
                <details>
                  <summary>Proxy and governance details</summary>
                  <p>{serverMode.launch.reason}</p>
                  {serverMode.launch.command ? (
                    <code>{[serverMode.launch.command, ...(serverMode.launch.args ?? [])].join(" ")}</code>
                  ) : null}
                  <p>{serverMode.runtime.stdio.reason}</p>
                  <ul>
                    {[...serverMode.governance, ...serverMode.limitations].slice(0, 30).map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                </details>
                <p>
                  Showing {Math.min(descriptorLimit, serverMode.tools.length)} of {serverMode.tools.length} loaded
                  descriptors.
                </p>
                <SettingsActionList
                  ariaLabel="MCP server-mode capability descriptors"
                  items={serverMode.tools.slice(0, descriptorLimit).map((item) => ({
                    label: item.name,
                    meta: `${item.serverModeState.replaceAll("_", " ")} · ${item.capabilityKind.replaceAll("_", " ")}`,
                    description: `${item.title} · ${item.blockers[0] ?? item.governance[0] ?? "No blocker recorded."}`,
                  }))}
                  emptyLabel="No callable capability descriptors are exported."
                />
                {descriptorLimit < serverMode.tools.length ? (
                  <NativeButton onClick={() => setDescriptorLimit((value) => value + 20)}>
                    Show more descriptors
                  </NativeButton>
                ) : null}
              </>
            ) : (
              <p>Server mode evidence is unavailable.</p>
            )}
          </NativeDisclosureCard>
          <NativeDisclosureCard id="mcp-remote-preview" title="Remote MCP preview" defaultOpen>
            {remotePreview ? (
              <>
                <p>
                  Gateway snapshot: <time dateTime={remotePreview.generatedAt}>{remotePreview.generatedAt}</time>
                </p>
                <NativeMetricGrid
                  items={[
                    {
                      label: "Remote servers",
                      value: String(remotePreview.summary.remoteServers),
                      meta: "configured records",
                    },
                    {
                      label: "Remote templates",
                      value: String(remotePreview.summary.remoteTemplates),
                      meta: "catalog entries",
                    },
                    {
                      label: "Eligible records",
                      value: String(remotePreview.summary.runtimeSupported),
                      meta: "metadata projection",
                    },
                    { label: "Blocked", value: String(remotePreview.summary.blocked), meta: "recorded blockers" },
                    {
                      label: "Not callable",
                      value: String(remotePreview.summary.notCallable),
                      meta: `${remotePreview.summary.quarantined} quarantined`,
                    },
                    {
                      label: "Needs auth",
                      value: String(remotePreview.summary.needsAuth),
                      meta: `${remotePreview.summary.experimentalRecords} experimental`,
                    },
                  ]}
                />
                <p>
                  Configuration and catalog evidence only. Eligibility is not a connection check, grant or successful
                  tool invocation.
                </p>
                <p>
                  Showing {Math.min(remoteLimit, remotePreview.items.length)} of {remotePreview.items.length} loaded
                  records.
                </p>
                <SettingsActionList
                  ariaLabel="Remote MCP server preview"
                  items={remotePreview.items.slice(0, remoteLimit).map((item) => ({
                    label: item.label,
                    meta: `${item.source} · ${item.transport} · ${item.invocationState.replaceAll("_", " ")}`,
                    description: formatMcpRemotePreviewItem(item),
                  }))}
                  emptyLabel="No remote MCP records or templates are visible."
                />
                {remoteLimit < remotePreview.items.length ? (
                  <NativeButton onClick={() => setRemoteLimit((value) => value + 20)}>
                    Show more preview records
                  </NativeButton>
                ) : null}
              </>
            ) : (
              <p>Remote MCP evidence is unavailable.</p>
            )}
          </NativeDisclosureCard>
        </>
      ) : null}
    </SettingsStack>
  );
}
