import { RefreshCw } from "lucide-react";
import type {
  RuntimeAuthorityClass,
  RuntimeAuthorityFreshness,
  RuntimeAuthorityItem,
  RuntimeAuthorityPosture,
  RuntimeAuthorityReference,
} from "@goatcitadel/contracts";
import { useRuntimeAuthorityProjection } from "@goatcitadel/mission-control-shared/hooks/useRuntimeAuthorityProjection";
import type { AppRoute } from "@next/app/route-model";
import { NativeCard } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner, StatusChip, type StatusChipTone } from "../primitives";
import type { NativeRoutePagesProps } from "../types";
import "./runtime-authority.css";

const AUTHORITY_LABELS: Record<RuntimeAuthorityClass, string> = {
  canonical_record: "Canonical record",
  derived_projection: "Derived projection",
  retained_signal: "Retained signal",
  inferred: "Inferred",
  unavailable: "Unavailable",
};

const FRESHNESS_LABELS: Record<RuntimeAuthorityFreshness, string> = {
  current: "Current",
  stale: "Stale",
  missing: "Missing",
  contradictory: "Contradictory",
  unknown: "Unknown",
};

export function RuntimeAuthorityPanel({
  workspaceId,
  theme,
  navigate,
}: {
  workspaceId: string;
  theme: AppRoute["theme"];
  navigate: NativeRoutePagesProps["navigate"];
}) {
  const projection = useRuntimeAuthorityProjection(workspaceId);
  const items = projection.data?.items ?? [];
  const attentionCount = items.filter((item) => item.posture === "critical" || item.posture === "attention").length;

  return (
    <NativeCard
      title="Runtime authority map"
      subtitle="Gateway-classified truth for canonical records, projections, retained signals, and unavailable evidence."
      density="compact"
      className="mc-next-runtime-authority-panel"
      stats={[
        { label: "Records", value: String(items.length) },
        { label: "Attention", value: String(attentionCount) },
      ]}
      actions={
        <NativeButton
          variant="outline"
          onClick={() => void projection.reload()}
          disabled={projection.loading}
          aria-label="Refresh runtime authority map"
        >
          <RefreshCw size={15} aria-hidden="true" />
          {projection.loading ? "Reloading authority" : "Reload authority"}
        </NativeButton>
      }
    >
      <AuthorityLegend />
      {projection.error ? (
        <NoticeBanner tone="error" message={`Runtime authority unavailable: ${projection.error}`} />
      ) : null}
      {projection.loading && !projection.data ? (
        <div className="mc-next-runtime-authority-loading" aria-busy="true" aria-live="polite">
          <EmptyState size="compact" title="Loading server-authored authority classifications…" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          size="compact"
          title="No authority records returned"
          description="Gateway returned an empty bounded projection; no client inference has been substituted."
        />
      ) : (
        <div className="mc-next-runtime-authority-grid" role="list" aria-label="Runtime authority records">
          {items.map((item) => (
            <AuthorityItemCard key={item.id} item={item} theme={theme} navigate={navigate} />
          ))}
        </div>
      )}
    </NativeCard>
  );
}

function AuthorityLegend() {
  return (
    <div className="mc-next-runtime-authority-legend" aria-label="Authority class legend">
      {(["canonical_record", "derived_projection", "retained_signal", "inferred", "unavailable"] as const).map(
        (authorityClass) => (
          <StatusChip
            key={authorityClass}
            tone={toneForAuthorityClass(authorityClass)}
            ariaLabel={`${AUTHORITY_LABELS[authorityClass]} authority class`}
          >
            {AUTHORITY_LABELS[authorityClass]}
          </StatusChip>
        ),
      )}
    </div>
  );
}

