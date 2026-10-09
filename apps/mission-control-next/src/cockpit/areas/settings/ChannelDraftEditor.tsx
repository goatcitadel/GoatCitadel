import { useState } from "react";
import type { ChannelSetupWizardProps } from "../../../features/native-routes/settings/channel-setup/channel-wizard-model";
import {
  finalizeDisabledReason,
  isStepComplete,
  channelStageLabel,
  wizardValuesWithDefaults,
} from "../../../features/native-routes/settings/channel-setup/channel-wizard-model";
import { useChannelWizard } from "../../../features/native-routes/settings/channel-setup/use-channel-wizard";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { ChannelDraftEvidencePanel } from "../../../features/native-routes/settings/channel-setup/ChannelDraftEvidencePanel";
import { ChannelWizardFields, channelInputClass } from "./ChannelWizardFields";
import { ChannelFeedback, ChannelRichBlocks, ChannelStepHelp } from "./ChannelWizardContent";

export function ChannelDraftEditor(props: ChannelSetupWizardProps) {
  const wizard = useChannelWizard(props);
  const [reviewTest, setReviewTest] = useState<string | null>(null);
  const signature = JSON.stringify([
    props.scopeId,
    props.definition.catalog.catalogId,
    props.draft.draftId,
    props.draft.revision,
    props.values,
    wizard.advancedMode,
    wizard.advancedJson,
    props.label,
    props.enabled,
  ]);
  const { activeStep: step, anyBusy } = wizard;
  const blocked = wizard.actionsBlocked;
  if (!step) return <p>No setup steps were supplied by the Gateway.</p>;
  return (
    <section aria-label={`${props.definition.catalog.label} guided setup`} aria-busy={anyBusy} className="space-y-4">
      <header>
        <h3 className="font-semibold">{props.definition.catalog.label}</h3>
        <p className="text-sm text-fg-secondary">{props.definition.wizard.introSummary}</p>
        <p className="mt-1 text-xs text-fg-muted">
          {props.definition.wizard.difficulty} · about {props.definition.wizard.estimatedMinutes} minutes · draft
          revision {props.draft.revision} · {props.dirty ? "Unsaved input" : "Saved draft"}
        </p>
      </header>
      <label className="block text-sm">
        Connection label
        <input
          aria-label="Connection label"
          className={channelInputClass}
          value={props.label}
          disabled={anyBusy}
          onChange={(e) => props.onLabelChange(e.target.value)}
        />
      </label>
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={props.enabled}
          disabled={anyBusy}
          onChange={(e) => props.onEnabledChange(e.target.checked)}
        />
        Enable this connection after governed finalization
      </label>
      <details className="text-sm" open={props.definition.wizard.manualModePolicy === "expert-forward" || wizard.advancedMode}>
        <summary className="cursor-pointer">Advanced setup options</summary>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Setup editor mode">
        <Button aria-pressed={!wizard.advancedMode} disabled={anyBusy} onClick={wizard.switchToGuidedMode}>
          Guided setup
        </Button>
        <Button aria-pressed={wizard.advancedMode} disabled={anyBusy} onClick={() => wizard.setAdvancedMode(true)}>
          Advanced JSON
        </Button>
      </div>
      </details>
      {wizard.advancedMode ? (
        <label className="block text-sm">
          Draft JSON
          <textarea
            aria-label="Draft JSON"
            className={`${channelInputClass} font-mono`}
            rows={10}
            value={wizard.advancedJson}
            disabled={anyBusy}
            onChange={(e) => {
              wizard.setAdvancedJson(e.target.value);
              props.onDirty();
            }}
          />
          <span className="mt-1 block text-xs text-fg-muted">
            Expert adapter configuration. Sensitive fields use the same secure owner as guided setup and are redacted
            after saving.
          </span>
        </label>
      ) : (
        <>
          <nav aria-label="Setup steps">
            <ol className="grid gap-1 sm:grid-cols-2">
              {wizard.visibleSteps.map((item, index) => (
                <li key={item.id}>
                  <Button
                    className={`h-auto min-h-10 w-full justify-start whitespace-normal py-2 text-left ${step.id === item.id ? "border-accent ring-1 ring-accent" : ""}`}
                    variant="secondary"
                    aria-current={step.id === item.id ? "step" : undefined}
                    disabled={anyBusy}
                    onClick={() => wizard.selectStep(item.id)}
                  >
                    {index + 1}. {item.title}{step.id === item.id ? " · Current" : ""}
                    {isStepComplete(
                      item,
                      props.definition,
                      props.draft,
                      props.values,
                      wizard.visitedStepIds,
                      wizard.checkedItems,
                      props.feedback,
                    )
                      ? " · Complete"
                      : ""}
                  </Button>
                </li>
              ))}
            </ol>
          </nav>
          <article
            className="space-y-4 rounded-md border border-line p-3"
            aria-labelledby={`native-channel-step-${step.id}`}
          >
            <h4
              id={`native-channel-step-${step.id}`}
              ref={wizard.stepHeadingRef}
              tabIndex={-1}
              className="font-semibold"
            >
              {step.title}
            </h4>
            <p className="text-xs text-fg-muted">{channelStageLabel(step)} · Step {wizard.activeStepIndex + 1} of {wizard.visibleSteps.length}</p>
            {step.description ? <p className="text-sm text-fg-secondary">{step.description}</p> : null}
            <ChannelRichBlocks blocks={step.body} />
            {step.checklist?.map((item) => {
              const key = `${props.draft.draftId}:${step.id}:${item.id}`;
              return (
                <label key={key} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={Boolean(wizard.checkedItems[key])}
                    disabled={anyBusy}
                    onChange={(e) => wizard.setCheckedItems((current) => ({ ...current, [key]: e.target.checked }))}
                  />
                  <span>
                    {item.label}
                    {item.detail ? <span className="block text-fg-secondary">{item.detail}</span> : null}
                  </span>
                </label>
              );
            })}
            <ChannelWizardFields
              draft={props.draft}
              fields={step.fields}
              values={wizardValuesWithDefaults(props.definition, props.values)}
              issues={props.feedback?.issues}
              disabled={anyBusy}
              onChange={props.onValuesChange}
            />
            <ChannelStepHelp step={step} />
          </article>
        </>
      )}
      <ChannelFeedback feedback={props.feedback} error={wizard.localError} disabled={blocked} onAcknowledge={props.onAcknowledgeTest} />
      <ChannelDraftEvidencePanel evidence={props.draftEvidence} loading={props.draftEvidenceLoading} error={props.draftEvidenceError} />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={anyBusy || wizard.activeStepIndex === 0}
          onClick={() => wizard.selectStep(wizard.visibleSteps[wizard.activeStepIndex - 1]!.id)}
        >
          Previous step
        </Button>
        <Button disabled={blocked} onClick={() => void wizard.handleSave()}>
          Save draft
        </Button>
        {wizard.advancedMode || step.kind === "test" ? <>
        <Button disabled={blocked} onClick={() => void wizard.handleValidate()}>
          Validate
        </Button>
        <Button disabled={blocked} onClick={() => setReviewTest(signature)}>
          Review live test
        </Button>
        </> : null}
        {step.kind !== "confirm" && wizard.activeStepIndex + 1 < wizard.visibleSteps.length ? (
          <Button variant="primary" disabled={blocked} onClick={() => void wizard.moveForward()}>
            Next step
          </Button>
        ) : null}
        {wizard.advancedMode || step.kind === "confirm" ? <Button
          disabled={blocked || Boolean(finalizeDisabledReason(props.dirty, props.feedback))}
          onClick={() => void wizard.handleFinalize()}
        >
          Prepare finalization plan
        </Button> : null}
        {step.stage === "identity" || step.stage === "destinations_access" || step.kind === "field-collection" ? props.supplementaryActions : null}
      </div>
      <p className="text-xs text-fg-muted">
        {finalizeDisabledReason(props.dirty, props.feedback) ??
          "Finalization still requires exact confirmation through the Gateway Change Plan."}
      </p>
      <Dialog
        open={reviewTest !== null}
        title="Run a live channel test?"
        description="This Gateway test checks credentials and may send a sandbox message to the configured destination. It does not finalize the connection."
        onOpenChange={(open) => {
          if (!open) setReviewTest(null);
        }}
      >
        <p className="text-sm">
          {props.definition.catalog.label} · {props.label || "Unnamed draft"} · reviewed draft revision{" "}
          {props.draft.revision}
        </p>
        {reviewTest !== signature ? (
          <p role="alert" className="text-status-waiting">
            The reviewed input changed. Close this dialog and review the current draft.
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={blocked || reviewTest !== signature}
            onClick={() => {
              setReviewTest(null);
              void wizard.handleTest();
            }}
          >
            Run reviewed live test
          </Button>
          <Button onClick={() => setReviewTest(null)}>Cancel test</Button>
        </div>
      </Dialog>
    </section>
  );
}
