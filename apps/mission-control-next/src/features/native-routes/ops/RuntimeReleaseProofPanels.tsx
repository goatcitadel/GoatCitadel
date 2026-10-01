import { RefreshCw } from "lucide-react";
import type { ReviewReadinessSummary } from "@goatcitadel/contracts";
import { ROUTE_RELEASE_SCOPE, type RouteReleaseScope } from "@next/app/route-model";
import { isRuntimeReleaseVerified } from "@next/app/runtime-build-identity";
import { EmptyState, NativeButton, NoticeBanner, StatusChip } from "../primitives";
import { NativeCard, NativeList } from "../NativeRoutePageLayout";
import { formatDateTime, formatBytes } from "./runtime-formatters";

export function ReleaseProofDashboardPanel({
  summary,
  loading,
  error,
  onRefresh,
}: {
  summary: ReviewReadinessSummary | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}) {
  const routeStats = summarizeReleaseScope(ROUTE_RELEASE_SCOPE);
  const lanes = summary?.lanes ?? [];
  const currentLanes = lanes.filter((lane) => lane.status === "current").length;
  const missingOrStaleLanes = lanes.length - currentLanes;
  const identity = summary?.runtimeIdentity;
  const release = identity?.release;
  const releaseVerified = isRuntimeReleaseVerified(identity);
  const payloadVerifiedAt = release?.runtimePayloadIntegrity?.verifiedAt;
  const certificateTone = releaseVerified
    ? "success"
    : release?.certificateState === "malformed"
      ? "critical"
      : release
        ? "warning"
        : "muted";
  const certificateLabel = releaseVerified
    ? "Installed payload verified"
    : release?.certificateState === "malformed"
      ? "Certificate invalid"
      : release?.certificateState === "parsed"
        ? "Release not verified"
        : release
          ? "Certificate absent"
          : "No identity loaded";
  const sourceLabel = identity
    ? `${formatBuildKind(identity.kind)} · ${identity.shortSha ?? "SHA unknown"}`
    : "Load identity";
  const docsProofCount = routeStats.docsCheckRoutes;
  const visualProofCount = routeStats.visualRoutes;

  return (
    <NativeCard
      title="Release proof dashboard"
      subtitle="Server-owned source/build identity and fail-closed release-certificate proof, separated from route readiness evidence."
      density="compact"
      className="mc-next-release-proof-dashboard"
      stats={[
        { label: "Release proof", value: certificateLabel },
        { label: "Running identity", value: sourceLabel },
        {
          label: "Required proof",
          value: release ? `${release.requiredProof.passed}/${release.requiredProof.total} exact` : "not loaded",
        },
      ]}
      actions={
        <NativeButton variant="outline" className="subtle" disabled={loading} onClick={() => void onRefresh()}>
          <RefreshCw size={16} />
          Refresh proof
        </NativeButton>
      }
    >
      <div className="mc-next-release-proof-status-row">
        <StatusChip tone={certificateTone}>{certificateLabel}</StatusChip>
        <StatusChip tone={identity?.integrity === "clean" ? "success" : identity ? "warning" : "muted"}>
          {identity ? `${formatBuildKind(identity.kind)} · ${identity.integrity}` : "Identity unavailable"}
        </StatusChip>
        <StatusChip tone={routeStats.experimental > 0 ? "warning" : "success"}>
          {routeStats.experimental} experimental
        </StatusChip>
        <StatusChip tone={missingOrStaleLanes > 0 ? "warning" : lanes.length ? "success" : "muted"}>
          {missingOrStaleLanes} stale or missing lanes
        </StatusChip>
      </div>
      {error ? <NoticeBanner tone="error" message={error} /> : null}
      <div className="mc-next-release-proof-grid">
        <ReleaseProofCard
          label="Source / build identity"
          value={sourceLabel}
          body={
            identity
              ? `${identity.version === "unknown" ? "Version unknown" : `Version ${identity.version}`} · ${
                  identity.buildSha ?? "full SHA unavailable"
                } · ${formatBuildIdentitySource(identity.identitySource)}. Source integrity is ${identity.integrity}.`
              : "Diagnostics has not loaded the server-owned running identity yet."
          }
          tone={identity?.integrity === "clean" ? "success" : "warning"}
        />
        <ReleaseProofCard
          label="Packaged / release proof"
          value={certificateLabel}
          body={
            release
              ? releaseVerified
                ? `Certificate ${release.certificateVersion ?? "version unknown"} matches ${
                    release.certificateCommit ?? "the running SHA"
                  }; all required proof is exact and no accepted failures are recorded. The Gateway verified the installed app/bin payload in-process; this is not an external hostile-process guarantee. Last complete installed-payload scan: ${
                    payloadVerifiedAt ? formatDateTime(payloadVerifiedAt) : "time unavailable"
                  }.`
                : (release.reasons[0] ?? "Release proof is not verified.")
              : "No server-owned release proof result is loaded."
          }
          tone={releaseVerified ? "success" : "warning"}
        />
        <ReleaseProofCard
          label="Route coverage"
          value={`${routeStats.total} routes`}
          body={`${routeStats.ship} ship, ${routeStats.experimental} experimental, ${routeStats.polish} need release polish, ${routeStats.hidden} hidden.`}
          tone={routeStats.polish || routeStats.hidden ? "warning" : "success"}
        />
        <ReleaseProofCard
          label="Checkout verification lanes"
          value={lanes.length ? `${currentLanes}/${lanes.length} current` : "Not loaded"}
          body={
            lanes.length
              ? `${missingOrStaleLanes} lane${missingOrStaleLanes === 1 ? "" : "s"} still need rerun or evidence refresh.`
              : "Review-readiness lanes load from the gateway diagnostics endpoint."
          }
          tone={missingOrStaleLanes > 0 || !lanes.length ? "warning" : "success"}
        />
        <ReleaseProofCard
          label="Screenshot freshness"
          value={`${visualProofCount} visual routes`}
          body="Routes that require verify:surface:regression remain explicit; screenshot artifacts are not fabricated in-app."
          tone="info"
        />
        <ReleaseProofCard
          label="Docs alignment"
          value={`${docsProofCount} docs lanes`}
          body="Docs proof is anchored to docs:check, docs/1_0_CONTRACT.md, and docs/1_0_RELEASE_EVIDENCE.md."
          tone={docsProofCount > 0 ? "success" : "warning"}
        />
        <ReleaseProofCard
          label="Accepted debt"
          value={`${routeStats.experimental + routeStats.polish} scoped`}
          body="Experimental or polish-needed surfaces stay visible as scoped debt rather than release-complete claims."
          tone={routeStats.experimental + routeStats.polish > 0 ? "warning" : "success"}
        />
      </div>
      <NativeList
        items={(release?.reasons ?? []).map((reason, index) => ({
          title: release?.reasonCodes[index]?.replaceAll("_", " ") ?? "Release proof blocker",
          meta: "Release not verified",
          body: reason,
        }))}
        emptyLabel={releaseVerified ? "No release-proof blockers." : "Release-proof blockers are unavailable."}
        density="compact"
        maxHeight="min(24vh, 12rem)"
        ariaLabel="Release proof blockers"
      />
      <NativeList
        items={(release?.acceptedFailures ?? []).map((failure, index) => ({
          title: `Accepted failure ${index + 1}`,
          meta: "Disqualifies release verification",
          body: failure,
        }))}
        emptyLabel="No accepted release failures are exposed by the certificate."
        density="compact"
        maxHeight="min(20vh, 10rem)"
        ariaLabel="Accepted release failures"
      />
      <NativeList
        items={ROUTE_RELEASE_SCOPE.map((scope) => ({
          title: `${scope.area}/${scope.section}`,
          meta: scope.status,
          body: `${scope.verification} · ${scope.note}`,
        }))}
        emptyLabel="No route release scope entries."
        density="compact"
        maxHeight="min(28vh, 14rem)"
        ariaLabel="Release route proof scope"
      />
      <NativeList
        items={(summary?.releaseProof?.artifacts ?? []).map((artifact) => ({
          title: artifact.name,
          meta: `${artifact.platformArch} · ${artifact.signatureStatus} · ${artifact.exactShaStatus}`,
          body: `${artifact.sha256} · ${formatBytes(artifact.sizeBytes)} · ${artifact.sourceWorkflow} · certificate ${artifact.certificateInclusion}${
            artifact.acceptedCaveats.length ? ` · caveats: ${artifact.acceptedCaveats.join(", ")}` : ""
          }`,
        }))}
        emptyLabel="No public artifact proof table is loaded. Generate one from release-certificate.json with scripts/release/release-proof-summary.mjs."
        density="compact"
        maxHeight="min(28vh, 14rem)"
        ariaLabel="Release artifact proof table"
      />
    </NativeCard>
  );
}

