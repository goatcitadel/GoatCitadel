import type { EffectivePermissionSurfaceState } from "../../../features/native-routes/settings/effective-permission-contexts";
import {
  PERMISSION_CONTEXT_PRESENTATION,
  isLegacyPermissionContext,
} from "../../../features/native-routes/settings/sections/PermissionProfileDraftFields";
import { describeToolApprovalMode } from "../../../features/native-routes/settings/helpers/permission-helpers";
import { presentErrorText } from "../../lib/present-error";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";

/** Why a context could not be read: one plain line, with the recorded text in technical details. */
function ContextUnavailable({ error }: { error: string }) {
  const { summary, detail } = presentErrorText(error);
  return (
    <>
      <p role="status" className="text-status-waiting">
        Unavailable: {summary}
      </p>
      {detail ? (
        <TechnicalDetails label="Recorded error">
          <p className="break-all font-mono text-xs">{detail}</p>
        </TechnicalDetails>
      ) : null}
    </>
  );
}

export function EffectivePermissionContexts({
  contexts,
  refreshing,
}: {
  contexts: EffectivePermissionSurfaceState[];
  refreshing: boolean;
}) {
  const rows = (legacy: boolean) => (
    <ul className="space-y-2">
      {contexts
        .filter((item) => isLegacyPermissionContext(item.surface) === legacy)
        .map((item) => (
          <li key={item.surface} className="rounded-md border border-line p-3 text-sm">
            <h5 className="font-semibold">{PERMISSION_CONTEXT_PRESENTATION[item.surface].label}</h5>
            <p className="text-fg-secondary">{PERMISSION_CONTEXT_PRESENTATION[item.surface].description}</p>
            {item.error ? (
              <ContextUnavailable error={item.error} />
            ) : (
              <>
                <p>Profile: {item.profileLabel ?? item.profileId ?? "Unavailable"}</p>
                <p>
                  Approval behavior:{" "}
                  {item.approvalMode === "approve_all" ||
                  item.approvalMode === "approve_risky" ||
                  item.approvalMode === "bypass"
                    ? describeToolApprovalMode(item.approvalMode)
                    : (item.approvalMode ?? "Unavailable")}
                </p>
                {item.localOperatorOverrideId ? (
                  <p className="break-words">
                    Local override ·{" "}
                    <TimeText prefix="Expires" absolute value={item.localOperatorOverride?.expiresAt} />
                  </p>
                ) : (
                  <p>No effective override returned.</p>
                )}
                {item.profileId || item.localOperatorOverrideId ? (
                  <TechnicalDetails label="Policy identity">
                    <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2">
                      {item.profileId ? (
                        <>
                          <dt>Profile ID</dt>
                          <dd className="break-all font-mono text-xs">{item.profileId}</dd>
                        </>
                      ) : null}
                      {item.localOperatorOverrideId ? (
                        <>
                          <dt>Override ID</dt>
                          <dd className="break-all font-mono text-xs">{item.localOperatorOverrideId}</dd>
                        </>
                      ) : null}
                    </dl>
                  </TechnicalDetails>
                ) : null}
              </>
            )}
          </li>
        ))}
    </ul>
  );
  return (
    <section aria-label="Effective policy contexts" className="space-y-3 border-t border-line pt-4">
      <h4 className="text-base font-semibold">Effective policy contexts</h4>
      <p className="text-sm text-fg-secondary">
        Workspace context from GoatCitadel. Session, task or run overrides may produce a different decision; this view
        grants no execution authority.
      </p>
      {refreshing ? <p role="status">Refreshing effective permissions…</p> : null}
      {rows(false)}
      <details>
        <summary className="cursor-pointer">Legacy compatibility policy contexts</summary>
        <p className="my-2 text-sm text-fg-secondary">
          Retained keys for older clients and saved selections. They do not govern current Chat or represent separate
          work surfaces.
        </p>
        {rows(true)}
      </details>
    </section>
  );
}
