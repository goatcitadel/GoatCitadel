import { useEffect, useMemo, useState } from "react";
import type { ChangePlanPublicFormField, ChangePlanRecord, ChangePlanRequiredAction } from "@goatcitadel/contracts";
import { GCModal } from "../ui";

export type ChangePlanPublicValues = Readonly<Record<string, string | number | boolean>>;

export interface ChatChangePlanActionDialogProps {
  readonly plan: ChangePlanRecord | null;
  readonly linkedPlan?: ChangePlanRecord | null;
  readonly pending?: boolean;
  readonly error?: string | null;
  readonly contextNote?: string;
  readonly onClose: () => void;
  readonly onConfirm: (plan: ChangePlanRecord) => void | Promise<void>;
  readonly onSubmitPublicForm: (plan: ChangePlanRecord, values: ChangePlanPublicValues) => void | Promise<void>;
  readonly onSubmitSecureInput: (
    plan: ChangePlanRecord,
    values: Readonly<Record<string, string>>,
  ) => void | Promise<void>;
  readonly onContinueOAuth: (plan: ChangePlanRecord) => void | Promise<void>;
  readonly onOpenApproval: (plan: ChangePlanRecord) => void | Promise<void>;
  readonly onReviewArtifacts: (plan: ChangePlanRecord) => void | Promise<void>;
  readonly onOpenNativePathPicker: (plan: ChangePlanRecord) => void | Promise<void>;
}

/**
 * Renders only server-described Change Plan actions. Secret input is held in
 * component memory only and cleared before the owner callback resolves. Native
 * paths never have a text input and therefore cannot enter a generic response.
 */
