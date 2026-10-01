import type {
  ChannelSetupDraft,
  ChannelSetupFieldDefinition,
  ChannelSetupRichBlock,
  ChannelSetupStepDefinition,
  ChannelSetupIssue,
} from "@goatcitadel/contracts";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, FileJson2, Play, Save, ShieldCheck } from "lucide-react";
import { NativeButton } from "../../primitives";
import { SettingsButtonRow } from "../SettingsShared";
import { useChannelWizard } from "./use-channel-wizard";
import {
  isStepComplete,
  updateFieldValue,
  humanizeStepKind,
  finalizeDisabledReason,
  formatJson,
  SECRET_REDACTION_MARKER,
  type ChannelSetupWizardProps,
  type ChannelSetupWizardFeedback,
} from "./channel-wizard-model";
export type { ChannelSetupWizardFeedback } from "./channel-wizard-model";
export function ChannelSetupWizard(props: ChannelSetupWizardProps) {
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
          onChange={(next) => {
            setAdvancedJson(next);
            setLocalError(null);
            onDirty();
          }}
          onSave={() => void handleSave()}
          onValidate={() => void handleValidate()}
          onTest={() => void handleTest()}
          onFinalize={() => void handleFinalize()}
          busyAction={busyAction}
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
            <FieldCollection
              draft={draft}
              fields={activeStep.fields}
              values={values}
              issues={feedback?.issues ?? []}
              disabled={anyBusy}
              onChange={(field, next) => {
                onValuesChange(updateFieldValue(draft, values, field, next));
                setLocalError(null);
              }}
            />
            <Troubleshooting step={activeStep} />
            <SuccessCriteria items={activeStep.successCriteria} />
            <WizardFeedback feedback={feedback} localError={localError} />

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
                {supplementaryActions}
                <NativeButton variant="secondary" disabled={anyBusy} onClick={() => void handleSave()}>
                  <Save size={16} />
                  {busyAction === "save" ? "Saving…" : "Save draft"}
                </NativeButton>
                {activeStep.kind === "test" ? (
                  <>
                    <NativeButton
                      variant="secondary"
                      disabled={anyBusy || reviewRequired}
                      onClick={() => void handleValidate()}
                    >
                      <ShieldCheck size={16} />
                      {busyAction === "validate" ? "Validating…" : "Validate"}
                    </NativeButton>
                    <NativeButton
                      variant="outline"
                      disabled={anyBusy || reviewRequired}
                      onClick={() => void handleTest()}
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
                      anyBusy || reviewRequired || dirty || feedback?.kind !== "test" || feedback.status !== "ok"
                    }
                    title={finalizeDisabledReason(dirty, feedback)}
                    onClick={() => void handleFinalize()}
                  >
                    <CheckCircle2 size={16} />
                    {busyAction === "finalize" ? "Finalizing…" : "Finalize connection"}
                  </NativeButton>
                ) : activeStepIndex < visibleSteps.length - 1 ? (
                  <NativeButton variant="default" disabled={anyBusy} onClick={() => void moveForward()}>
                    Continue
                    <ChevronRight size={16} />
                  </NativeButton>
                ) : null}
              </SettingsButtonRow>
            </footer>
          </article>
        </div>
      )}
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
  busyAction,
  onChange,
  onSave,
  onValidate,
  onTest,
  onFinalize,
}: {
  value: string;
  disabled: boolean;
  localError: string | null;
  feedback?: ChannelSetupWizardFeedback | null;
  dirty: boolean;
  reviewRequired: boolean;
  busyAction?: ChannelSetupWizardProps["busyAction"];
  onChange: (next: string) => void;
  onSave: () => void;
  onValidate: () => void;
  onTest: () => void;
  onFinalize: () => void;
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
      <WizardFeedback feedback={feedback} localError={localError} />
      <SettingsButtonRow>
        <NativeButton variant="secondary" disabled={disabled} onClick={onSave}>
          <Save size={16} />
          {busyAction === "save" ? "Saving…" : "Save draft"}
        </NativeButton>
        <NativeButton variant="secondary" disabled={disabled || reviewRequired} onClick={onValidate}>
          <ShieldCheck size={16} />
          {busyAction === "validate" ? "Validating…" : "Validate"}
        </NativeButton>
        <NativeButton variant="outline" disabled={disabled || reviewRequired} onClick={onTest}>
          <Play size={16} />
          {busyAction === "test" ? "Testing…" : "Run live test"}
        </NativeButton>
        <NativeButton
          variant="default"
          disabled={disabled || reviewRequired || dirty || feedback?.kind !== "test" || feedback.status !== "ok"}
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

function FieldCollection({
  draft,
  fields,
  values,
  issues,
  disabled,
  onChange,
}: {
  draft: ChannelSetupDraft;
  fields?: ChannelSetupFieldDefinition[];
  values: Record<string, unknown>;
  issues: ChannelSetupIssue[];
  disabled: boolean;
  onChange: (field: ChannelSetupFieldDefinition, next: unknown) => void;
}) {
  if (!fields?.length) {
    return null;
  }
  return (
    <div className="mc-next-channel-wizard-fields">
      {fields.map((field) => {
        const fieldIssues = issues.filter((issue) => issue.fieldKey === field.key);
        const rawValue = values[field.key];
        const hasReplacement =
          typeof rawValue === "string" && rawValue.trim().length > 0 && rawValue !== SECRET_REDACTION_MARKER;
        const configuredSecret = Boolean(
          field.sensitive &&
          (rawValue === SECRET_REDACTION_MARKER ||
            (draft.hydration?.fieldState[field.key] === "configured" && !hasReplacement)),
        );
        const inputId = `channel-${draft.draftId}-${field.key}`;
        const descriptionId = `${inputId}-description`;
        const errorId = `${inputId}-error`;
        const currentValue = configuredSecret ? "" : (values[field.key] ?? field.defaultValue ?? "");
        return (
          <div key={field.key} className="mc-next-channel-wizard-field">
            <label htmlFor={inputId}>
              <span>
                {field.label}
                {field.required ? <b aria-label="required">Required</b> : null}
                {field.sensitive ? <b className="sensitive">Sensitive</b> : null}
              </span>
              <FieldInput
                id={inputId}
                field={field}
                value={currentValue}
                disabled={disabled}
                configuredSecret={configuredSecret}
                ariaDescribedBy={[descriptionId, fieldIssues.length ? errorId : ""].filter(Boolean).join(" ")}
                invalid={fieldIssues.length > 0}
                required={field.required}
                onChange={(next) => onChange(field, next)}
              />
            </label>
            <p id={descriptionId}>
              {configuredSecret ? "A value is configured. Enter a replacement only to rotate it." : field.explanation}
            </p>
            {field.whyNeeded ? <p className="mc-next-channel-wizard-why">Why: {field.whyNeeded}</p> : null}
            {fieldIssues.length > 0 ? (
              <div id={errorId} className="mc-next-channel-wizard-field-errors" role="alert">
                {fieldIssues.map((issue) => (
                  <span key={issue.key}>{issue.message}</span>
                ))}
              </div>
            ) : null}
            {field.whereToFind?.length || field.looksLike || field.commonMistakes?.length ? (
              <details className="mc-next-channel-wizard-field-help">
                <summary>Where to find this</summary>
                <RichBlocks blocks={field.whereToFind} />
                {field.looksLike ? (
                  <p>
                    <strong>Looks like:</strong> {field.looksLike}
                  </p>
                ) : null}
                {field.commonMistakes?.length ? (
                  <div>
                    <strong>Common mistakes</strong>
                    <ul>
                      {field.commonMistakes.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </details>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function FieldInput({
  id,
  field,
  value,
  disabled,
  configuredSecret,
  ariaDescribedBy,
  invalid,
  required,
  onChange,
}: {
  id: string;
  field: ChannelSetupFieldDefinition;
  value: unknown;
  disabled: boolean;
  configuredSecret: boolean;
  ariaDescribedBy: string;
  invalid: boolean;
  required: boolean;
  onChange: (next: unknown) => void;
}) {
  if (field.type === "boolean") {
    return (
      <span className="mc-next-settings-toggle">
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          disabled={disabled}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid}
          required={required}
          onChange={(event) => onChange(event.target.checked)}
        />
        {value ? "Enabled" : "Disabled"}
      </span>
    );
  }
  if (field.type === "select") {
    return (
      <select
        id={id}
        className="mc-next-settings-input"
        value={String(value ?? "")}
        disabled={disabled}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
            {option.hint ? ` — ${option.hint}` : ""}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "textarea") {
    return (
      <textarea
        id={id}
        className="mc-next-settings-textarea"
        value={String(value ?? "")}
        disabled={disabled}
        placeholder={field.placeholder}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  const inputType = field.type === "secret" || field.sensitive ? "password" : field.type === "url" ? "url" : "text";
  return (
    <input
      id={id}
      className="mc-next-settings-input"
      type={inputType}
      inputMode={field.type === "id" ? "numeric" : undefined}
      autoComplete={field.type === "secret" || field.sensitive ? "new-password" : "off"}
      value={String(value ?? "")}
      disabled={disabled}
      placeholder={configuredSecret ? "Configured — enter a replacement to rotate" : field.placeholder}
      aria-describedby={ariaDescribedBy}
      aria-invalid={invalid}
      required={required}
      onChange={(event) => onChange(event.target.value)}
    />
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

function WizardFeedback({
  feedback,
  localError,
}: {
  feedback?: ChannelSetupWizardFeedback | null;
  localError?: string | null;
}) {
  if (!feedback && !localError) {
    return null;
  }
  return (
    <section
      className={`mc-next-channel-wizard-feedback ${localError ? "error" : (feedback?.status ?? "idle")}`}
      aria-live="polite"
    >
      <strong>
        {localError
          ? "Setup needs attention"
          : feedback?.kind === "test"
            ? feedback.status === "ok"
              ? "Live test passed"
              : "Live test results"
            : feedback?.status === "ok"
              ? "Validation passed"
              : "Validation results"}
      </strong>
      {localError ? <p>{localError}</p> : null}
      {feedback?.issues.length ? (
        <ul>
          {feedback.issues.map((issue) => (
            <li key={issue.key} className={issue.level}>
              <span>{issue.message}</span>
              {issue.nextSteps?.length ? <small>{issue.nextSteps.join(" ")}</small> : null}
            </li>
          ))}
        </ul>
      ) : feedback ? (
        <p>No issues returned.</p>
      ) : null}
      {feedback?.probe?.steps.length ? (
        <div className="mc-next-channel-wizard-probe" aria-label="Live connection probe">
          <strong>Connection checks</strong>
          <ol>
            {feedback.probe.steps.map((step) => (
              <li key={step.key} className={step.status}>
                <span>{step.status}</span>
                <div>
                  <b>{step.label}</b>
                  <small>{step.message}</small>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {feedback?.recommendedNextAction ? (
        <p className="mc-next-channel-wizard-next-action">
          <strong>Next:</strong> {feedback.recommendedNextAction}
        </p>
      ) : null}
    </section>
  );
}
