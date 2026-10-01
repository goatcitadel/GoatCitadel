import type { ChannelSetupDraft, ChannelSetupFieldDefinition, ChannelSetupIssue } from "@goatcitadel/contracts";
import {
  updateFieldValue,
  SECRET_REDACTION_MARKER,
} from "../../../features/native-routes/settings/channel-setup/channel-wizard-model";
import { ChannelRichBlocks } from "./ChannelWizardContent";

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
  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const id = `channel-${draft.draftId}-${field.key}`,
          help = `${id}-help`;
        const value = values[field.key] ?? field.defaultValue ?? "";
        const sensitive = field.sensitive || field.type === "secret";
        const configured = value === SECRET_REDACTION_MARKER || draft.hydration?.fieldState[field.key] === "configured";
        const change = (next: unknown) => onChange(updateFieldValue(draft, values, { ...field, sensitive }, next));
        const common = {
          id,
          "aria-describedby": help,
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
            {field.type === "boolean" ? (
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
                inputMode={field.type === "id" ? "numeric" : undefined}
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
                <p key={i} role="alert" className="text-sm text-status-failed">
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
      })}
    </div>
  );
}
