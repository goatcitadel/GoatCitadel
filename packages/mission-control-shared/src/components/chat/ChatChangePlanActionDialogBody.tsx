import { useEffect, type Dispatch, type SetStateAction, type ReactNode } from "react";
import type {
  CandidateSkillArtifactReview,
  ChangePlanPublicFormField,
  ChangePlanRecord,
  ChangePlanRequiredAction,
} from "@goatcitadel/contracts";
import { secureFields } from "./change-plan-secure-fields";
type ArtifactItems = CandidateSkillArtifactReview["artifacts"];
type Props = {
  plan: ChangePlanRecord;
  action: ChangePlanRequiredAction;
  linkedPlan?: ChangePlanRecord | null;
  pending: boolean;
  error?: string | null;
  values: Record<string, string | number | boolean>;
  setValues: Dispatch<SetStateAction<Record<string, string | number | boolean>>>;
  secureValues: Record<string, string>;
  setSecureValues: Dispatch<SetStateAction<Record<string, string>>>;
  artifactKey?: string;
  artifactItems?: ArtifactItems;
  artifactError?: string;
  hasArtifactData: boolean;
  needsCandidatePreview: boolean;
  actionKey: string;
  renderApprovalAction?: (plan: ChangePlanRecord, pending: boolean) => ReactNode;
  onReady: Dispatch<SetStateAction<boolean>>;
};
export function ChatChangePlanActionDialogBody({
  plan,
  action,
  linkedPlan,
  pending,
  error,
  values,
  setValues,
  secureValues,
  setSecureValues,
  artifactKey,
  artifactItems,
  artifactError,
  hasArtifactData,
  needsCandidatePreview,
  actionKey,
  renderApprovalAction,
  onReady,
}: Props) {
  useEffect(() => {
    onReady(true);
  }, [onReady]);
  return (
    <div className="chat-change-plan-action-dialog" data-action-kind={action.kind}>
      {action.kind === "approval" && renderApprovalAction ? renderApprovalAction(plan, pending) : null}
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
          {needsCandidatePreview ? (
            artifactKey === actionKey && hasArtifactData ? (
              <div aria-label="Verified candidate artifacts">
                {artifactItems!.map((artifact) => (
                  <details key={artifact.artifactRef} open={artifact.label === "Instructions"}>
                    <summary>{artifact.label}</summary>
                    {/* A bounded scroll region must be keyboard-reachable and named. */}
                    <pre
                      role="region"
                      aria-label={`${artifact.label} artifact content`}
                      tabIndex={0}
                      style={{
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        maxHeight: "24rem",
                        overflow: "auto",
                      }}
                    >
                      {artifact.content}
                    </pre>
                  </details>
                ))}
              </div>
            ) : (
              <p role="status">
                {artifactKey === actionKey && artifactError ? artifactError : "Loading verified artifacts…"}
              </p>
            )
          ) : null}
          <ul aria-label="Immutable evidence references" tabIndex={0}>
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
  );
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
