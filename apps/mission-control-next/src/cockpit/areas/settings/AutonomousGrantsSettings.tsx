import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useWorkspaceNameLookup } from "../../data/use-workspace-name";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client";
import { useAutonomousGrantRevocation } from "../../../features/native-routes/settings/use-autonomous-grant-revocation";
import {
  AUTONOMOUS_GRANT_BOUNDARY,
  autonomousGrantReviewDescription,
  grantCanBeRevoked,
  readAutonomousGrants,
} from "../../../features/native-routes/settings/autonomous-grant-binding";
import {
  formatPermissionContextList,
  hasLegacyOnlyPermissionContexts,
} from "../../../features/native-routes/settings/sections/PermissionProfileDraftFields";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { TimeText } from "../../ui/TimeText";
import type { AutonomousActivationGrantStatus, AutonomousActivationKind } from "@goatcitadel/contracts";
import { formatMoney } from "@goatcitadel/mission-control-shared/content/format";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

const GRANT_STATUS_LABELS: Record<AutonomousActivationGrantStatus, string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
};
const ACTIVATION_KIND_LABELS: Record<AutonomousActivationKind, string> = {
  capability: "Capabilities",
  tool: "Tools",
  mcp_tool: "MCP tools",
  code_mode: "Code Mode",
  subagent_fanout: "Helper agents",
};

