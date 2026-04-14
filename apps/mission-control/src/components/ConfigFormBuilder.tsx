import { useMemo, useState } from "react";
import type { IntegrationFieldSchema, IntegrationFormSchema } from "@goatcitadel/contracts";
import { SelectOrCustom } from "./SelectOrCustom";
import { globalCopy } from "../content/copy";

interface ConfigFormBuilderProps {
  schema?: IntegrationFormSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function ConfigFormBuilder({ schema, value, onChange }: ConfigFormBuilderProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fields = useMemo(() => {
    if (!schema) {
      return [];
    }
    return schema.fields.filter((field) => (showAdvanced ? true : !field.advanced));
  }, [schema, showAdvanced]);

  if (!schema) {
    return <p className="office-subtitle">{globalCopy.configFormBuilder.noSchema}</p>;
  }

  const setField = (field: IntegrationFieldSchema, nextValue: unknown) => {
    onChange({
      ...value,
      [field.key]: nextValue,
    });
  };

  return (
    <article className="config-form-builder panel panel-muted panel-pad-compact">
      <header className="config-form-builder-head">
        <div className="config-form-builder-copy">
          <h4>{schema.title}</h4>
          {schema.description ? <p className="office-subtitle">{schema.description}</p> : null}
        </div>
        {schema.fields.some((field) => field.advanced) ? (
          <button type="button" onClick={() => setShowAdvanced((current) => !current)} className="gc-button">
            {showAdvanced ? globalCopy.configFormBuilder.hideAdvanced : globalCopy.configFormBuilder.showAdvanced}
          </button>
        ) : null}
      </header>
      <div className="config-form-builder-grid">
        {fields.map((field) => (
          <div key={field.key} className={`config-form-field${field.advanced ? " is-advanced" : ""}`}>
            <div className="config-form-field-head">
              <label htmlFor={`integration-field-${field.key}`} className="config-form-field-label">
                {field.label}
                {field.required ? <span className="config-form-required">*</span> : null}
              </label>
              {field.secretRef ? <span className="token-chip">{globalCopy.configFormBuilder.envRefChip}</span> : null}
            </div>
            <FieldInput
              field={field}
              value={value[field.key] ?? field.defaultValue}
              onChange={(nextValue) => setField(field, nextValue)}
            />
            {field.description ? <p className="config-form-field-help">{field.description}</p> : null}
          </div>
        ))}
      </div>
    </article>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: IntegrationFieldSchema;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  if (field.type === "boolean") {
    return (
      <label>
        <input
          id={`integration-field-${field.key}`}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />{" "}
        {globalCopy.configFormBuilder.enabled}
      </label>
    );
  }

  if (field.type === "select") {
    const options = field.options ?? [];
    return (
      <SelectOrCustom
        id={`integration-field-${field.key}`}
        value={String(value ?? "")}
        onChange={(next) => onChange(next)}
        options={options.map((option) => ({ value: option.value, label: option.label }))}
        customPlaceholder={field.placeholder ?? globalCopy.configFormBuilder.customValue}
      />
    );
  }

  if (field.type === "textarea" || field.type === "json") {
    return (
      <textarea
        id={`integration-field-${field.key}`}
        className="full-textarea"
        rows={field.type === "json" ? 6 : 4}
        value={stringifyValue(value)}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const inputType = field.type === "password" ? "password" : field.type === "number" ? "number" : "text";
  return (
    <input
      id={`integration-field-${field.key}`}
      type={inputType}
      value={stringifyValue(value)}
      placeholder={field.placeholder}
      onChange={(event) => {
        if (field.type === "number") {
          const parsed = Number(event.target.value);
          onChange(Number.isFinite(parsed) ? parsed : undefined);
          return;
        }
        onChange(event.target.value);
      }}
    />
  );
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
