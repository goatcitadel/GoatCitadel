import { useEffect, useMemo, useState } from "react";
import type {
  AgenticCapabilityAvailability,
  AgenticCapabilityAvailabilityStatus,
  AgenticPluginProviderRuntimeStatus,
  AgenticRuntimeAvailabilityResponse,
  AgenticScalabilityTrackRecord,
} from "@goatcitadel/contracts";
import {
  fetchAgenticChannelDeliveries,
  fetchAgenticRuntimeAvailability,
  type AgenticChannelDeliveryRuntimeRecord,
} from "../api/agentic";
import { StatusChip } from "./StatusChip";

type StatusTone = "default" | "live" | "warning" | "critical" | "success" | "muted";

interface RuntimePostureItem {
  id: string;
  label: string;
  status: AgenticCapabilityAvailabilityStatus;
  callable: boolean;
  reasons: string[];
  meta?: string;
}

export function AgenticRuntimeVisibilityPanel({
  surface,
  className,
  deliveryLimit = 6,
}: {
  surface: "cowork" | "code";
  className?: string;
  deliveryLimit?: number;
}) {
  const [availability, setAvailability] = useState<AgenticRuntimeAvailabilityResponse | null>(null);
  const [deliveries, setDeliveries] = useState<AgenticChannelDeliveryRuntimeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchAgenticRuntimeAvailability(), fetchAgenticChannelDeliveries({ limit: deliveryLimit })])
      .then(([nextAvailability, nextDeliveries]) => {
        if (cancelled) return;
        setAvailability(nextAvailability);
        setDeliveries(nextDeliveries.deliveries);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : "Unable to load agentic runtime visibility.");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [deliveryLimit]);

  const groups = useMemo(() => buildRuntimePostureGroups(availability), [availability]);
  const heading = surface === "code" ? "Code capability availability" : "Agentic runtime availability";

  return (
    <section className={["agentic-runtime-visibility", className].filter(Boolean).join(" ")}>
      <div className="chat-cowork-step-head">
        <div>
          <p className="chat-cowork-section-label">Runtime visibility</p>
          <strong>{heading}</strong>
        </div>
        <StatusChip tone={error ? "critical" : loading ? "warning" : "success"}>
          {error ? "unavailable" : loading ? "checking" : "loaded"}
        </StatusChip>
      </div>
      {error ? <p className="chat-cowork-step-meta">{error}</p> : null}
      {availability ? <p className="chat-cowork-step-meta">Generated {availability.generatedAt}</p> : null}

      <div className="agentic-runtime-visibility-grid">
        {groups.map((group) => (
          <section key={group.title} className="agentic-runtime-visibility-group">
            <p className="chat-cowork-subsection-label">{group.title}</p>
            {group.items.length > 0 ? (
              <ul className="chat-cowork-orchestration-steps">
                {group.items.slice(0, 4).map((item) => (
                  <li key={item.id}>
                    <div className="chat-cowork-step-head">
                      <strong>{item.label}</strong>
                      <StatusChip tone={runtimeStatusTone(item.status, item.callable)}>{item.status}</StatusChip>
                    </div>
                    <p className="chat-cowork-step-meta">
                      {item.callable ? "Callable by policy and runtime checks." : "Inspectable only; not callable."}
                      {item.meta ? ` ${item.meta}` : ""}
                    </p>
                    {!item.callable ? (
                      <p>
                        {item.reasons.length > 0 ? item.reasons.join(" ") : "Runtime checks did not prove it callable."}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="chat-cowork-section-copy">{emptyRuntimeGroupMessage(group.title)}</p>
            )}
          </section>
        ))}

        <section className="agentic-runtime-visibility-group">
          <p className="chat-cowork-subsection-label">Channel delivery</p>
          {deliveries.length > 0 ? (
            <ul className="chat-cowork-orchestration-steps">
              {deliveries.map((delivery) => (
                <li key={delivery.deliveryId}>
                  <div className="chat-cowork-step-head">
                    <strong>
                      {delivery.channelKey}
                      {" -> "}
                      {delivery.target}
                    </strong>
                    <StatusChip tone={deliveryStatusTone(delivery.status)}>
                      {formatDeliveryStatus(delivery.status)}
                    </StatusChip>
                  </div>
                  <p className="chat-cowork-step-meta">
                    Attempts {delivery.attempts}/{delivery.maxAttempts}
                    {delivery.nextAttemptAt ? ` next ${delivery.nextAttemptAt}` : ""}
                    {delivery.providerMessageId ? ` provider ${delivery.providerMessageId}` : ""}
                  </p>
                  {delivery.staleReason || delivery.error ? <p>{delivery.staleReason ?? delivery.error}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="chat-cowork-section-copy">
              {loading ? "Loading channel delivery state." : "No queued or historical channel deliveries are visible."}
            </p>
          )}
        </section>
      </div>
    </section>
  );
}

function buildRuntimePostureGroups(availability: AgenticRuntimeAvailabilityResponse | null): Array<{
  title: string;
  items: RuntimePostureItem[];
}> {
  if (!availability) {
    return [
      { title: "Scalability", items: [] },
      { title: "Harnesses", items: [] },
      { title: "Plugins", items: [] },
      { title: "Providers", items: [] },
      { title: "Channels", items: [] },
    ];
  }
  return [
    { title: "Scalability", items: (availability.scalability ?? []).map(scalabilityTrackToPostureItem) },
    {
      title: "Harnesses",
      items: availability.harnesses.map((item) => ({
        id: item.harnessId,
        label: item.label,
        status: item.status,
        callable: item.callable,
        reasons: item.reasons,
        meta:
          item.sandboxRequired && !item.sandboxSatisfied
            ? "Sandbox posture is not satisfied."
            : item.executablePath
              ? `Executable ${item.executablePath}.`
              : undefined,
      })),
    },
    { title: "Plugins", items: availability.plugins.map(pluginProviderToPostureItem) },
    { title: "Providers", items: availability.providers.map(pluginProviderToPostureItem) },
    { title: "Channels", items: availability.channels.map(capabilityToPostureItem) },
  ];
}

function capabilityToPostureItem(item: AgenticCapabilityAvailability): RuntimePostureItem {
  return {
    id: item.capabilityId,
    label: item.label,
    status: item.status,
    callable: item.callable,
    reasons: item.reasons,
  };
}

function emptyRuntimeGroupMessage(title: string): string {
  if (title === "Scalability") {
    return "No scalability tracks are reported yet.";
  }
  return `No ${title.toLowerCase()} are reported yet.`;
}

function scalabilityTrackToPostureItem(item: AgenticScalabilityTrackRecord): RuntimePostureItem {
  return {
    id: item.trackId,
    label: item.label,
    status: item.status,
    callable: item.callable,
    reasons: [item.summary, ...item.reasons, ...item.requiredNextSteps.map((step) => `Next: ${step}.`)],
    meta: `${item.kind === "agent_protocol" ? "Protocol" : "SDK"} ${item.implementationStatus}.`,
  };
}

function pluginProviderToPostureItem(item: AgenticPluginProviderRuntimeStatus): RuntimePostureItem {
  return {
    id: item.runtimeId,
    label: item.label,
    status: item.callableExposure,
    callable: item.callableExposure === "callable" && item.status === "callable" && item.integrityStatus !== "corrupt",
    reasons: [
      item.healthMessage,
      item.integrityStatus === "corrupt" || item.integrityStatus === "quarantined"
        ? `Integrity is ${item.integrityStatus}.`
        : undefined,
      item.permissions.length > 0 ? `Permissions: ${item.permissions.join(", ")}.` : undefined,
      item.secretReadiness?.missing.length
        ? `Missing SecretRefs: ${item.secretReadiness.missing.join(", ")}.`
        : undefined,
      item.secretsRequired.length > 0 ? `Secrets required: ${item.secretsRequired.join(", ")}.` : undefined,
    ].filter((reason): reason is string => Boolean(reason)),
    meta: item.rollbackRef ? `Rollback ${item.rollbackRef}.` : undefined,
  };
}

function runtimeStatusTone(status: AgenticCapabilityAvailabilityStatus, callable: boolean): StatusTone {
  if (callable && status === "callable") return "success";
  if (status === "blocked") return "critical";
  if (status === "not_configured") return "warning";
  return "muted";
}

function deliveryStatusTone(status: AgenticChannelDeliveryRuntimeRecord["status"]): StatusTone {
  if (status === "sent") return "success";
  if (status === "failed" || status === "stale") return "critical";
  if (status === "manual_reconciliation_required") return "warning";
  if (status === "queued" || status === "retrying" || status === "running") return "warning";
  return "muted";
}

function formatDeliveryStatus(status: AgenticChannelDeliveryRuntimeRecord["status"]): string {
  return status === "manual_reconciliation_required" ? "manual reconciliation" : status;
}
