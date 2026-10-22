import type { ToolGrantRecord } from "@goatcitadel/contracts";
import { Dialog } from "../../ui/Dialog";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { TOOL_GRANT_DECISION_LABELS, TOOL_GRANT_TYPE_LABELS } from "./tool-grant-labels";
import { useToolGrantScopeLabel } from "./use-tool-grant-scope";

export function ToolGrantDetails({ grant, onClose }: { grant: ToolGrantRecord | null; onClose: () => void }) {
  const scopeLabel = useToolGrantScopeLabel();
  return (
    <Dialog
      open={Boolean(grant)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Recorded tool grant"
      description="The saved grant. GoatCitadel still checks permission for each action."
    >
      {grant ? (
        <div className="space-y-3 break-words text-sm text-fg">
          <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2">
            <dt>Pattern</dt>
            <dd>{grant.toolPattern}</dd>
            <dt>Decision</dt>
            <dd>{TOOL_GRANT_DECISION_LABELS[grant.decision] ?? "Unknown decision"}</dd>
            <dt>Scope</dt>
            <dd>{scopeLabel(grant)}</dd>
            <dt>Type</dt>
            <dd>{TOOL_GRANT_TYPE_LABELS[grant.grantType] ?? "Unknown type"}</dd>
            <dt>Created</dt>
            <dd>
              <TimeText value={grant.createdAt} /> · {grant.createdBy}
            </dd>
            <dt>Expires</dt>
            <dd>{grant.expiresAt ? <TimeText value={grant.expiresAt} absolute /> : "No expiry recorded"}</dd>
            <dt>Revoked</dt>
            <dd>
              {grant.revokedAt ? (
                <>
                  <TimeText value={grant.revokedAt} /> · {grant.revokedBy ?? "Actor not recorded"}
                </>
              ) : (
                "Not revoked"
              )}
            </dd>
            <dt>Uses remaining</dt>
            <dd>{grant.usesRemaining ?? "Not counted"}</dd>
          </dl>
          <TechnicalDetails label="Grant identity">
            <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2">
              <dt>Grant ID</dt>
              <dd className="break-all font-mono text-xs">{grant.grantId}</dd>
              <dt>Scope reference</dt>
              <dd className="break-all font-mono text-xs">{grant.scopeRef}</dd>
              {grant.constraints?.writeRootsApprovalId ? (
                <>
                  <dt>Opened from approval</dt>
                  <dd className="break-all font-mono text-xs">{grant.constraints.writeRootsApprovalId}</dd>
                </>
              ) : null}
            </dl>
          </TechnicalDetails>
          {grant.constraints ? (
            <section aria-label="Recorded grant constraints">
              <h4 className="font-semibold">Recorded constraints</h4>
              <ul className="mt-2 list-inside list-disc">
                {grant.constraints.allowedHosts?.map((host) => (
                  <li key={host}>Host: {host}</li>
                ))}
                {grant.constraints.allowedPaths?.map((path) => (
                  <li key={path}>Path: {path}</li>
                ))}
                {grant.constraints.writeRoots?.map((root) => (
                  <li key={`write:${root}`}>Write folder (outside the write roots): {root}</li>
                ))}
                {grant.constraints.referenceRoots?.map((root) => (
                  <li key={`${root.label}:${root.rootPath}`}>
                    Read-only reference: {root.label} · {root.rootPath}
                  </li>
                ))}
                {grant.constraints.maxCallsPerHour !== undefined ? (
                  <li>Calls per hour: {grant.constraints.maxCallsPerHour}</li>
                ) : null}
                {grant.constraints.maxWritesPerHour !== undefined ? (
                  <li>Writes per hour: {grant.constraints.maxWritesPerHour}</li>
                ) : null}
                {grant.constraints.mutationAllowed !== undefined ? (
                  <li>Mutation allowed: {grant.constraints.mutationAllowed ? "Yes" : "No"}</li>
                ) : null}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
