import type { ChannelSetupDraft, ChannelSetupFieldDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import {
  updateFieldValue,
  SECRET_REDACTION_MARKER,
  isFieldVisible,
  hasFieldValue,
} from "./channel-wizard-model";
import { ChannelRichBlocks } from "../../../../cockpit/areas/settings/ChannelWizardContent";
import { ChannelStructuredField } from "./ChannelStructuredField";

export const channelInputClass =
  "mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg";
export function ChannelWizardFields({
  draft,
  fields = [],
  values,
  issues = [],
  disabled,
  onChange,
}: {
  draft: ChannelSetupDraft;
  fields?: ChannelSetupFieldDefinition[];
  values: Record<string, unknown>;
  issues?: ChannelSetupIssue[];
  disabled: boolean;
  onChange: (values: Record<string, unknown>) => void;
}) {
  const visible = fields.filter((field) => isFieldVisible(field, values));
  const staysVisible = (field: ChannelSetupFieldDefinition) => !field.advanced ||
    field.required && !hasFieldValue(draft, values, field.key) || issues.some((issue) => issue.fieldKey === field.key && issue.level === "error");
  const primary = visible.filter(staysVisible);
  const advanced = visible.filter((field) => !staysVisible(field));
  const renderField = (field: ChannelSetupFieldDefinition) => {
        const id = `channel-${draft.draftId}-${field.key}`,
          help = `${id}-help`;
        const value = values[field.key] ?? field.defaultValue ?? "";
        const sensitive = field.sensitive || field.type === "secret";
        const configured = value === SECRET_REDACTION_MARKER || draft.hydration?.fieldState[field.key] === "configured" || draft.secretState[field.key]?.configured === true;
        const change = (next: unknown) => onChange(updateFieldValue(draft, values, { ...field, sensitive }, next));
        const receiptField = draft.catalogId === "channel.slack" && ["slackInstallId", "slackTeamId", "slackAppId", "slackBotUserId", "slackScopes", "slackInstallerUserId", "oauthConnectedAt", "authMode"].includes(field.key);
        const receiptValue = draft.draft[field.key];
        const common = {
          id,
          "aria-describedby": [help, ...issues.filter((issue) => issue.fieldKey === field.key).map((_, index) => `${id}-issue-${index}`)].join(" "),
          "aria-invalid": issues.some((issue) => issue.fieldKey === field.key && issue.level === "error") || undefined,
          disabled,
          required: field.required,
          className: channelInputClass,
        };
        return (
          <div key={field.key} className="min-w-0">
            <label htmlFor={id} className="text-sm font-medium">
              {field.label}
              {field.required ? " (required)" : ""}
            </label>
            {receiptField ? (
              <div className="space-y-2">
                <input {...common} readOnly value={typeof receiptValue === "string" ? receiptValue : Array.isArray(receiptValue) ? receiptValue.filter((item) => typeof item === "string").join(", ") : ""} placeholder="Use the Slack authorization controls below" />
                <p className="text-xs text-fg-muted">Saved authorization receipt. Change this workspace or app through the reviewed OAuth controls.</p>
                {field.key === "slackInstallId" && typeof draft.draft.slackInstallId === "string" ? <dl className="space-y-1 text-xs">
                  <dt>Saved workspace</dt><dd className="break-all">{typeof draft.draft.slackTeamName === "string" ? draft.draft.slackTeamName : typeof draft.draft.slackTeamId === "string" ? draft.draft.slackTeamId : "Not recorded"}</dd>
                  <dt>Saved app and bot</dt><dd className="break-all">{typeof draft.draft.slackAppId === "string" ? draft.draft.slackAppId : "Not recorded"} · {typeof draft.draft.slackBotUserId === "string" ? draft.draft.slackBotUserId : "Not recorded"}</dd>
                  <dt>Saved scopes</dt><dd className="break-words">{Array.isArray(draft.draft.slackScopes) ? draft.draft.slackScopes.filter((item) => typeof item === "string").join(", ") : "Not recorded"}</dd>
                </dl> : null}
              </div>
            ) : field.type === "target-list" || field.type === "sender-list" ? (
              <ChannelStructuredField field={field} value={value} id={id} describedBy={common["aria-describedby"]} invalid={common["aria-invalid"]}
                disabled={disabled} inputClassName={channelInputClass} onChange={change} />
            ) : field.type === "boolean" ? (
              <input
                {...common}
                className="ml-3 accent-accent"
                type="checkbox"
                checked={Boolean(value)}
                onChange={(e) => change(e.target.checked)}
              />
            ) : field.type === "select" ? (
              <select {...common} value={String(value)} onChange={(e) => change(e.target.value)}>
                <option value="">Choose a value</option>
                {field.options?.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "textarea" && !sensitive ? (
              <textarea {...common} rows={4} value={String(value)} onChange={(e) => change(e.target.value)} />
            ) : (
              <input
                {...common}
                type={sensitive ? "password" : field.type === "url" ? "url" : "text"}
                inputMode={field.inputMode}
                autoComplete={sensitive ? "new-password" : "off"}
                value={value === SECRET_REDACTION_MARKER ? "" : String(value)}
                placeholder={sensitive && configured ? "Configured — enter a replacement to rotate" : field.placeholder}
                onChange={(e) => change(e.target.value)}
              />
            )}
            <div id={help} className="mt-1 space-y-1 text-xs text-fg-muted">
              <p>{field.explanation}</p>
              {sensitive ? (
                <p>
                  {configured
                    ? "Saved credential configured. Its value is never read back."
                    : "Sent only to the Gateway's secure credential owner when saved."}
                </p>
              ) : null}
              {field.whyNeeded ? <p>{field.whyNeeded}</p> : null}
              {field.looksLike ? <p>Example: {field.looksLike}</p> : null}
            </div>
            {issues
              .filter((issue) => issue.fieldKey === field.key)
              .map((issue, i) => (
                <p id={`${id}-issue-${i}`} key={i} role={issue.level === "error" ? "alert" : "status"} className={issue.level === "error" ? "text-sm text-status-failed" : "text-sm text-status-waiting"}>
                  {issue.message}
                </p>
              ))}
            {field.whereToFind?.length || field.commonMistakes?.length ? (
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer">Where to find this value and common mistakes</summary>
                <ChannelRichBlocks blocks={field.whereToFind} />
                <ul className="ml-5 list-disc">
                  {field.commonMistakes?.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        );
      };
  return <div className="space-y-4">
    {primary.map(renderField)}
    {advanced.length ? <details className="rounded-md border border-line p-3">
      <summary className="cursor-pointer text-sm font-medium">Advanced connection options</summary>
      <div className="mt-3 space-y-4">{advanced.map(renderField)}</div>
    </details> : null}
  </div>;
}
