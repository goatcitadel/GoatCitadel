import { useState } from "react";
import type { RuntimeAuthorityItem, RuntimeAuthorityReference } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { useRuntimeAuthorityProjection } from "@goatcitadel/mission-control-shared/hooks/useRuntimeAuthorityProjection";
import { connectorSetupHref } from "../../app/routes";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { knownApprovalActionName } from "../chat/chat-vocabulary";
import { knownWorkflowName } from "../inbox/inbox-vocabulary";
import { presentAuthorityMessage } from "./runtime-authority-copy";
import { headingForCode } from "./runtime-authority-wording";
import { SystemOwnerLink } from "./SystemOwnerLink";
import { AUTHORITY_CLASS_LABELS, AUTHORITY_DOMAIN, AUTHORITY_FRESHNESS, AUTHORITY_POSTURE } from "./system-vocabulary";

const ATTENTION_POSTURES: ReadonlySet<RuntimeAuthorityItem["posture"]> = new Set(["critical", "attention"]);

/** Server-authored references map to cockpit routes here; record data never supplies an href. */
function hrefFor(reference: RuntimeAuthorityReference): string {
  switch (reference.kind) {
    case "durable_run":
      return `/work/runs/${encodeURIComponent(reference.runId)}`;
    case "approval":
      return `/inbox?approvalId=${encodeURIComponent(reference.approvalId)}`;
    case "release_evidence":
      return "/system/diagnostics";
    case "external_side_effects":
      return connectorSetupHref("integrations");
  }
}

function observed(value?: string) {
  return value && Number.isFinite(Date.parse(value)) ? <TimeText value={value} /> : "Not available";
}

/** Link text per reference kind, in the cockpit's words rather than the server's label. */
function linkLabelFor(reference: RuntimeAuthorityReference): string {
  switch (reference.kind) {
    case "durable_run":
      return "Open run";
    case "approval":
      return "Open approval";
    case "release_evidence":
      return "Open release details";
    case "external_side_effects":
      return "Open outside actions";
  }
}

/** The raw kind or key the server put before a per-record label's suffix, or "" when the label has another shape. */
function labelSubject(label: string, suffix: string): string {
  return label.endsWith(suffix) ? label.slice(0, -suffix.length) : "";
}

/**
 * A per-record approval or run has no coded heading, and its server label holds a raw kind or workflow key. Only a
 * kind or key the cockpit already words is named; any other reads as a plain "Approval" or "Run".
 */
function recordHeading(item: RuntimeAuthorityItem): string | undefined {
  if (item.id.startsWith("approval:")) {
    const action = knownApprovalActionName(labelSubject(item.label, " approval"));
    return action ? `Approval: ${action}` : "Approval";
  }
  if (item.id.startsWith("run:")) {
    const workflow = knownWorkflowName(labelSubject(item.label, " run"));
    return workflow ? `Run: ${workflow}` : "Run";
  }
  return undefined;
}

function AuthorityRecord({ item, workspaceId }: { item: RuntimeAuthorityItem; workspaceId: string }) {
  // The coded state words the heading and the sentence (SY-N06); the server's own label, prose, owner and source
  // stay in technical details. A per-record run or approval is named from its kind or workflow instead.
  const worded = item.stateMessage ? presentAuthorityMessage(item.stateMessage) : undefined;
  const heading =
    (item.stateMessage ? headingForCode(item.stateMessage.code) : undefined) ?? recordHeading(item) ?? item.label;
  return (
    <li className="space-y-2 py-3 text-sm text-fg-secondary">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-semibold text-fg">{heading}</h3>
        <div className="flex flex-wrap gap-1">
          <StatusBadge status={AUTHORITY_FRESHNESS[item.freshness]} />
          <StatusBadge status={AUTHORITY_POSTURE[item.posture]} />
        </div>
      </div>
      <p className="break-words">{worded ?? item.state}</p>
      <ul className="space-y-1">
        <li className="text-xs text-fg-muted">
          {AUTHORITY_DOMAIN[item.domain] ?? "Runtime"} · {AUTHORITY_CLASS_LABELS[item.authorityClass] ?? "Unclassified"}
        </li>
        <li>Scope: {item.scope.kind === "workspace" ? "Current workspace" : "Citadel runtime"}</li>
        <li>Observed: {observed(item.observedAt)}</li>
      </ul>
      <TechnicalDetails label="Classification basis">
        {heading !== item.label ? <p className="break-words">{item.label}</p> : null}
        {worded ? <p className="break-words">{item.state}</p> : null}
        <p className="break-words">Managed by: {item.owner}</p>
        <p className="break-words">Source: {item.source}</p>
        <p className="break-words">{item.basis}</p>
        {item.caveat ? <p className="break-words text-status-waiting">{item.caveat}</p> : null}
      </TechnicalDetails>
      {item.canonicalRef ? (
        <SystemOwnerLink href={hrefFor(item.canonicalRef)} scope={[workspaceId, item.id]}>
          {linkLabelFor(item.canonicalRef)}
        </SystemOwnerLink>
      ) : null}
    </li>
  );
}

/**
 * Read-only runtime authority map: how GoatCitadel classifies each runtime record (canonical, projection, signal,
 * inferred or unavailable), with freshness, posture, owner, source and scope. Nothing here is inferred by the client.
 */
export function RuntimeAuthorityMap({ workspaceId }: { workspaceId: string }) {
  const projection = useRuntimeAuthorityProjection(workspaceId);
  // The shared hook does not mark a manual reload as loading, so the map tracks its own.
  const [reloading, setReloading] = useState(false);
  const busy = projection.loading || reloading;
  const reload = () => {
    if (busy) return;
    setReloading(true);
    void projection.reload().finally(() => setReloading(false));
  };
  const items = projection.data?.items ?? [];
  const attention = items.filter((item) => ATTENTION_POSTURES.has(item.posture)).length;
  return (
    <section aria-labelledby="runtime-authority-title" className="space-y-3 border-t border-line-subtle pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="runtime-authority-title" className="text-base font-semibold text-fg">
            Runtime authority map
          </h2>
          <p className="mt-1 text-sm text-fg-secondary">
            How GoatCitadel classifies each runtime record, and how current it is.
          </p>
        </div>
        <Button size="sm" disabled={busy} onClick={reload}>
          {busy ? "Reloading authority" : "Reload authority"}
        </Button>
      </div>
      {projection.error ? (
        <p role="alert" className="text-sm text-status-failed">
          Runtime authority unavailable: {projection.error}
        </p>
      ) : null}
      {busy && !projection.data ? (
        <p role="status" className="text-sm text-fg-muted">
          {reloading ? "Reloading runtime authority…" : "Loading runtime authority…"}
        </p>
      ) : projection.data && !items.length ? (
        <p className="text-sm text-fg-muted">No authority records came back. Nothing is shown in their place.</p>
      ) : items.length ? (
        <>
          <p className="text-xs text-fg-muted">
            {plural(items.length, "record")} · {attention} {attention === 1 ? "needs" : "need"} attention
          </p>
          <ul aria-label="Runtime authority records" className="divide-y divide-line-subtle">
            {items.map((item) => (
              <AuthorityRecord key={item.id} item={item} workspaceId={workspaceId} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