export function AutonomousGrantsSettings({ workspaceId }: { workspaceId: string }) {
  const [query, setQuery] = useState(""),
    [limit, setLimit] = useState(30);
  const base = getGatewayApiBaseUrl();
  const snapshot = useQuery({
    queryKey: ["settings", "autonomous-grants", base],
    queryFn: () => readAutonomousGrants(),
  });
  const control = useAutonomousGrantRevocation({ scope: workspaceId, reload: () => snapshot.refetch() });
  const { activeCitadelId } = useUiPreferences();
  const workspaceName = useWorkspaceNameLookup(activeCitadelId);
  const items = (snapshot.isError ? [] : (snapshot.data ?? [])).filter((item) =>
    `${item.grantId} ${item.workspaceId} ${item.projectId ?? ""} ${item.reason}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section
      id="autonomous-activation-grants"
      aria-label="Autonomous activation grants"
      className="space-y-3 border-t border-line pt-4"
    >
      <h3 className="text-base font-semibold">Autonomous activation grants</h3>
      <p className="text-sm text-fg-secondary">
        Installation-wide grant records, including other workspaces and expired grants. An active record is not proof
        that a particular action is currently allowed; deny rules, auth, path, provenance and health checks remain
        authoritative.
      </p>
      <p className="text-xs text-fg-muted">{AUTONOMOUS_GRANT_BOUNDARY}</p>
      <Button size="sm" disabled={snapshot.isFetching || control.pending} onClick={() => void snapshot.refetch()}>
        Refresh autonomous grants
      </Button>
      {snapshot.isFetching ? <p role="status">Loading autonomous grants…</p> : null}
      {snapshot.isError ? (
        <p role="alert">
          Grants could not load:{" "}
          {snapshot.error instanceof Error ? snapshot.error.message : "No details were returned."}
        </p>
      ) : null}
      {control.checking ? <p role="status">Reviewing the exact current grant…</p> : null}
      {control.message ? <p role="status">{control.message}</p> : null}
      <label className="block text-sm">
        Find autonomous grant
        <input
          aria-label="Find autonomous grant"
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(30);
          }}
          className="mt-1 min-h-10 w-full rounded-md border border-line-control bg-canvas px-3 text-fg"
        />
      </label>
      <ul className="space-y-3">
        {items.slice(0, limit).map((grant) => {
          const attempt = control.attemptFor(grant.grantId);
          return (
            <li key={grant.grantId} className="space-y-2 rounded-md border border-line p-3 text-sm">
              <h4 className="break-words font-semibold">{grant.reason}</h4>
              <p>
                {workspaceName(grant.workspaceId) ?? "Workspace outside this Citadel"}
                {grant.projectId ? " · project-scoped" : ""} · {GRANT_STATUS_LABELS[grant.status] ?? "Unknown"}
              </p>
              <p>
                {formatPermissionContextList(grant.surfaces)} ·{" "}
                {grant.activationKinds.map((kind) => ACTIVATION_KIND_LABELS[kind] ?? "Other").join(", ")} · Maximum risk{" "}
                {presentRiskLevel(grant.maxRiskLevel).label}
              </p>
              <p>
                {grant.usedActivations} of {grant.maxActivations ?? "unlimited"} activations used ·{" "}
                <TimeText absolute prefix="Expires" value={grant.expiresAt} />
              </p>
              {hasLegacyOnlyPermissionContexts(grant.surfaces) ? (
                <p className="text-status-waiting">This legacy-only grant does not govern current Chat.</p>
              ) : null}
              <details>
                <summary className="cursor-pointer">Grant identity and limits</summary>
                <dl className="mt-2 space-y-1 break-words">
                  <dt>Grant</dt>
                  <dd className="font-mono">{grant.grantId}</dd>
                  <dt>Workspace id</dt>
                  <dd className="font-mono">{grant.workspaceId}</dd>
                  {grant.projectId ? (
                    <>
                      <dt>Project id</dt>
                      <dd className="font-mono">{grant.projectId}</dd>
                    </>
                  ) : null}
                  <dt>Capability patterns</dt>
                  <dd>{grant.capabilityPatterns.join(", ") || "None"}</dd>
                  <dt>Tool patterns</dt>
                  <dd>{grant.toolPatterns.join(", ") || "None"}</dd>
                  <dt>Budget</dt>
                  <dd>
                    {grant.budgetUsd === undefined ? "Not specified" : formatMoney(grant.budgetUsd)} · Used{" "}
                    {grant.usedBudgetUsd === undefined ? "unavailable" : formatMoney(grant.usedBudgetUsd)}
                  </dd>
                  <dt>Grantor</dt>
                  <dd>{grant.grantor}</dd>
                  <dt>Last updated</dt>
                  <dd>
                    <TimeText absolute value={grant.updatedAt} />
                  </dd>
                  {grant.revokedAt ? (
                    <>
                      <dt>Revoked</dt>
                      <dd>
                        <TimeText absolute value={grant.revokedAt} /> · {grant.revokedBy ?? "Actor unavailable"} ·{" "}
                        {grant.revocationReason ?? "No reason returned"}
                      </dd>
                    </>
                  ) : null}
                </dl>
              </details>
              {attempt ? <p role={attempt.phase === "uncertain" ? "alert" : "status"}>{attempt.message}</p> : null}
              <Button
                size="sm"
                disabled={
                  snapshot.isFetching || control.checking || control.busy(grant.grantId) || !grantCanBeRevoked(grant)
                }
                onClick={() => void control.request(grant)}
              >
                Review revocation of {grant.grantId}
              </Button>
            </li>
          );
        })}
      </ul>
      {!snapshot.isFetching && !snapshot.isError && !items.length ? (
        <p className="text-sm text-fg-muted">No grants match this view.</p>
      ) : null}
      {items.length > limit ? (
        <Button size="sm" onClick={() => setLimit((value) => value + 30)}>
          Show more autonomous grants
        </Button>
      ) : null}
      <Dialog
        open={Boolean(control.review)}
        title="Revoke autonomous activation grant?"
        description={control.review ? autonomousGrantReviewDescription(control.review) : undefined}
        onOpenChange={(open) => {
          if (!open && !control.pending) control.cancel();
        }}
      >
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="danger"
            disabled={control.pending || Boolean(control.review && control.busy(control.review.grantId))}
            onClick={() => void control.confirm()}
          >
            Revoke reviewed autonomous grant
          </Button>
          <Button disabled={control.pending} onClick={control.cancel}>
            Keep autonomous grant
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
