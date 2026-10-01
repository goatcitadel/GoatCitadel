import type { ToolGrantRecord } from "@goatcitadel/contracts";
import { Dialog } from "../../ui/Dialog";

export function ToolGrantDetails({ grant, onClose }: { grant: ToolGrantRecord | null; onClose: () => void }) {
  return (
    <Dialog
      open={Boolean(grant)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Recorded tool grant"
      description="Recorded owner evidence. Effective permission is evaluated by the Gateway for each action."
    >
      {grant ? (
        <div className="space-y-3 break-words text-sm text-fg">
          <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2">
            <dt>Grant ID</dt>
            <dd>{grant.grantId}</dd>
            <dt>Pattern</dt>
            <dd>{grant.toolPattern}</dd>
            <dt>Decision</dt>
            <dd>{grant.decision}</dd>
            <dt>Scope</dt>
            <dd>
              {grant.scope} · {grant.scopeRef}
            </dd>
            <dt>Type</dt>
            <dd>{grant.grantType}</dd>
            <dt>Created</dt>
            <dd>
              {grant.createdAt} · {grant.createdBy}
            </dd>
            <dt>Expires</dt>
            <dd>{grant.expiresAt ?? "No expiry recorded"}</dd>
            <dt>Revoked</dt>
            <dd>
              {grant.revokedAt ? `${grant.revokedAt} · ${grant.revokedBy ?? "Actor not recorded"}` : "Not revoked"}
            </dd>
            <dt>Uses remaining</dt>
            <dd>{grant.usesRemaining ?? "Not counted"}</dd>
          </dl>
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