function AuthorityItemCard({
  item,
  theme,
  navigate,
}: {
  item: RuntimeAuthorityItem;
  theme: AppRoute["theme"];
  navigate: NativeRoutePagesProps["navigate"];
}) {
  const target = item.canonicalRef ? routeForReference(item.canonicalRef, theme) : undefined;
  return (
    <section
      className="mc-next-runtime-authority-item"
      data-posture={item.posture}
      role="listitem"
      aria-label={`${item.label}: ${AUTHORITY_LABELS[item.authorityClass]}, ${FRESHNESS_LABELS[item.freshness]}`}
    >
      <div className="mc-next-runtime-authority-item-head">
        <div>
          <span className="mc-next-runtime-authority-domain">{item.domain}</span>
          <h3>{item.label}</h3>
        </div>
        <div className="mc-next-runtime-authority-item-chips">
          <StatusChip tone={toneForAuthorityClass(item.authorityClass)}>
            {AUTHORITY_LABELS[item.authorityClass]}
          </StatusChip>
          <StatusChip tone={toneForFreshness(item.freshness)}>{FRESHNESS_LABELS[item.freshness]}</StatusChip>
          <StatusChip tone={toneForPosture(item.posture)} ariaLabel={`Posture: ${authorityPostureLabel(item.posture)}`}>
            {authorityPostureLabel(item.posture)}
          </StatusChip>
        </div>
      </div>
      <p className="mc-next-runtime-authority-state">{item.state}</p>
      <dl className="mc-next-runtime-authority-meta">
        <div>
          <dt>Owner</dt>
          <dd>{item.owner}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{item.source}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{item.scope.kind === "workspace" ? "Current workspace" : "Citadel runtime"}</dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd>
            {item.observedAt ? (
              <time dateTime={item.observedAt}>{formatObservedAt(item.observedAt)}</time>
            ) : (
              "Not available"
            )}
          </dd>
        </div>
      </dl>
      <details className="mc-next-runtime-authority-details">
        <summary>Classification basis</summary>
        <p>{item.basis}</p>
        {item.caveat ? <p className="mc-next-runtime-authority-caveat">{item.caveat}</p> : null}
      </details>
      {target && item.canonicalRef ? (
        <NativeButton variant="ghost" className="mc-next-runtime-authority-link" onClick={() => navigate(target)}>
          {item.canonicalRef.label}
        </NativeButton>
      ) : null}
    </section>
  );
}

function routeForReference(reference: RuntimeAuthorityReference, theme: AppRoute["theme"]): AppRoute {
  switch (reference.kind) {
    case "durable_run":
      return {
        area: "ops",
        section: "sessions",
        view: "run-detail",
        runId: reference.runId,
        theme,
      };
    case "approval":
      return {
        area: "ops",
        section: "approvals",
        approvalId: reference.approvalId,
        theme,
      };
    case "release_evidence":
      return { area: "ops", section: "diagnostics", theme };
    case "external_side_effects":
      return { area: "settings", section: "integrations", theme };
  }
}

function toneForAuthorityClass(authorityClass: RuntimeAuthorityClass): StatusChipTone {
  switch (authorityClass) {
    case "canonical_record":
      return "success";
    case "derived_projection":
      return "default";
    case "retained_signal":
      return "neutral";
    case "inferred":
      return "muted";
    case "unavailable":
      return "warning";
  }
}

function toneForFreshness(freshness: RuntimeAuthorityFreshness): StatusChipTone {
  switch (freshness) {
    case "current":
      return "success";
    case "stale":
      return "warning";
    case "contradictory":
      return "critical";
    case "missing":
    case "unknown":
      return "muted";
  }
}

function toneForPosture(posture: RuntimeAuthorityPosture): StatusChipTone {
  switch (posture) {
    case "ok":
      return "success";
    case "attention":
      return "warning";
    case "critical":
      return "critical";
    case "neutral":
      return "neutral";
    case "unavailable":
      return "muted";
  }
}

function formatObservedAt(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "Not available";
}

export function authorityPostureLabel(posture: RuntimeAuthorityPosture): string {
  switch (posture) {
    case "ok":
      return "OK";
    case "neutral":
      return "Informational";
    case "attention":
      return "Needs attention";
    case "critical":
      return "Critical";
    case "unavailable":
      return "Unavailable";
  }
}