export function ChatChangePlanActionDialog({
  plan,
  linkedPlan,
  pending = false,
  error,
  contextNote,
  onClose,
  onConfirm,
  onSubmitPublicForm,
  onSubmitSecureInput,
  onContinueOAuth,
  onOpenApproval,
  onReviewArtifacts,
  onOpenNativePathPicker,
}: ChatChangePlanActionDialogProps) {
  const action = plan?.requiredAction;
  const actionKey = action ? `${plan.planId}:${plan.revision}:${action.actionId}` : "closed";
  const publicFormFields = action?.kind === "public_form" ? action.fields : undefined;
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [secureValues, setSecureValues] = useState<Record<string, string>>({});

  useEffect(() => {
    setValues(
      publicFormFields
        ? Object.fromEntries(
            publicFormFields.flatMap((field) =>
              field.initialValue === undefined ? [] : [[field.fieldId, field.initialValue]],
            ),
          )
        : {},
    );
    setSecureValues({});
  }, [actionKey, publicFormFields]);

  const missingRequired = useMemo(() => {
    if (action?.kind !== "public_form") return false;
    return action.fields.some((field) => field.required && isMissing(field, values[field.fieldId]));
  }, [action, values]);

  if (!plan || !action) return null;

  const submit = async () => {
    switch (action.kind) {
      case "confirmation":
        await onConfirm(plan);
        return;
      case "public_form":
        await onSubmitPublicForm(plan, values);
        return;
      case "secure_input": {
        const submittedValues = { ...secureValues };
        setSecureValues({});
        await onSubmitSecureInput(plan, submittedValues);
        return;
      }
      case "oauth":
        await onContinueOAuth(plan);
        return;
      case "approval":
        await onOpenApproval(plan);
        return;
      case "artifact_review":
        await onReviewArtifacts(plan);
        return;
      case "native_path_picker":
        await onOpenNativePathPicker(plan);
        return;
    }
  };

  return (
    <GCModal
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={linkedPlan ? "Apply model to this Chat and future Chats?" : action.title}
      description={[dialogDescription(plan, action), linkedPlan ? linkedPlan.summary : undefined, contextNote]
        .filter(Boolean)
        .join("\n\n")}
      confirmLabel={linkedPlan ? "Apply both exact changes" : confirmLabel(action)}
      danger={plan.risk === "danger" || linkedPlan?.risk === "danger"}
      confirmPending={pending}
      confirmDisabled={
        missingRequired ||
        (action.kind === "secure_input" &&
          secureFields(action).some((field) => field.required !== false && !secureValues[field.fieldId]?.trim())) ||
        (action.kind === "secure_input" && !Object.values(secureValues).some((value) => value.trim().length > 0)) ||
        Boolean(linkedPlan && linkedPlan.requiredAction?.kind !== "confirmation")
      }
      dismissDisabled={pending}
      onConfirm={submit}
    >
      <div className="chat-change-plan-action-dialog" data-action-kind={action.kind}>
        <dl>
          <div>
            <dt>Scope</dt>
            <dd>{scopeLabel(plan)}</dd>
          </div>
          <div>
            <dt>Risk</dt>
            <dd>{plan.risk}</dd>
          </div>
          <div>
            <dt>Exact revision</dt>
            <dd>{plan.revision}</dd>
          </div>
        </dl>
        {linkedPlan ? (
          <section className="chat-change-plan-linked-scope" aria-label="Linked future Chat default">
            <strong>Also change future Chats</strong>
            <p>{linkedPlan.title}</p>
            <dl>
              <div>
                <dt>Scope</dt>
                <dd>{scopeLabel(linkedPlan)}</dd>
              </div>
              <div>
                <dt>Exact revision</dt>
                <dd>{linkedPlan.revision}</dd>
              </div>
            </dl>
          </section>
        ) : null}
        {action.kind === "public_form" ? (
          <div className="chat-change-plan-form">
            {action.fields.map((field) => (
              <PublicField
                key={field.fieldId}
                field={field}
                value={values[field.fieldId]}
                onChange={(value) => setValues((current) => ({ ...current, [field.fieldId]: value }))}
              />
            ))}
          </div>
        ) : null}
        {action.kind === "secure_input" ? (
          <div className="chat-change-plan-form">
            {secureFields(action).map((field) => (
              <label className="chat-change-plan-field" key={field.fieldId}>
                <span>
                  {field.label}
                  {field.required === false ? "" : " *"}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={secureValues[field.fieldId] ?? ""}
                  onChange={(event) =>
                    setSecureValues((current) => ({
                      ...current,
                      [field.fieldId]: event.currentTarget.value,
                    }))
                  }
                  aria-describedby={`change-plan-secret-custody-${field.fieldId}`}
                />
                <small id={`change-plan-secret-custody-${field.fieldId}`}>
                  {field.description ??
                    "Sent only to the Gateway's dedicated secure owner. It is not added to Chat or model context."}
                </small>
              </label>
            ))}
          </div>
        ) : null}
        {action.kind === "artifact_review" ? (
          <div className="chat-change-plan-artifact-review">
            <p>Review these immutable evidence references before continuing:</p>
            <ul>
              {action.artifactRefs.map((reference) => (
                <li key={reference}>{reference}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {action.kind === "native_path_picker" ? (
          <p>The source path is selected by the native desktop picker and is never exposed to Chat or the model.</p>
        ) : null}
        {action.kind === "approval" ? (
          <p>This change requires a separate canonical approval. Opening it does not apply the change.</p>
        ) : null}
        {action.kind === "oauth" ? (
          <p>Authorization continues in the provider-owned OAuth flow. Tokens never pass through this dialog.</p>
        ) : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </GCModal>
  );
}

function secureFields(action: Extract<ChangePlanRequiredAction, { kind: "secure_input" }>) {
  return action.fields?.length ? action.fields : [{ fieldId: "credential", label: "Credential", required: true }];
}

function PublicField({
  field,
  value,
  onChange,
}: {
  field: ChangePlanPublicFormField;
  value: string | number | boolean | undefined;
  onChange: (value: string | number | boolean) => void;
}) {
  if (field.type === "boolean") {
    return (
      <label className="chat-change-plan-field chat-change-plan-checkbox">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.currentTarget.checked)} />
        <span>
          {field.label}
          {field.required ? " *" : ""}
        </span>
        {field.description ? <small>{field.description}</small> : null}
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <label className="chat-change-plan-field">
        <span>
          {field.label}
          {field.required ? " *" : ""}
        </span>
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          <option value="">Choose…</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {field.description ? <small>{field.description}</small> : null}
      </label>
    );
  }
  return (
    <label className="chat-change-plan-field">
      <span>
        {field.label}
        {field.required ? " *" : ""}
      </span>
      <input
        type={field.type === "number" ? "number" : field.type === "url" ? "url" : "text"}
        value={typeof value === "string" || typeof value === "number" ? value : ""}
        onChange={(event) =>
          onChange(field.type === "number" ? event.currentTarget.valueAsNumber : event.currentTarget.value)
        }
      />
      {field.description ? <small>{field.description}</small> : null}
    </label>
  );
}

function isMissing(field: ChangePlanPublicFormField, value: string | number | boolean | undefined): boolean {
  if (field.type === "boolean") return value !== true;
  if (field.type === "number") return typeof value !== "number" || !Number.isFinite(value);
  return typeof value !== "string" || value.trim().length === 0;
}

function confirmLabel(action: ChangePlanRequiredAction): string {
  switch (action.kind) {
    case "public_form":
      return action.submitLabel ?? "Submit details";
    case "secure_input":
      return "Submit securely";
    case "oauth":
      return "Continue to OAuth";
    case "native_path_picker":
      return "Open native picker";
    case "approval":
      return "Open or resume approval";
    case "artifact_review":
      return "Artifacts reviewed";
    case "confirmation":
      return action.purpose === "rollback" ? "Confirm rollback" : "Apply exact change";
  }
}

function dialogDescription(plan: ChangePlanRecord, action: ChangePlanRequiredAction): string {
  if (action.kind === "confirmation") return `${action.confirmationText}\n\n${plan.impact}`;
  return `${plan.summary} ${plan.impact}`;
}

function scopeLabel(plan: ChangePlanRecord): string {
  switch (plan.scope) {
    case "current_chat":
      return "Current Chat only";
    case "installation":
      return "Future Chats and installation defaults";
    case "provider":
      return "Provider connection";
    case "runtime":
      return "Runtime configuration";
    case "channel":
      return "Channel connection";
    case "remediation":
      return "Governed repair";
    case "capability":
      return "Capability lifecycle";
    case "improvement":
      return "Improvement lifecycle";
    case "product_source":
      return "Registered GoatCitadel source";
  }
}