function ReleaseProofCard({
  label,
  value,
  body,
  tone,
}: {
  label: string;
  value: string;
  body: string;
  tone: "info" | "success" | "warning";
}) {
  return (
    <article className="mc-next-release-proof-card" data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{body}</p>
    </article>
  );
}

function formatBuildKind(kind: ReviewReadinessSummary["runtimeIdentity"]["kind"]): string {
  return kind === "development" ? "Development" : kind === "packaged" ? "Packaged" : "Source";
}

function formatBuildIdentitySource(source: ReviewReadinessSummary["runtimeIdentity"]["identitySource"]): string {
  if (source === "git_checkout") {
    return "Resolved from the current Git checkout";
  }
  if (source === "packaged_manifest") {
    return "Resolved from the packaged release manifest";
  }
  return "Build identity source unavailable";
}

function summarizeReleaseScope(scopes: readonly RouteReleaseScope[]) {
  return scopes.reduce(
    (summary, scope) => {
      summary.total += 1;
      if (scope.status === "ship") {
        summary.ship += 1;
      }
      if (scope.status === "experimental") {
        summary.experimental += 1;
      }
      if (scope.status === "needs_release_polish") {
        summary.polish += 1;
      }
      if (scope.status === "hide") {
        summary.hidden += 1;
      }
      if (/verify:surface:regression/.test(scope.verification)) {
        summary.visualRoutes += 1;
      }
      if (/docs:check/.test(scope.verification)) {
        summary.docsCheckRoutes += 1;
      }
      return summary;
    },
    {
      total: 0,
      ship: 0,
      experimental: 0,
      polish: 0,
      hidden: 0,
      visualRoutes: 0,
      docsCheckRoutes: 0,
    },
  );
}

