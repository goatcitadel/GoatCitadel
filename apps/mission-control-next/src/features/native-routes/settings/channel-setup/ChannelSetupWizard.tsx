import { useState } from "react";
import { Dialog } from "../../../../cockpit/ui/Dialog";
import { ChannelWizardFields } from "./ChannelWizardFieldCollection";
import { ChannelCheckFeedback } from "./ChannelCheckFeedback";
import { ChannelDraftEvidencePanel } from "./ChannelDraftEvidencePanel";
import type {
  ChannelSetupRichBlock,
  ChannelSetupStepDefinition,
} from "@goatcitadel/contracts";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, FileJson2, Play, Save, ShieldCheck } from "lucide-react";
import { NativeButton } from "../../primitives";
import { SettingsButtonRow } from "../SettingsShared";
import { useChannelWizard } from "./use-channel-wizard";
import {
  isStepComplete,
  humanizeStepKind,
  channelStageLabel,
  wizardValuesWithDefaults,
  finalizeDisabledReason,
  formatJson,
  type ChannelSetupWizardProps,
  type ChannelSetupWizardFeedback,
} from "./channel-wizard-model";
export type { ChannelSetupWizardFeedback } from "./channel-wizard-model";
export function ChannelSetupWizard(props: ChannelSetupWizardProps) {
  const [reviewTest, setReviewTest] = useState<string | null>(null);
  const {
    definition,
    draft,
    values,
    label,
    enabled,
    dirty,
    reviewRequired = false,
    busyAction = null,
    feedback,
    supplementaryActions,
    onValuesChange,
    onLabelChange,
    onEnabledChange,
    onDirty,
  } = props;
  const {
    visibleSteps,
    activeStepIndex,
    activeStep,
    anyBusy,
    actionsBlocked,
    visitedStepIds,
    checkedItems,
    setCheckedItems,
    advancedMode,
    setAdvancedMode,
    advancedJson,
    setAdvancedJson,
    localError,
    setLocalError,
    stepHeadingRef,
    selectStep,
    switchToGuidedMode,
    handleSave,
    handleValidate,
    handleTest,
    handleFinalize,
    moveForward,
  } = useChannelWizard(props);
  const testSignature = JSON.stringify([props.scopeId, props.definition.catalog.catalogId, props.draft.draftId, props.draft.revision, props.values, advancedMode, advancedJson, props.label, props.enabled]);
  if (!activeStep) {
    return <p className="mc-next-settings-field-note">This channel definition has no setup steps.</p>;
  }

  return (
    <section
      className="mc-next-channel-wizard"
      aria-label={`${definition.catalog.label} guided setup`}
      aria-busy={anyBusy}
    >
      <header className="mc-next-channel-wizard-summary">
        <div>
          <p className="mc-next-channel-wizard-kicker">Guided channel setup</p>
          <h3>{definition.catalog.label}</h3>
          <p>{definition.wizard.introSummary}</p>
        </div>
        <dl className="mc-next-channel-wizard-meta">
          <div>
            <dt>Difficulty</dt>
            <dd>{definition.wizard.difficulty}</dd>
          </div>
          <div>
            <dt>Estimate</dt>
            <dd>{definition.wizard.estimatedMinutes} min</dd>
          </div>
          <div>
            <dt>Draft</dt>
            <dd className={dirty ? "dirty" : "saved"}>{dirty ? "Unsaved changes" : "Saved"}</dd>
          </div>
        </dl>
      </header>

      <details open={definition.wizard.manualModePolicy === "expert-forward" || advancedMode}>
      <summary>Advanced setup options</summary>
      <div className="mc-next-channel-wizard-mode" role="group" aria-label="Setup editor mode">
        <NativeButton
          variant={advancedMode ? "secondary" : "outline"}
          aria-pressed={!advancedMode}
          onClick={switchToGuidedMode}
          disabled={anyBusy}
        >
          <CheckCircle2 size={16} />
          Guided setup
        </NativeButton>
        <NativeButton
          variant={advancedMode ? "outline" : "secondary"}
          aria-pressed={advancedMode}
          onClick={() => {
            setAdvancedJson(formatJson(values));
            setAdvancedMode(true);
            setLocalError(null);
          }}
          disabled={anyBusy}
        >
          <FileJson2 size={16} />
          Advanced JSON
        </NativeButton>
      </div>
      </details>

      <div className="mc-next-channel-wizard-identity">
        <label className="mc-next-settings-field">
          <span>Connection label</span>
          <input
            className="mc-next-settings-input"
            value={label}
            onChange={(event) => onLabelChange(event.target.value)}
            placeholder={definition.catalog.label}
            disabled={anyBusy}
          />
        </label>
        <label className="mc-next-settings-field">
          <span>Runtime state after finalize</span>
          <span className="mc-next-settings-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => onEnabledChange(event.target.checked)}
              disabled={anyBusy}
            />
            Enable this connection
          </span>
        </label>
      </div>

      {advancedMode ? (
        <AdvancedJsonEditor
          value={advancedJson}
          disabled={anyBusy}
          localError={localError}
          feedback={feedback}
          dirty={dirty}
          reviewRequired={reviewRequired}
          mutationBlocked={props.mutationBlocked}
          onChange={(next) => {
            setAdvancedJson(next);
            setLocalError(null);
            onDirty();
          }}
          onSave={() => void handleSave()}
          onValidate={() => void handleValidate()}
          onTest={() => setReviewTest(testSignature)}
          onFinalize={() => void handleFinalize()}
          busyAction={busyAction}
          onAcknowledgeTest={props.onAcknowledgeTest}
        />
      ) : (
        <div className="mc-next-channel-wizard-layout">
          <nav className="mc-next-channel-wizard-nav" aria-label="Setup steps">
            <ol>
              {visibleSteps.map((step, index) => {
                const complete = isStepComplete(
                  step,
                  definition,
                  draft,
                  values,
                  visitedStepIds,
                  checkedItems,
                  feedback,
                );
                const active = step.id === activeStep.id;
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      className={`${active ? "active" : ""}${complete ? " complete" : ""}`.trim()}
                      aria-current={active ? "step" : undefined}
                      onClick={() => selectStep(step.id)}
                      disabled={anyBusy}
                    >
                      <span className="mc-next-channel-wizard-step-index">
                        {complete ? <Check size={14} /> : index + 1}
                      </span>
                      <span>
                        <strong>{step.title}</strong>
                        <small>{complete ? "Complete" : active ? "Current step" : humanizeStepKind(step.kind)}</small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          <article className="mc-next-channel-wizard-stage" aria-labelledby={`channel-step-${activeStep.id}`}>
            <header>
              <p>
                Step {activeStepIndex + 1} of {visibleSteps.length}
              </p>
              <h4 ref={stepHeadingRef} id={`channel-step-${activeStep.id}`} tabIndex={-1}>
                {activeStep.title}
              </h4>
              <p>{channelStageLabel(activeStep)}</p>
              {activeStep.description ? <span>{activeStep.description}</span> : null}
            </header>

            <RichBlocks blocks={activeStep.body} />
            <Checklist
              draftId={draft.draftId}
              step={activeStep}
              checkedItems={checkedItems}
              disabled={anyBusy}
              onChange={(key, checked) => setCheckedItems((current) => ({ ...current, [key]: checked }))}
            />
            <ChannelWizardFields
              draft={draft}
              fields={activeStep.fields}
              values={wizardValuesWithDefaults(definition, values)}
              issues={feedback?.issues ?? []}
              disabled={anyBusy}
              onChange={(next) => { onValuesChange(next); setLocalError(null); }}
            />
            <Troubleshooting step={activeStep} />
            <SuccessCriteria items={activeStep.successCriteria} />
            <ChannelCheckFeedback feedback={feedback} error={localError} disabled={actionsBlocked} onAcknowledge={props.onAcknowledgeTest} />

            <footer className="mc-next-channel-wizard-footer">
              <NativeButton
                variant="secondary"
                disabled={activeStepIndex === 0 || anyBusy}
                onClick={() => selectStep(visibleSteps[activeStepIndex - 1]?.id ?? activeStep.id)}
              >
                <ChevronLeft size={16} />
                Back
              </NativeButton>
              <SettingsButtonRow>
                {activeStep.stage === "identity" || activeStep.stage === "destinations_access" || activeStep.kind === "field-collection" ? supplementaryActions : null}
                <NativeButton variant="secondary" disabled={actionsBlocked} onClick={() => void handleSave()}>
                  <Save size={16} />
                  {busyAction === "save" ? "Saving…" : "Save draft"}
                </NativeButton>
                {activeStep.kind === "test" ? (
                  <>
                    <NativeButton
                      variant="secondary"
                      disabled={actionsBlocked}
                      onClick={() => void handleValidate()}
                    >
                      <ShieldCheck size={16} />
                      {busyAction === "validate" ? "Validating…" : "Validate"}
                    </NativeButton>
                    <NativeButton
                      variant="outline"
                      disabled={actionsBlocked}
                      onClick={() => setReviewTest(testSignature)}
                    >
                      <Play size={16} />
                      {busyAction === "test" ? "Testing…" : "Run live test"}
                    </NativeButton>
                  </>
                ) : null}
                {activeStep.kind === "confirm" ? (
                  <NativeButton
                    variant="default"
                    disabled={
                      actionsBlocked || Boolean(finalizeDisabledReason(dirty, feedback))
                    }
                    title={finalizeDisabledReason(dirty, feedback)}
                    onClick={() => void handleFinalize()}
                  >
                    <CheckCircle2 size={16} />
                    {busyAction === "finalize" ? "Finalizing…" : "Finalize connection"}
                  </NativeButton>
                ) : activeStepIndex < visibleSteps.length - 1 ? (
                  <NativeButton variant="default" disabled={actionsBlocked} onClick={() => void moveForward()}>
                    Continue
                    <ChevronRight size={16} />
                  </NativeButton>
                ) : null}
              </SettingsButtonRow>
            </footer>
          </article>
        </div>
      )}
      <ChannelDraftEvidencePanel evidence={props.draftEvidence} loading={props.draftEvidenceLoading} error={props.draftEvidenceError} />
      <Dialog open={reviewTest !== null} title="Run a live channel test?"
        description="Review this draft and destination. The Gateway may post a visible sandbox message; this action does not activate the connection."
        onOpenChange={(open) => { if (!open) setReviewTest(null); }}>
        <p>{definition.catalog.label} · {label || "Unnamed draft"} · revision {draft.revision}</p>
        {reviewTest !== testSignature ? <p role="alert">The reviewed input changed. Close and review the current draft.</p> : null}
        <NativeButton disabled={actionsBlocked || reviewTest !== testSignature}
          onClick={() => { setReviewTest(null); void handleTest(); }}>Run reviewed live test</NativeButton>
        <NativeButton onClick={() => setReviewTest(null)}>Cancel test</NativeButton>
      </Dialog>
    </section>
  );
}

function AdvancedJsonEditor({
  value,
  disabled,
  localError,
  feedback,
  dirty,
  reviewRequired,
  mutationBlocked = false,
  busyAction,
  onChange,
  onSave,
  onValidate,
  onTest,
  onFinalize,
  onAcknowledgeTest,
}: {
  value: string;
  disabled: boolean;
  localError: string | null;
  feedback?: ChannelSetupWizardFeedback | null;
  dirty: boolean;
  reviewRequired: boolean;
  mutationBlocked?: boolean;
  busyAction?: ChannelSetupWizardProps["busyAction"];
  onChange: (next: string) => void;
  onSave: () => void;
  onValidate: () => void;
  onTest: () => void;
  onFinalize: () => void;
  onAcknowledgeTest?: (kind: "cleanup" | "receipt") => Promise<void>;
}) {
  return (
    <article className="mc-next-channel-wizard-advanced">
      <header>
        <div>
          <h4>Advanced configuration JSON</h4>
          <p>Use this only when a guided field does not expose a supported adapter option.</p>
        </div>
        <span className="mc-next-channel-wizard-sensitive">Secrets are redacted after save</span>
      </header>
      <label className="mc-next-settings-field">
        <span>Draft JSON</span>
        <textarea
          className="mc-next-settings-textarea mc-next-settings-code"
          aria-label="Draft JSON"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          rows={18}
          spellCheck={false}
        />
      </label>
      <ChannelCheckFeedback feedback={feedback} error={localError} disabled={disabled || reviewRequired || mutationBlocked} onAcknowledge={onAcknowledgeTest} />
      <SettingsButtonRow>
        <NativeButton variant="secondary" disabled={disabled || reviewRequired || mutationBlocked} onClick={onSave}>
          <Save size={16} />
          {busyAction === "save" ? "Saving…" : "Save draft"}
        </NativeButton>
        <NativeButton variant="secondary" disabled={disabled || reviewRequired || mutationBlocked} onClick={onValidate}>
          <ShieldCheck size={16} />
          {busyAction === "validate" ? "Validating…" : "Validate"}
        </NativeButton>
        <NativeButton variant="outline" disabled={disabled || reviewRequired || mutationBlocked} onClick={onTest}>
          <Play size={16} />
          {busyAction === "test" ? "Testing…" : "Run live test"}
        </NativeButton>
        <NativeButton
          variant="default"
          disabled={disabled || reviewRequired || mutationBlocked || Boolean(finalizeDisabledReason(dirty, feedback))}
          title={finalizeDisabledReason(dirty, feedback)}
          onClick={onFinalize}
        >
          <CheckCircle2 size={16} />
          {busyAction === "finalize" ? "Finalizing…" : "Finalize connection"}
        </NativeButton>
      </SettingsButtonRow>
    </article>
  );
}

function Checklist({
  draftId,
  step,
  checkedItems,
  disabled,
  onChange,
}: {
  draftId: string;
  step: ChannelSetupStepDefinition;
  checkedItems: Record<string, boolean>;
  disabled: boolean;
  onChange: (key: string, checked: boolean) => void;
}) {
  if (!step.checklist?.length) {
    return null;
  }
  return (
    <fieldset className="mc-next-channel-wizard-checklist">
      <legend>Operator checklist</legend>
      {step.checklist.map((item) => {
        const key = `${draftId}:${step.id}:${item.id}`;
        return (
          <label key={item.id}>
            <input
              type="checkbox"
              checked={Boolean(checkedItems[key])}
              onChange={(event) => onChange(key, event.target.checked)}
              disabled={disabled}
            />
            <span>
              <strong>{item.label}</strong>
              {item.detail ? <small>{item.detail}</small> : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function RichBlocks({ blocks }: { blocks?: ChannelSetupRichBlock[] }) {
  if (!blocks?.length) {
    return null;
  }
  return (
    <div className="mc-next-channel-wizard-rich">
      {blocks.map((block, index) => {
        if (block.kind === "paragraph") {
          return <p key={index}>{block.text}</p>;
        }
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={index}>
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </List>
          );
        }
        if (block.kind === "note") {
          return (
            <aside key={index} className={`mc-next-channel-wizard-note ${block.tone}`}>
              {block.title ? <strong>{block.title}</strong> : null}
              <span>{block.text}</span>
            </aside>
          );
        }
        if (block.kind === "link") {
          return (
            <a key={index} href={block.href} target="_blank" rel="noreferrer noopener">
              {block.label}
              <span aria-hidden="true"> ↗</span>
            </a>
          );
        }
        return (
          <pre key={index}>
            <code>{block.code}</code>
          </pre>
        );
      })}
    </div>
  );
}

function Troubleshooting({ step }: { step: ChannelSetupStepDefinition }) {
  if (!step.troubleshooting?.length) {
    return null;
  }
  return (
    <details className="mc-next-channel-wizard-troubleshooting">
      <summary>Troubleshooting</summary>
      <div>
        {step.troubleshooting.map((item) => (
          <article key={item.id}>
            <strong>{item.title}</strong>
            <p>{item.body}</p>
            {item.nextSteps?.length ? (
              <ul>
                {item.nextSteps.map((next) => (
                  <li key={next}>{next}</li>
                ))}
              </ul>
            ) : null}
          </article>
        ))}
      </div>
    </details>
  );
}

function SuccessCriteria({ items }: { items?: string[] }) {
  if (!items?.length) {
    return null;
  }
  return (
    <section className="mc-next-channel-wizard-success">
      <strong>Ready when</strong>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
