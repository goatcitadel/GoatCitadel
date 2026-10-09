import type { ChannelSetupJourney, ConnectorDiagnosticReport } from "@goatcitadel/contracts";
const timestamp = (value?: string, fallback = "Not observed") => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : fallback;
const stateLabel = { verified: "Verified", pending: "Pending", failed: "Failed", unknown: "Not observed", unsupported: "Not supported by this adapter" };

const latestReplyLabel = { verified: "Verified", pending: "Pending", failed: "Failed", unknown: "Outcome uncertain", unsupported: "Not supported by this adapter" };

export function ChannelJourneyEvidence({ journey, diagnostics, diagnosticsAvailability }: { journey?: ChannelSetupJourney; diagnostics?: ConnectorDiagnosticReport; diagnosticsAvailability?: "enabled" | "disabled" | "unavailable" }) {
  const latestReplyState = journey?.latestReplyState ?? (journey?.states.reply === "unsupported" ? "unsupported" : "unknown");
  return <div className="min-w-0 space-y-3 text-sm">
    {journey ? <>
      <p>{journey.capabilities.runtimePosture.operatorSummary}</p>
      <ol className="grid gap-2 sm:grid-cols-2" aria-label="Connection verification stages">
        {(["configuration", "credentials", "destination", "access", "transport", "activation", "outbound", "inbound", "reply"] as const).map((stage) =>
          <li key={stage} className="rounded-md border border-line p-3">
            <strong>{stage === "outbound" ? "Outbound delivery" : stage === "inbound" ? "First accepted inbound message" : stage === "reply" ? "First reply receipt" : stage === "activation" ? "Activation" : stage === "credentials" ? "Credentials" : stage === "destination" ? "Destination access" : stage === "access" ? "Sender access policy" : stage === "transport" ? "Transport readiness" : "Saved configuration"}</strong>
            <p>{stateLabel[journey.states[stage] ?? "unknown"]}</p>
          </li>)}
      </ol>
      <section aria-label="Latest reply delivery" className="space-y-2 rounded-md border border-line p-3">
        <h4 className="font-semibold">Latest reply delivery</h4>
        <p role={latestReplyState === "failed" ? "alert" : "status"} className={latestReplyState === "failed" ? "font-semibold text-status-failed" : latestReplyState === "unknown" ? "font-semibold text-status-waiting" : "font-semibold"}>
          {latestReplyLabel[latestReplyState]}
        </p>
        <p>Updated {timestamp(journey.latestReply?.updatedAt, "Timestamp unavailable")}</p>
        {journey.latestReply?.providerMessageId ? <p className="text-xs text-fg-muted">A provider receipt is recorded for this delivery. Its current outcome is shown above.</p> : null}
        {journey.states.reply === "verified" ? <p className="text-xs text-fg-muted">First reply receipt is historical proof. Later reply deliveries can have a different outcome.</p> : null}
      </section>
      <p>Supported actions: {journey.capabilities.supportedActions.map((action) => action.replace("channel.", "")).join(", ") || "None reported"}.</p>
      <p>{journey.capabilities.supportsStreaming ? "Streaming supported." : "Streaming unavailable for this adapter."} Inbound: {journey.capabilities.inboundModes.join(", ") || "None"}.</p>
      {journey.capabilities.supportNotes.map((note) => <p key={note}>{note}</p>)}
      <dl className="space-y-1">
        <dt>Latest accepted inbound message</dt><dd>{timestamp(journey.latestInbound?.acceptedAt)}</dd>
        <dt>Runtime at last observation</dt><dd>{journey.runtime.ready ? "Ready at last observation" : "Needs attention"} · {timestamp(journey.runtime.lastReadyAt)}</dd>
      </dl>
      {journey.runtime.lastError ? <p role="alert">{journey.runtime.lastError}</p> : null}
      <details><summary className="cursor-pointer">Saved setup evidence</summary>
        {journey.setupEvidence.length ? <ul className="max-h-80 space-y-2 overflow-auto">
          {journey.setupEvidence.slice(0, 10).map((item) => <li key={item.evidenceId}>
            <strong>{item.phase} · {item.status}</strong> · {timestamp(item.checkedAt)}
            <p className="text-xs">Tested draft revision {item.draftRevision}{item.phase === "activation" && item.activationDraftRevision !== undefined ? " · Activated draft revision " + item.activationDraftRevision : ""}</p>
            {item.issues.map((issue) => <p key={issue.key}>{issue.message}</p>)}
          </li>)}
        </ul> : <p>No current setup evidence recorded.</p>}
      </details>
    </> : null}
    {diagnosticsAvailability === "disabled" || diagnosticsAvailability === "unavailable" ? <section aria-label="Connection diagnostics" className="space-y-1 rounded-md border border-line p-3">
      <h4 className="font-semibold">Connection diagnostics</h4>
      <p role="status">{diagnosticsAvailability === "disabled" ? "Diagnostics are disabled in runtime settings." : "Diagnostics are unavailable because their runtime setting could not be verified."} Journey and delivery evidence are shown independently.</p>
    </section> : null}
    {diagnostics ? <details><summary className="cursor-pointer">Connection diagnostics</summary>
      <ul className="mt-2 space-y-2">{diagnostics.checks.map((check) => <li key={check.key}>
        <strong>{check.key.replaceAll("_", " ")}</strong> · {check.status}<p>{check.message}</p>
      </li>)}</ul>
      <p className="text-xs text-fg-muted">Diagnostics do not send sandbox messages. Use the reviewed setup test when delivery proof is needed.</p>
    </details> : null}
  </div>;
}
