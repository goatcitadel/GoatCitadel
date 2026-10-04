import { useState } from "react";
import type { IntegrationSettingsOwner } from "../../../features/native-routes/settings/sections/use-integration-settings";
import { isReplayAuditCandidate } from "../../../features/native-routes/settings/sections/use-integration-replay-actions";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { integrationInputClass } from "./IntegrationFormFields";
import { useActiveWorkspaceLabel } from "../../data/use-workspace-name";

export function IntegrationCatalogEvidence({ owner: s }: { owner: IntegrationSettingsOwner }) {
  const workspaceLabel = useActiveWorkspaceLabel();
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(10);
  const issue = s.data?.issues.find(
    (item) =>
      item.label ===
      (s.panel === "connectors"
        ? "Dormant external connector catalog"
        : s.panel === "plugins"
          ? "Integration plugins"
          : "External side-effect runs"),
  );
  const services =
    s.data?.externalConnectorServices.filter((item) =>
      `${item.label} ${item.serviceId} ${item.description}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  const runs =
    s.data?.sideEffectRuns.filter(
      (item) =>
        item.workspaceId === s.activeWorkspaceId &&
        (!s.selectedConnectionId || item.connectionId === s.selectedConnectionId),
    ) ?? [];
  return (
    <section aria-label="Integration catalog and delivery evidence" className="space-y-4">
      <Button onClick={s.closePanel}>Close integration evidence</Button>
      {s.loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Refreshing owner evidence…
        </p>
      ) : null}
      {issue ? (
        <p role="alert" className="text-sm text-status-waiting">
          {issue.label}: {issue.message}
        </p>
      ) : s.panel === "connectors" ? (
        <>
          <h4 className="font-display text-md font-semibold">Imported external connectors</h4>
          <p className="text-sm text-fg-secondary">
            Review metadata is scoped to workspace {workspaceLabel}. These imported actions are catalog-only and
            non-callable. Staging creates a capability proposal; it grants no execution authority.
          </p>
          <label className="block text-sm">
            Find imported connector
            <input
              aria-label="Find imported connector"
              type="search"
              className={integrationInputClass}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(10);
              }}
            />
          </label>
          {!services.length ? (
            <p className="text-sm text-fg-muted">No imported connectors match this owner window.</p>
          ) : null}
          {services.slice(0, limit).map((service) => (
            <details
              key={`${service.sourceId}:${service.serviceId}`}
              className="rounded-md border border-line-subtle p-3"
            >
              <summary className="cursor-pointer font-medium">
                {service.label} · {service.reviewState.status}
              </summary>
              <p className="my-2 text-sm text-fg-secondary">{service.description}</p>
              <p className="break-all text-xs text-fg-muted">
                Source {service.sourceId} · commit {service.source.commit}
              </p>
              <div className="my-2 flex flex-wrap gap-2">
                <Button
                  disabled={s.externalMutation.locked || s.loading}
                  onClick={() => s.handleReviewExternalConnectorService(service, "reviewed")}
                >
                  Review service
                </Button>
                <Button
                  disabled={s.externalMutation.locked || s.loading}
                  onClick={() => s.handleReviewExternalConnectorService(service, "hidden")}
                >
                  Hide service
                </Button>
              </div>
              {(service.actions ?? []).slice(0, 20).map((action) => (
                <div key={action.actionId} className="mt-3 space-y-2 border-t border-line-subtle pt-3">
                  <p className="text-sm font-medium">
                    {action.label} · {action.reviewState.status}
                  </p>
                  <p className="text-sm text-fg-secondary">{action.description}</p>
                  <p className="break-all text-xs text-fg-muted">
                    Handler {action.handlerSha256 ?? "unavailable"} · {action.upstreamPath}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={s.externalMutation.locked || s.loading}
                      onClick={() => s.handleReviewExternalConnectorAction(action, "reviewed")}
                    >
                      Review action
                    </Button>
                    <Button
                      disabled={s.externalMutation.locked || s.loading}
                      onClick={() => s.handleReviewExternalConnectorAction(action, "hidden")}
                    >
                      Hide action
                    </Button>
                    <Button
                      disabled={
                        s.externalMutation.locked ||
                        s.loading ||
                        Boolean(action.reviewState.proposalId) ||
                        action.reviewState.status === "staged"
                      }
                      onClick={() => s.handleStageExternalConnectorAction(action)}
                    >
                      Stage capability proposal
                    </Button>
                  </div>
                  {action.reviewState.proposalId ? (
                    <p className="break-all text-xs text-fg-muted">
                      Proposal {action.reviewState.proposalId} · remains non-callable
                    </p>
                  ) : null}
                </div>
              ))}
              {(service.actions?.length ?? 0) > 20 ? (
                <p className="mt-2 text-xs text-fg-muted">Showing the first 20 advertised actions.</p>
              ) : null}
            </details>
          ))}
          {services.length > limit ? (
            <Button onClick={() => setLimit((value) => value + 10)}>Show more imported connectors</Button>
          ) : null}
        </>
      ) : s.panel === "plugins" ? (
        <>
          <h4 className="font-display text-md font-semibold">Installed plugin trust</h4>
          <p className="text-sm text-fg-secondary">
            Installation-wide source and integrity evidence reported by the Gateway. Review does not enable plugins.
          </p>
          {!s.data?.plugins.length ? (
            <p className="text-sm text-fg-muted">The owner reports no installed integration plugins.</p>
          ) : null}
          {s.data?.plugins.slice(0, 50).map((plugin) => (
            <article key={plugin.pluginId} className="space-y-2 rounded-md border border-line-subtle p-3">
              <h5 className="font-medium">
                {plugin.label} · {plugin.enabled ? "Enabled" : "Disabled"}
              </h5>
              <p className="text-sm text-fg-secondary">
                Integrity: {plugin.integrityStatus ?? plugin.sourceMetadata?.integrityStatus ?? "unknown"}
              </p>
              <p className="break-all text-xs text-fg-muted">
                {plugin.sourceMetadata?.display ?? plugin.source ?? "Source unavailable"}
              </p>
              {plugin.trustWarnings?.map((warning, index) => (
                <p key={index} className="text-sm text-status-waiting">
                  {warning.severity}: {warning.message}
                </p>
              ))}
            </article>
          ))}
        </>
      ) : (
        <>
          <h4 className="font-display text-md font-semibold">External delivery evidence</h4>
          <p className="text-sm text-fg-secondary">
            Workspace {workspaceLabel}
            {s.selectedConnectionId ? ` · connection ${s.selectedConnectionId}` : " · all connections"}. This bounded
            owner window records side effects; it does not infer missing deliveries or clean health.
          </p>
          {!runs.length ? (
            <p className="text-sm text-fg-muted">No side-effect records are present in this exact view.</p>
          ) : null}
          {runs.slice(0, 25).map((run) => (
            <article key={run.runId} className="space-y-2 rounded-md border border-line-subtle p-3">
              <p className="break-all text-sm font-medium">
                {run.actionId ?? run.boundary} · {run.status}
              </p>
              <p className="break-all text-xs text-fg-muted">
                {run.runId} · observed {run.updatedAt} · {run.resumeState}
              </p>
              {run.errorText ? <p className="text-sm text-status-waiting">{run.errorText}</p> : null}
              <Button
                disabled={s.replayMutation.locked || s.loading || !isReplayAuditCandidate(run)}
                onClick={() => s.handleStartReplayAudit(run)}
              >
                Review replay eligibility audit
              </Button>
            </article>
          ))}
          {s.lastReplayAuditRunId ? (
            <ClassicOwnerLink
              href={`/ops/sessions?shell=classic&view=run-detail&runId=${encodeURIComponent(s.lastReplayAuditRunId)}`}
              scope={s.activeWorkspaceId}
              label="Inspect durable replay audit"
            >
              Inspect durable replay audit {s.lastReplayAuditRunId}
            </ClassicOwnerLink>
          ) : null}
        </>
      )}
      {[s.externalMutation, s.replayMutation]
        .filter((item) => item.phase === "uncertain")
        .map((item, index) => (
          <p role="alert" key={index} className="text-sm text-status-waiting">
            {item.message}
          </p>
        ))}
      <Dialog
        open={Boolean(s.externalReview)}
        title="Confirm external connector review"
        description={`${s.externalReview?.action?.label ?? s.externalReview?.service.label ?? "Connector"}: mark ${s.externalReview?.status ?? "reviewed"} in workspace ${workspaceLabel}. The connector remains non-callable. Current owner evidence is re-read before dispatch; this API has no atomic revision precondition.`}
        onOpenChange={(open) => {
          if (!open && !s.externalMutation.pending) s.cancelExternalReview();
        }}
      >
        <div className="flex flex-wrap gap-2">
          <Button disabled={s.externalMutation.locked} onClick={() => void s.confirmExternalReview()}>
            Confirm catalog review
          </Button>
          <Button disabled={s.externalMutation.pending} onClick={s.cancelExternalReview}>
            Cancel catalog review
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={Boolean(s.replayReview)}
        title="Create replay eligibility audit?"
        description={`Inspect side-effect run ${s.replayReview?.run.runId ?? ""} in workspace ${workspaceLabel}. This creates a durable eligibility audit only. Unknown external outcomes require manual reconciliation. The snapshot is re-read; this creation API has no atomic revision precondition.`}
        onOpenChange={(open) => {
          if (!open && !s.replayMutation.pending) s.cancelReplayAudit();
        }}
      >
        <div className="flex flex-wrap gap-2">
          <Button disabled={s.replayMutation.locked} onClick={() => void s.confirmReplayAudit()}>
            Create reviewed replay audit
          </Button>
          <Button disabled={s.replayMutation.pending} onClick={s.cancelReplayAudit}>
            Cancel replay audit
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