export function ReviewReadinessPanel({
  summary,
  loading,
  error,
  onRefresh,
}: {
  summary: ReviewReadinessSummary | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}) {
  const lanes = summary?.lanes ?? [];
  const staleProofCount = lanes.filter((lane) => lane.status !== "current").length;
  const linkedTasks = summary?.linkedTasks ?? [];
  const sourceLabel = summary ? `${summary.branch}@${summary.sha.slice(0, 8)}` : "No snapshot";

  return (
    <NativeCard
      title="Code/Ops review readiness"
      subtitle="Gateway-owned review lanes, proof freshness, imported findings, and linked task state."
      density="compact"
      stats={[
        { label: "Source", value: sourceLabel },
        { label: "Stale proof", value: String(staleProofCount) },
        { label: "Findings", value: String(summary?.openFindings ?? 0) },
      ]}
      actions={
        <NativeButton variant="outline" className="subtle" disabled={loading} onClick={() => void onRefresh()}>
          <RefreshCw size={16} />
          Refresh
        </NativeButton>
      }
    >
      {error ? <NoticeBanner tone="error" message={error} /> : null}
      {loading && !summary ? <EmptyState size="compact" title="Loading review readiness." /> : null}
      {summary ? (
        <div className="mc-next-directory-lane-list" aria-label="Review readiness lanes">
          {lanes.map((lane) => (
            <div key={lane.lane} className="mc-next-directory-lane-item">
              <div className="mc-next-directory-lane-head">
                <strong>{lane.lane}</strong>
                <StatusChip tone={toneForReviewLane(lane.status)}>{lane.status}</StatusChip>
              </div>
              <p>
                {lane.artifactRef ? formatReviewArtifactRef(lane.artifactRef) : "No verification artifact recorded."}
              </p>
              <div className="mc-next-directory-lane-status">
                <span>{lane.lastRunAt ? formatDateTime(lane.lastRunAt) : "No run time"}</span>
                <span>{lane.rerunHint}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <NativeList
        items={linkedTasks.map((task) => ({
          title: task.title,
          meta: `${task.status} · ${task.priority}`,
          body: `${task.taskId} · updated ${formatDateTime(task.updatedAt)}`,
        }))}
        emptyLabel="No imported review tasks."
        density="compact"
        maxHeight="min(28vh, 14rem)"
        ariaLabel="Linked review tasks"
      />
    </NativeCard>
  );
}

function toneForReviewLane(status: ReviewReadinessSummary["lanes"][number]["status"]) {
  if (status === "current") {
    return "success";
  }
  if (status === "stale") {
    return "warning";
  }
  return "muted";
}

function formatReviewArtifactRef(value: string) {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return parts.slice(-3).join("/");
}
