import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { fetchCapabilityCatalog } from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, QuickJumpCard } from "../NativeRoutePageLayout";
import { ErrorState } from "../primitives";
import type { NativeRoutePagesProps } from "../types";
import {
  deriveCapabilityStatus,
  mergeCapabilities,
  nativeLoad,
  nativeLoadIssues,
  summarizeCapabilityCounts,
  truncateText,
  useAsyncLoad,
  type CapabilityStatusFilter,
} from "../shared/native-helpers";
import {
  LibraryActionCardGrid,
  LibraryButtonRow,
  LibraryCodeBlock,
  LibraryEmptyState,
  LibraryFilterBar,
  LibraryLoadWarnings,
  LibraryMetricGrid,
  LibrarySectionShell,
  LibrarySelectableList,
} from "../shared/library-primitives";

export function LibraryCapabilitiesSection({ route, navigate }: NativeRoutePagesProps) {
  const [selectedCapabilityId, setSelectedCapabilityId] = useState("");
  const [statusFilter, setStatusFilter] = useState<CapabilityStatusFilter>("all");
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [inspectable, callable] = await Promise.all([
      nativeLoad("Inspectable capabilities", fetchCapabilityCatalog("inspectable"), {
        scope: "inspectable",
        items: [],
      }),
      nativeLoad("Callable capabilities", fetchCapabilityCatalog("callable"), { scope: "callable", items: [] }),
    ]);
    const merged = mergeCapabilities(inspectable.data.items, callable.data.items);
    return {
      issues: nativeLoadIssues([inspectable, callable]),
      capabilities: merged,
      callableCount: callable.data.items.length,
    };
  }, []);

  useEffect(() => {
    if (!data?.capabilities.length) {
      setSelectedCapabilityId("");
      return;
    }
    setSelectedCapabilityId((current) =>
      data.capabilities.some((item) => item.capabilityId === current)
        ? current
        : (data.capabilities[0]?.capabilityId ?? ""),
    );
  }, [data]);

  const filteredCapabilities = useMemo(() => {
    const items = data?.capabilities ?? [];
    if (statusFilter === "all") {
      return items;
    }
    return items.filter((item) => deriveCapabilityStatus(item).status === statusFilter);
  }, [data?.capabilities, statusFilter]);

  const selectedCapability =
    filteredCapabilities.find((item) => item.capabilityId === selectedCapabilityId) ?? filteredCapabilities[0] ?? null;
  const visibleSelectedCapabilityId = selectedCapability?.capabilityId ?? "";
  const statusCounts = useMemo(() => summarizeCapabilityCounts(data?.capabilities ?? []), [data?.capabilities]);
  const selectedStatus = selectedCapability ? deriveCapabilityStatus(selectedCapability) : null;

  return (
    <LibrarySectionShell loading={loading} error={error} onRetry={reload}>
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Capability browser"
          subtitle="Plain-language visibility into the skills, tools, providers, MCP entries, and generated capabilities GoatCitadel can inspect or use when callable."
          stats={[
            { label: "Total", value: String(data?.capabilities.length ?? 0) },
            { label: "Callable", value: String(data?.callableCount ?? 0) },
            { label: "Needs attention", value: String(statusCounts.degraded + statusCounts.unavailable) },
          ]}
        >
          <LibraryFilterBar
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as CapabilityStatusFilter)}
            options={[
              { id: "all", label: "All" },
              { id: "available", label: "Available" },
              { id: "configured", label: "Configured" },
              { id: "inspect-only", label: "Inspect-only" },
              { id: "degraded", label: "Degraded" },
              { id: "unavailable", label: "Unavailable" },
            ]}
          />
          <LibrarySelectableList
            items={filteredCapabilities.map((item) => {
              const status = deriveCapabilityStatus(item);
              return {
                id: item.capabilityId,
                title: item.title,
                meta: status.label,
                body: `${item.kind} · ${item.category} · ${truncateText(item.summary, 140)}`,
              };
            })}
            selectedId={visibleSelectedCapabilityId}
            onSelect={setSelectedCapabilityId}
            emptyLabel="No capabilities match this filter."
          />
          <LibraryButtonRow>
            <button type="button" className="mc-next-settings-filter" onClick={() => void reload()}>
              <RefreshCw className="h-4 w-4" />
              Refresh catalog
            </button>
          </LibraryButtonRow>
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title={selectedCapability?.title ?? "Capability detail"}
            subtitle={
              selectedCapability
                ? selectedCapability.summary
                : "Select a capability to see what it does and whether it is ready to use."
            }
          >
            {selectedCapability && selectedStatus ? (
              <>
                <LibraryMetricGrid
                  items={[
                    { label: "Status", value: selectedStatus.label, meta: selectedStatus.reason },
                    { label: "Kind", value: selectedCapability.kind, meta: selectedCapability.category },
                    {
                      label: "Callable",
                      value: selectedCapability.callable ? "Yes" : "No",
                      meta: selectedCapability.toolName ?? selectedCapability.skillId ?? selectedCapability.sourceRef,
                    },
                    {
                      label: "Trust",
                      value: selectedCapability.trustLabel ?? selectedCapability.lifecycleState ?? "Unlabeled",
                      meta: selectedCapability.sourceProvider ?? "Local catalog",
                    },
                  ]}
                />
                <LibraryActionCardGrid
                  items={[
                    {
                      id: "availability",
                      label: "Why this state",
                      value: selectedStatus.label,
                      description: selectedStatus.reason,
                      meta: `${selectedCapability.kind} · ${selectedCapability.category}`,
                      tone: capabilityStatusTone(selectedStatus.status),
                    },
                    {
                      id: "trust-source",
                      label: "Trust source",
                      value: selectedCapability.trustLabel ?? selectedCapability.lifecycleState ?? "Unlabeled",
                      description:
                        selectedCapability.sourceProvider ??
                        selectedCapability.sourceRef ??
                        "Catalog entry does not expose external provenance.",
                      meta: selectedCapability.reviewWarning ?? "Review warning not attached.",
                      tone: selectedCapability.reviewWarning ? "warning" : "info",
                    },
                    {
                      id: "activation-path",
                      label: "Activation path",
                      value: selectedCapability.callable
                        ? "Callable now"
                        : describeCapabilityActivationPath(selectedCapability),
                      description: selectedCapability.callable
                        ? "Runtime planners can consider this through the callable catalog under policy."
                        : "Activation must happen through setup, skill lifecycle, or proposal review before runtime use.",
                      meta:
                        selectedCapability.toolName ??
                        selectedCapability.skillId ??
                        selectedCapability.proposalId ??
                        selectedCapability.candidateId ??
                        "No activation id",
                      actionLabel: selectedCapability.callable ? "Governed use" : "Review setup",
                      onClick: selectedCapability.callable
                        ? undefined
                        : () =>
                            navigate({
                              area: selectedCapability.skillId ? "library" : "settings",
                              section: selectedCapability.skillId ? "skills" : "onboarding",
                              theme: route.theme,
                            }),
                      tone: selectedCapability.callable ? "success" : "warning",
                    },
                    {
                      id: "safe-starter",
                      label: "Safe starter",
                      value: selectedCapability.callable ? "Ask with scope" : "Inspect first",
                      description: selectedCapability.callable
                        ? `Start from a specific task and let policy decide whether ${selectedCapability.title} can be used.`
                        : "Treat this as reference evidence until the callable catalog exposes it.",
                      actionLabel: selectedCapability.callable ? "Policy gated" : "Not callable",
                      tone: selectedCapability.callable ? "success" : "neutral",
                    },
                    {
                      id: "recent-usage",
                      label: "Recent usage",
                      value: "Not attached",
                      description:
                        "The capability catalog does not currently attach last-run evidence or recent caller history here.",
                      meta: "Audit detail remains in runtime logs.",
                      tone: "neutral",
                    },
                  ]}
                />
                <LibraryCodeBlock label="What it can do">{selectedCapability.summary}</LibraryCodeBlock>
                {selectedCapability.reviewWarning ? (
                  <ErrorState size="inline" tone="caution" description={selectedCapability.reviewWarning} />
                ) : null}
                <div className="mc-next-technical-detail">
                  <LibraryCodeBlock label="Technical detail">
                    {JSON.stringify(
                      {
                        capabilityId: selectedCapability.capabilityId,
                        toolName: selectedCapability.toolName,
                        skillId: selectedCapability.skillId,
                        proposalId: selectedCapability.proposalId,
                        candidateId: selectedCapability.candidateId,
                        declaredTools: selectedCapability.declaredTools,
                        requires: selectedCapability.requires,
                        wrapperVisibility: selectedCapability.wrapperVisibility,
                      },
                      null,
                      2,
                    )}
                  </LibraryCodeBlock>
                </div>
              </>
            ) : (
              <LibraryEmptyState label="Select a capability to inspect it." />
            )}
          </NativeCard>
          <NativeCard title="Catalog posture" subtitle="Capability availability split into operator-friendly states.">
            <LibraryMetricGrid
              items={[
                { label: "Available", value: String(statusCounts.available), meta: "Ready and callable" },
                {
                  label: "Configured",
                  value: String(statusCounts.configured),
                  meta: "Known but not directly callable",
                },
                {
                  label: "Inspect-only",
                  value: String(statusCounts["inspect-only"]),
                  meta: "Reference or proposal only",
                },
                { label: "Degraded", value: String(statusCounts.degraded), meta: "Warning or deprecated state" },
                { label: "Unavailable", value: String(statusCounts.unavailable), meta: "Revoked or blocked" },
              ]}
            />
          </NativeCard>
          <QuickJumpCard
            title="Related routes"
            subtitle="Capability status is only useful when setup and memory are nearby."
            actions={[
              { label: "Setup Center", route: { area: "settings", section: "onboarding", theme: route.theme } },
              { label: "Providers", route: { area: "settings", section: "providers", theme: route.theme } },
              { label: "Memory", route: { area: "library", section: "memory", theme: route.theme } },
              { label: "Skills", route: { area: "library", section: "skills", theme: route.theme } },
            ]}
            navigate={navigate}
          />
        </div>
      </div>
    </LibrarySectionShell>
  );
}

function capabilityStatusTone(
  status: ReturnType<typeof deriveCapabilityStatus>["status"],
): "neutral" | "info" | "success" | "warning" | "danger" {
  if (status === "available") {
    return "success";
  }
  if (status === "configured") {
    return "info";
  }
  if (status === "degraded" || status === "inspect-only") {
    return "warning";
  }
  if (status === "unavailable") {
    return "danger";
  }
  return "neutral";
}

function describeCapabilityActivationPath(selectedCapability: {
  callable: boolean;
  proposalId?: string;
  candidateId?: string;
  skillId?: string;
  toolName?: string;
}) {
  if (selectedCapability.callable) {
    return selectedCapability.toolName ?? selectedCapability.skillId ?? "Callable";
  }
  if (selectedCapability.proposalId) {
    return "Proposal review";
  }
  if (selectedCapability.candidateId) {
    return "Candidate review";
  }
  if (selectedCapability.skillId) {
    return "Skill lifecycle";
  }
  return "Setup required";
}
