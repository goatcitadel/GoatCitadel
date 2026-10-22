import type { MemoryMaintenancePolicyRecord } from "@goatcitadel/contracts";
import {
  fetchMemoryMaintenanceStatus,
  patchMemoryMaintenancePolicy,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  buildMemoryMaintenancePolicyPatch,
  toMemoryMaintenancePolicyDraft,
} from "@goatcitadel/mission-control-shared/content/memory-helpers";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Callout } from "../../ui/Callout";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { RUN_MODE, maintenancePolicySentence } from "./memory-diagnostics-vocabulary";
import { same, type RequestReview } from "./memory-diagnostics-shared";

/** Draft editor for the workspace memory maintenance policy; saving goes through the review dialog. */
export function MemoryPolicy({
  policy,
  scope,
  disabled,
  request,
}: {
  policy: MemoryMaintenancePolicyRecord;
  scope: string;
  disabled: boolean;
  request: RequestReview;
}) {
  const draft = useSessionDraft(scope + ":policy", toMemoryMaintenancePolicyDraft(policy), policy.revision, {
    label: "Memory maintenance policy",
  });
  return (
    <details>
      <summary className="min-h-11">Edit maintenance policy{draft.isDirty ? " · Unsaved" : ""}</summary>
      <div className="grid min-w-0 max-w-full grid-cols-1 gap-3">
        <label className="flex min-h-11 min-w-0 items-center gap-2">
          <input
            className="shrink-0"
            type="checkbox"
            checked={draft.value.enabled}
            onChange={(event) => draft.setValue((value) => ({ ...value, enabled: event.target.checked }))}
          />{" "}
          Maintenance enabled
        </label>
        <Field label="Maintenance run mode">
          {(props) => (
            <select
              {...props}
              className="min-w-0 w-full max-w-full"
              value={draft.value.runMode}
              onChange={(event) =>
                draft.setValue((value) => ({ ...value, runMode: event.target.value as typeof value.runMode }))
              }
            >
              {(Object.keys(RUN_MODE) as (keyof typeof RUN_MODE)[]).map((mode) => (
                <option key={mode} value={mode}>
                  {RUN_MODE[mode]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {(["providerId", "model"] as const).map((key) => (
          <Field key={key} label={key === "providerId" ? "Maintenance provider" : "Maintenance model"}>
            {(props) => (
              <input
                {...props}
                className="min-w-0 w-full max-w-full rounded-md border border-line bg-canvas p-2"
                value={draft.value[key]}
                onChange={(event) => draft.setValue((value) => ({ ...value, [key]: event.target.value }))}
              />
            )}
          </Field>
        ))}
        {draft.hasRemoteChanges ? (
          <Callout tone="warning">
            The policy changed. Your draft started from an older version. Review the current policy below before saving.
            <p>
              Current: {maintenancePolicySentence(policy.enabled, policy.runMode)}{" "}
              {policy.providerId || policy.model
                ? "It uses a chosen provider and model."
                : "It uses the default provider and model."}
            </p>
            <Button onClick={draft.rebaseToCurrent}>Use current policy version and keep draft</Button>
          </Callout>
        ) : null}
        <Button
          disabled={disabled || draft.hasRemoteChanges || !draft.isDirty}
          onClick={() => {
            const patch = buildMemoryMaintenancePolicyPatch(draft.value);
            request({
              label: "Save maintenance policy",
              consequence:
                maintenancePolicySentence(draft.value.enabled, draft.value.runMode) +
                " " +
                (draft.value.providerId || draft.value.model
                  ? "It uses the provider and model you chose."
                  : "It uses the default provider and model.") +
                " The exact reviewed policy values below are applied.",
              values: patch as Record<string, unknown>,
              revision: policy.revision,
              maintenance: true,
              check: async () => same((await fetchMemoryMaintenanceStatus(policy.workspaceId)).policy, policy),
              apply: async () => {
                const updated = await patchMemoryMaintenancePolicy(policy.workspaceId, {
                  ...patch,
                  expectedRevision: policy.revision,
                });
                if (
                  updated.workspaceId !== policy.workspaceId ||
                  !updated.revision ||
                  updated.revision === policy.revision
                )
                  throw new Error("Policy receipt does not confirm the reviewed version.");
                same(buildMemoryMaintenancePolicyPatch(toMemoryMaintenancePolicyDraft(updated)), patch);
                draft.acceptSaved(toMemoryMaintenancePolicyDraft(updated), updated.revision, draft.value);
                return "Memory maintenance policy saved as a new version.";
              },
            });
          }}
        >
          Review policy changes
        </Button>
        <Button variant="secondary" onClick={draft.discard}>
          Discard policy changes
        </Button>
        <TechnicalDetails label="Current policy values">
          <pre className="min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere">{JSON.stringify(policy, null, 2)}</pre>
        </TechnicalDetails>
      </div>
    </details>
  );
}
