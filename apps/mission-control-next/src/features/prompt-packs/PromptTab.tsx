import type {
  PromptPackTestRecord,
  RunVariableBindings,
  RunVariableField,
  RunVariableSchema,
  RunVariableValue,
} from "@goatcitadel/contracts";
import { normalizePromptPlaceholderKey } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-helpers";
import { DiagnosticChipGroup, PromptSourceEditor } from "./PromptPacksWorkbenchPage.components";

export interface PromptTabProps {
  selectedTest: PromptPackTestRecord;
  selectedPlaceholders: string[];
  selectedMissingPlaceholders: string[];
  placeholderValues: Record<string, string>;
  runVariableSchema?: RunVariableSchema;
  runVariableBindings: RunVariableBindings;
  selectedDiagnosticMetadata?: PromptPackTestRecord["diagnosticMetadata"];
  onPlaceholderChange: (key: string, value: string) => void;
  onRunVariableChange: (fieldId: string, value: RunVariableValue | undefined) => void;
}

export function PromptTab({
  selectedTest,
  selectedPlaceholders,
  selectedMissingPlaceholders,
  placeholderValues,
  runVariableSchema,
  runVariableBindings,
  selectedDiagnosticMetadata,
  onPlaceholderChange,
  onRunVariableChange,
}: PromptTabProps) {
  return (
    <div className="mc-pp-tab-grid">
      <section className="mc-pp-surface">
        <div className="mc-pp-section-heading">
          <div>
            <h5>Prompt source</h5>
            <p>Exact markdown used for the selected test.</p>
          </div>
        </div>
        <PromptSourceEditor prompt={selectedTest.prompt} declaredPlaceholders={selectedPlaceholders} />
      </section>
      {selectedDiagnosticMetadata ? (
        <section className="mc-pp-surface">
          <div className="mc-pp-section-heading">
            <div>
              <h5>Diagnostics</h5>
              <p>Capability targets and expected runtime signals captured at import.</p>
            </div>
          </div>
          <div className="mc-pp-diagnostic-stack">
            <DiagnosticChipGroup label="Capability targets" values={selectedDiagnosticMetadata.capabilityTargets} />
            <DiagnosticChipGroup
              label="Expected runtime signals"
              values={selectedDiagnosticMetadata.expectedRuntimeSignals}
            />
            <DiagnosticChipGroup
              label="Likely failure classes"
              values={selectedDiagnosticMetadata.likelyFailureClasses}
            />
          </div>
        </section>
      ) : null}
      {runVariableSchema ? (
        <section className="mc-pp-surface">
          <div className="mc-pp-section-heading">
            <div>
              <h5>Run variables</h5>
              <p>Typed values stay in this browser session and are revalidated when the run starts.</p>
            </div>
          </div>
          <div className="mc-pp-placeholder-grid">
            {runVariableSchema.fields.map((field) => (
              <PromptVariableField
                key={field.id}
                field={field}
                value={runVariableBindings[field.id]}
                onChange={(value) => onRunVariableChange(field.id, value)}
              />
            ))}
          </div>
          <p className="mc-pp-note">
            {selectedMissingPlaceholders.length > 0
              ? `Missing values: ${selectedMissingPlaceholders.join(", ")}`
              : "All required variables are valid for this test."}
          </p>
        </section>
      ) : selectedPlaceholders.length > 0 ? (
        <section className="mc-pp-surface">
          <div className="mc-pp-section-heading">
            <div>
              <h5>Placeholder values</h5>
              <p>Fill required tokens before running the test.</p>
            </div>
          </div>
          <div className="mc-pp-placeholder-grid">
            {selectedPlaceholders.map((placeholder) => {
              const key = normalizePromptPlaceholderKey(placeholder);
              return (
                <label key={placeholder} className="mc-pp-field">
                  <span>{placeholder}</span>
                  <input
                    value={placeholderValues[key] ?? ""}
                    onChange={(event) => onPlaceholderChange(key, event.target.value)}
                    placeholder={`Value for ${placeholder}`}
                  />
                </label>
              );
            })}
          </div>
          <p className="mc-pp-note">
            {selectedMissingPlaceholders.length > 0
              ? `Missing values: ${selectedMissingPlaceholders.join(", ")}`
              : "All placeholders are set for this test."}
          </p>
        </section>
      ) : null}
    </div>
  );
}

function PromptVariableField({
  field,
  value,
  onChange,
}: {
  field: RunVariableField;
  value: RunVariableValue | undefined;
  onChange: (value: RunVariableValue | undefined) => void;
}) {
  if (field.type === "boolean") {
    return (
      <label className="mc-pp-field mc-pp-field--check">
        <span>{field.label}</span>
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.currentTarget.checked)} />
        {field.description ? <small>{field.description}</small> : null}
      </label>
    );
  }
  return (
    <label className="mc-pp-field">
      <span>
        {field.label}
        {field.required ? " *" : ""}
      </span>
      {field.type === "multiline" ? (
        <textarea
          value={typeof value === "string" ? value : ""}
          minLength={field.minLength}
          maxLength={field.maxLength}
          required={field.required}
          onChange={(event) => onChange(event.currentTarget.value || undefined)}
        />
      ) : field.type === "select" ? (
        <select
          value={typeof value === "string" ? value : ""}
          required={field.required}
          onChange={(event) => onChange(event.currentTarget.value || undefined)}
        >
          <option value="">Select…</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === "number" || field.type === "url" || field.type === "date" ? field.type : "text"}
          value={typeof value === "string" || typeof value === "number" ? value : ""}
          min={field.type === "number" ? field.minimum : undefined}
          max={field.type === "number" ? field.maximum : undefined}
          required={field.required}
          placeholder={field.type === "datetime" ? "2026-07-28T09:30:00-07:00" : undefined}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            onChange(field.type === "number" ? (raw === "" ? undefined : Number(raw)) : raw || undefined);
          }}
        />
      )}
      {field.description ? <small>{field.description}</small> : null}
    </label>
  );
}
