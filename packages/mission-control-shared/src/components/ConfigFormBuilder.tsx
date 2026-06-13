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
    return <p className="mc-next-settings-field-note">{globalCopy.configFormBuilder.noSchema}</p>;
  }

  const setField = (field: IntegrationFieldSchema, nextValue: unknown) => {
    onChange({
      ...value,
      [field.key]: nextValue,
    });
  };

  return (
    <article className="mc-next-settings-panel-body">
      <header className="mc-next-settings-inline-head">
        <div>
          <h4>{schema.title}</h4>
          {schema.description ? <p className="mc-next-settings-field-note">{schema.description}</p> : null}
        </div>
        {schema.fields.some((field) => field.advanced) ? (
          <button type="button" onClick={() => setShowAdvanced((current) => !current)} className="gc-button">
            {showAdvanced ? globalCopy.configFormBuilder.hideAdvanced : globalCopy.configFormBuilder.showAdvanced}
          </button>
        ) : null}
      </header>
      <div className="mc-next-settings-field-grid">
        {fields.map((field) => {
          const isWide = field.type === "textarea" || field.type === "json";
          return (
            <label key={field.key} className={`mc-next-settings-field${isWide ? " span-2" : ""}`}>
              <span>
                {field.label}
                {field.required ? <span aria-hidden="true"> *</span> : null}
                {field.secretRef ? (
                  <span className="mc-next-badge">{globalCopy.configFormBuilder.envRefChip}</span>
                ) : null}
              </span>
              <FieldInput
                field={field}
                value={value[field.key] ?? field.defaultValue}
                onChange={(nextValue) => setField(field, nextValue)}
              />
              {field.description ? <p className="mc-next-settings-field-note">{field.description}</p> : null}
            </label>
          );
        })}
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
      <span className="mc-next-settings-toggle">
        <input
          id={`integration-field-${field.key}`}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        {globalCopy.configFormBuilder.enabled}
      </span>
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
        className="mc-next-settings-textarea"
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
      className="mc-next-settings-input"
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
