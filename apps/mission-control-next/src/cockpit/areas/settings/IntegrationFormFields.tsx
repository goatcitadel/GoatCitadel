import { useEffect, useId, useRef, useState } from "react";
import type { IntegrationFieldSchema, IntegrationFormSchema } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";
export const integrationInputClass =
  "mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg";
const text = (value: unknown) =>
  value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
export function IntegrationFormFields({
  schema,
  value,
  onChange,
  disabled = false,
}: {
  schema?: IntegrationFormSchema;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const prefix = useId();
  if (!schema)
    return (
      <p role="status" className="text-sm text-fg-muted">
        Structured configuration fields are unavailable. Refresh the owner or inspect the advanced configuration.
      </p>
    );
  return (
    <section aria-label={`${schema.title} configuration`} className="space-y-3">
      {schema.description ? <p className="text-sm text-fg-secondary">{schema.description}</p> : null}
      {schema.fields.some((field) => field.advanced) ? (
        <Button disabled={disabled} onClick={() => setAdvanced(!advanced)}>
          {advanced ? "Hide advanced fields" : "Show advanced fields"}
        </Button>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {schema.fields
          .filter((field) => advanced || !field.advanced)
          .map((field) => {
            const id = `${prefix}-${field.key}`,
              current = value[field.key] ?? field.defaultValue;
            const credential = field.type === "password" || (!field.secretRef && /token|password|secret|webhook/i.test(field.key));
            const change = (next: unknown) => onChange({ ...value, [field.key]: next });
            return (
              <div
                key={field.key}
                className={`min-w-0 ${["textarea", "json"].includes(field.type) ? "sm:col-span-2" : ""}`}
              >
                <label htmlFor={id} className="text-sm font-medium">
                  {field.label}
                  {field.required ? " (required)" : ""}
                </label>
                <Field id={id} field={field} value={current} onChange={change} disabled={disabled || credential || field.type === "json"} />
                {field.type === "json" ? <p className="text-xs text-fg-muted">Structured values are inspection-only here. Use this connector’s dedicated setup owner to change them.</p> : null}
                {credential ? <p className="text-xs text-fg-muted">Use the supported secure setup owner for this credential. General configuration cannot replace it.</p> : null}
                {field.secretRef && field.type === "text" && field.key.endsWith("Env") ? (
                  <p className="text-xs text-fg-muted">Environment reference; enter a variable name.</p>
                ) : null}
                {field.secretRef && field.type === "url" ? (
                  <p className="text-xs text-fg-muted">Enter a public endpoint URL. Keep an unchanged masked value to retain its saved credential. Credential-bearing URLs cannot be replaced here; use this connector’s supported credential owner or reference.</p>
                ) : null}
                {field.description ? <p className="mt-1 text-xs text-fg-secondary">{field.description}</p> : null}
              </div>
            );
          })}
      </div>
    </section>
  );
}
function Field({
  id,
  field,
  value,
  onChange,
  disabled,
}: {
  id: string;
  field: IntegrationFieldSchema;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  const [numberDraft, setNumberDraft] = useState(() => text(value));
  const committed = useRef(value);
  useEffect(() => {
    if (!Object.is(value, committed.current)) {
      committed.current = value;
      setNumberDraft(text(value));
    }
  }, [value]);
  const common = {
    id,
    disabled,
    required: field.required,
    className: integrationInputClass,
    placeholder: field.placeholder,
  };
  if (field.type === "boolean")
    return (
      <input
        {...common}
        className="ml-3 accent-accent"
        type="checkbox"
        checked={Boolean(value)}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  if (field.type === "select")
    return (
      <>
        <input
          {...common}
          list={`${id}-options`}
          value={text(value)}
          onChange={(event) => onChange(event.target.value)}
        />
        <datalist id={`${id}-options`}>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </datalist>
        <p className="text-xs text-fg-muted">Choose a suggested value or enter a custom value.</p>
      </>
    );
  if (field.type === "textarea" || field.type === "json")
    return (
      <textarea
        {...common}
        rows={field.type === "json" ? 6 : 4}
        value={text(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  if (field.type === "number")
    return (
      <input
        {...common}
        inputMode="decimal"
        value={numberDraft}
        onChange={(event) => {
          const raw = event.target.value;
          setNumberDraft(raw);
          const parsed = raw.trim() ? Number(raw) : undefined;
          if (parsed === undefined || Number.isFinite(parsed)) {
            committed.current = parsed;
            onChange(parsed);
          }
        }}
      />
    );
  const secret = field.type === "password";
  return (
    <>
      <input
        {...common}
        type={secret ? "password" : field.type === "url" ? "url" : "text"}
        autoComplete={secret ? "new-password" : "off"}
        value={secret && value === "[REDACTED]" ? "" : text(value)}
        placeholder={secret && value === "[REDACTED]" ? "Configured — enter a replacement" : field.placeholder}
        onChange={(event) =>
          onChange(secret && value === "[REDACTED]" && !event.target.value ? "[REDACTED]" : event.target.value)
        }
      />
      {secret ? (
        <p className="text-xs text-fg-muted">
          Stored credentials are not read back. This configuration form cannot accept credentials. Use channel secure setup or the connector's supported credential reference.
        </p>
      ) : null}
    </>
  );
}
