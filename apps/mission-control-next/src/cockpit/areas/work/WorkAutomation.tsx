import { useRef, useState } from "react";
import type {
  AutomationRecipeDraftResponse,
  WorkflowRecipeActivepiecesTemplateExportResponse,
  WorkflowRecipeN8nTemplateExportResponse,
} from "@goatcitadel/contracts";
import {
  draftAutomationRecipe,
  exportActivepiecesWorkflowTemplate,
  exportN8nWorkflowTemplate,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import {
  optionalDraftText,
  splitDraftList,
  formatWorkflowTemplateExportProofItems,
} from "../../../features/native-routes/ops/runtime-schedule-model";
import { useIsMounted } from "../../../hooks/use-is-mounted";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";

type ExportPlatform = "Activepieces" | "n8n";
const EXPORT_PLATFORMS: readonly ExportPlatform[] = ["Activepieces", "n8n"];
type ExportResult = {
  identity: string;
  platform: ExportPlatform;
  value: WorkflowRecipeActivepiecesTemplateExportResponse | WorkflowRecipeN8nTemplateExportResponse;
};

export function WorkAutomation() {
  const { activeWorkspaceId } = useUiPreferences();
  return (
    <AutomationWorkspace
      key={activeWorkspaceId ?? "default"}
      workspaceId={activeWorkspaceId ?? "default"}
    />
  );
}
function AutomationWorkspace({ workspaceId }: { workspaceId: string }) {
  const base = getGatewayApiBaseUrl();
  const editor = useSessionDraft(
    `ops:${workspaceId}:automation:designer`,
    { taskDescription: "", trigger: "", frequency: "", successCriteria: "", constraints: "" },
    undefined,
    { label: "Automation Designer" },
  );
  const draft = editor.value;
  const identity = JSON.stringify([base, workspaceId, draft]);
  const live = useRef(identity);
  live.current = identity;
  const mounted = useIsMounted();
  const busyLock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // The advisory preview and export results survive navigation for this app session, keyed by Gateway and
  // workspace; they are shown only while the draft still matches the request that produced them.
  const viewKey = `work:automation:${base}:${workspaceId}`;
  const [result, setResult] = useSessionViewState<
    { identity: string; preview: AutomationRecipeDraftResponse } | undefined
  >(`${viewKey}:preview`, undefined);
  const preview = result?.identity === identity ? result.preview : undefined;
  const [exports, setExports] = useSessionViewState<Partial<Record<ExportPlatform, ExportResult>>>(
    `${viewKey}:exports`,
    {},
  );
  async function perform(platform?: "Activepieces" | "n8n") {
    if (busyLock.current) return;
    if (!draft.taskDescription.trim()) {
      setMessage("Task description is required.");
      return;
    }
    const current = () => mounted() && live.current === identity && getGatewayApiBaseUrl() === base;
    busyLock.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (!platform) {
        const value = await draftAutomationRecipe({
          taskDescription: draft.taskDescription.trim(),
          trigger: optionalDraftText(draft.trigger),
          frequency: optionalDraftText(draft.frequency),
          successCriteria: splitDraftList(draft.successCriteria),
          constraints: splitDraftList(draft.constraints),
          workspaceId,
        });
        if (!current()) return;
        setResult({ identity, preview: value });
        setExports({});
        setMessage("Automation recipe drafted. No schedule was created and no job ran.");
      } else if (preview) {
        const value =
          platform === "Activepieces"
            ? await exportActivepiecesWorkflowTemplate({ recipe: preview.recipe })
            : await exportN8nWorkflowTemplate({ recipe: preview.recipe });
        if (!current()) return;
        setExports((current) => ({ ...current, [platform]: { identity, platform, value } }));
        if (value.validation.status === "blocked") {
          setMessage(
            `${platform} export is blocked. Review the validation checks before importing.`,
          );
          return;
        }
        if (!navigator.clipboard?.writeText) {
          setMessage(
            "Template generated; clipboard is unavailable. Export content remains in Technical details.",
          );
          return;
        }
        await navigator.clipboard.writeText(value.content);
        if (current())
          setMessage(
            `Copied ${platform} template ${value.filename}. Operator import is required; external execution has not been verified.`,
          );
      }
    } catch (error) {
      if (current()) setMessage(describeApiError(error).summary);
    } finally {
      busyLock.current = false;
      if (mounted()) setBusy(false);
    }
  }
  const labels = {
    taskDescription: "Task description",
    trigger: "Trigger",
    frequency: "Frequency and timezone intent",
    successCriteria: "Success criteria (one per line)",
    constraints: "Constraints (one per line)",
  };
  return (
    <section className="mx-auto grid max-w-5xl gap-4 p-4 sm:p-6">
      <h1 className="font-display text-xl font-semibold text-fg">Automation Designer</h1>
      <p className="text-sm text-fg-secondary">
        Draft a reviewable recipe for workspace {workspaceId}. Preview and template export do not
        create a schedule, activate capabilities, import into an external service, or prove
        execution. Gateway governance still applies.
      </p>
      {(Object.keys(labels) as (keyof typeof labels)[]).map((key) => (
        <Field key={key} label={labels[key]}>
          {(props) => (
            <textarea
              {...props}
              rows={key === "taskDescription" ? 3 : 2}
              value={draft[key]}
              disabled={busy}
              className="w-full rounded-md border border-line bg-sunken p-2 text-fg"
              onChange={(event) => {
                editor.setValue((current) => ({ ...current, [key]: event.target.value }));
                setMessage("");
              }}
            />
          )}
        </Field>
      ))}
      <Button disabled={busy} variant="primary" onClick={() => void perform()}>
        {busy ? "Waiting for Gateway…" : "Preview automation recipe"}
      </Button>
      {message ? (
        <p role="status" className="text-sm text-fg-secondary">
          {message}
        </p>
      ) : null}
      {preview ? (
        <section className="grid gap-3 rounded-md border border-line p-4">
          <h2 className="font-display text-lg font-semibold text-fg">{preview.recipe.name}</h2>
          <p>{preview.recipe.goal}</p>
          <p>
            Timing intent: {preview.recipe.scheduleIntent ?? "Not specified"}. Limits:{" "}
            {preview.estimatedLimits.maxRuntimeMinutes} minutes,{" "}
            {preview.estimatedLimits.maxIterations} iterations.
          </p>
          <p>
            Missing capabilities:{" "}
            {preview.missingCapabilities.length
              ? preview.missingCapabilities.join(", ")
              : "None reported by the preview"}
            .
          </p>
          <ul>
            {preview.proofChecklist.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void perform("Activepieces")}>
              Copy Activepieces template
            </Button>
            <Button disabled={busy} onClick={() => void perform("n8n")}>
              Copy n8n template
            </Button>
          </div>
          <NativeOwnerLink scope={[workspaceId, preview.plan.planId]} href="/work/schedules">
            Open schedule controls
          </NativeOwnerLink>
          <TechnicalDetails>
            <pre className="overflow-auto">{JSON.stringify(preview.plan, null, 2)}</pre>
          </TechnicalDetails>
        </section>
      ) : null}
      {EXPORT_PLATFORMS.map((platform) => exports[platform]).map((exported) =>
        exported?.identity === identity ? (
        <section key={exported.platform} className="grid gap-2 rounded-md border border-line p-3">
          <h2 className="font-medium text-fg">
            {exported.platform} export validation: {exported.value.validation.status}
          </h2>
          <p>
            Native import compatibility: {exported.value.validation.nativeImportCompatibility}.
            Operator import required; no webhook trigger.
          </p>
          <ul>
            {formatWorkflowTemplateExportProofItems(exported.platform, exported.value).map(
              (item, index) => (
                <li key={index}>
                  <>
                    <span className="font-medium">
                      {item.title.replace("copied artifact", "generated artifact")}
                    </span>
                    <p>{item.meta}</p>
                    <p>{item.body}</p>
                  </>
                </li>
              ),
            )}
          </ul>
          <TechnicalDetails label="Export content">
            <pre className="overflow-auto">{exported.value.content}</pre>
          </TechnicalDetails>
        </section>
        ) : null,
      )}
      <ClassicOwnerLink
        href="/ops/schedules?shell=classic"
        scope={workspaceId}
        label="Classic schedule and automation fallback"
      />
    </section>
  );
}
