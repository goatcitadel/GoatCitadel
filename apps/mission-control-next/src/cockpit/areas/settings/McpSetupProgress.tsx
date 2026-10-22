import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { useState } from "react";
import {
  resolveMcpServerConnectionMode,
  type McpServerRecord,
  type McpToolRecord,
  type McpServerTestEvidence,
} from "@goatcitadel/contracts";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { isGatewayMcpServer } from "../../../features/native-routes/settings/mcp-server-mutation";
import { TimeText } from "../../ui/TimeText";

/** A readable projection of the existing inspection, never a second readiness owner. */
export function McpSetupProgress({
  server,
  tools,
  stale,
  staticMcpAvailable,
  refreshAvailability,
  availabilityChecking = false,
  testEvidence,
}: {
  server: McpServerRecord;
  tools?: McpToolRecord[];
  stale: boolean;
  staticMcpAvailable?: boolean;
  refreshAvailability?: () => void;
  availabilityChecking?: boolean;
  testEvidence?: McpServerTestEvidence;
}) {
  const { navigate } = useCockpitRoute();
  const [copyStatus, setCopyStatus] = useState("");
  const staticServer = !isGatewayMcpServer(server) && resolveMcpServerConnectionMode(server) === "static";
  const evidenceCurrent =
    !stale &&
    testEvidence?.serverId === server.serverId &&
    testEvidence.serverRevision === server.revision &&
    testEvidence.connectionRevision === server.connectionRevision;
  const verified = evidenceCurrent && testEvidence?.state === "verified" && testEvidence.receipt;
  const prompt = `Help me verify MCP server ${JSON.stringify(server.serverId)} in this conversation. Check its current tool availability and permissions. Propose one small read-only task and ask me for any required resource or input before invoking it. Use the normal approval flow. After execution, show the actual tool result and explain what it verifies; report any blocked or unverified step.`;
  async function copy() {
    if (!navigator.clipboard?.writeText) {
      setCopyStatus("Clipboard is unavailable. Select the sample text below to copy it.");
      return;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyStatus("Sample copied. Open Chat, paste it, and review before sending.");
    } catch {
      setCopyStatus("Copy failed. Select the sample text below to copy it.");
    }
  }
  return (
    <section aria-label="MCP setup progress" className="space-y-3 border-t border-line-subtle pt-4">
      <h5 className="font-semibold text-fg">From setup to a verified task</h5>
      {stale ? (
        <p role="status">This is the last inspection. Refresh to check current setup before continuing.</p>
      ) : null}
      <ol className="list-inside list-decimal space-y-2">
        <li>
          <strong>Saved:</strong> {stale ? "Last read" : "Read"} version{" "}
          <code className="break-all">{server.revision}</code>.{" "}
          {server.enabled ? "Enabled in saved configuration." : "Disabled in saved configuration."}
        </li>
        <li>
          <strong>Connected:</strong> Last recorded state is {server.status.replaceAll("_", " ")}. Use the reviewed
          connection controls below.
        </li>
        <li>
          <strong>Discovered:</strong>{" "}
          {tools ? `${plural(tools.length, "cached tool descriptor")}.` : "Cached inventory unavailable."} Connection
          discovery and cached inventory do not establish permission.
        </li>
        <li>
          <strong>Callable:</strong>{" "}
          {staticServer
            ? staticMcpAvailable === true
              ? "Static MCP in Chat is enabled. "
              : staticMcpAvailable === false
                ? "Static MCP in Chat is disabled for this runtime. "
                : "Static MCP availability in Chat is unverified. "
            : null}
          Evaluated by GoatCitadel for the actual Chat request and its current grants. This inspection does not
          establish callability.
        </li>
        <li>
          <strong>Tested:</strong>{" "}
          {verified ? (
            <>
              A completed, approved Chat tool result matches this saved configuration, connection and cached tool
              schema. <TimeText prefix="Recorded" value={verified.finishedAt} />.
              <div className="mt-2">
                <Button size="sm" onClick={() => navigate(verified.chatHref)}>
                  View tested Chat turn
                </Button>
              </div>
            </>
          ) : testEvidence?.state === "stale" || testEvidence?.state === "verified" ? (
            "The last test result is out of date. Refresh and run a reviewed sample with the current settings."
          ) : testEvidence?.state === "unavailable" ? (
            "No test result is available. Refresh before relying on it."
          ) : testEvidence ? (
            `No matching approved result was found in the latest ${testEvidence.historyLimit} workspace runs (up to ${testEvidence.toolLimitPerTurn} tools per turn). Older or other kinds of tests may exist.`
          ) : (
            "No task result is verified in this view. A completed Chat tool result shows that it ran."
          )}
          {testEvidence ? (
            <p className="mt-1 text-xs text-fg-muted">
              This reads retained receipts and cached inventory; it does not retest the remote service or establish
              future callability.
              {testEvidence.receiptCandidateLimit
                ? ` The search checks at most ${testEvidence.receiptCandidateLimit} approved receipt candidates.`
                : ""}
              {testEvidence.searchTruncated
                ? " The bounded search stopped before checking all candidates; no complete-history claim is made."
                : ""}
            </p>
          ) : null}
        </li>
      </ol>
      {staticServer ? (
        <div className="space-y-2">
          {staticMcpAvailable === false ? (
            <p>
              Ask the runtime operator to enable static MCP in Chat through a reviewed settings change, with resumable
              runs enabled. Then refresh this status, review the server connection controls below, and start a new Chat
              turn.
            </p>
          ) : staticMcpAvailable === undefined ? (
            <p>
              Refresh runtime availability before preparing a Chat test. Missing or stale availability does not mean
              this feature is enabled.
            </p>
          ) : (
            <p>
              Review the connection controls below, then name this exact server in a new Chat turn. Current permissions
              and approvals still apply.
            </p>
          )}
          {staticMcpAvailable === false ? (
            <details>
              <summary className="cursor-pointer text-fg">Runtime operator setting</summary>
              <p className="mt-2">
                The reviewed settings change uses <code>features.chatStaticMcpV1Enabled</code>. This view does not
                change runtime settings or tool permissions.
              </p>
            </details>
          ) : null}
          {refreshAvailability ? (
            <Button size="sm" disabled={availabilityChecking} onClick={refreshAvailability}>
              Refresh Chat availability
            </Button>
          ) : null}
        </div>
      ) : null}
      <details>
        <summary className="cursor-pointer text-fg">Prepare a governed sample task</summary>
        <p className="mt-2">
          Copy this starter into Chat and review the proposed resource and action. Copying or opening Chat does not run
          a tool.
        </p>
        <p className="mt-2 break-words rounded-md border border-line-subtle p-2">{prompt}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" disabled={stale} onClick={() => void copy()}>
            Copy sample task
          </Button>
          <Button size="sm" onClick={() => navigate("/chat")}>
            Open Chat
          </Button>
        </div>
        {copyStatus ? (
          <p role="status" className="mt-2">
            {copyStatus}
          </p>
        ) : null}
      </details>
    </section>
  );
}
