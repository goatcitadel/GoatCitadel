import type { PromptPackTestRecord } from "@goatcitadel/contracts";
import { normalizePromptPlaceholderKey } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-helpers";
import { DiagnosticChipGroup, PromptSourceEditor } from "./PromptPacksWorkbenchPage.components";

export interface PromptTabProps {
  selectedTest: PromptPackTestRecord;
  selectedPlaceholders: string[];
  selectedMissingPlaceholders: string[];
  placeholderValues: Record<string, string>;
  selectedDiagnosticMetadata?: PromptPackTestRecord["diagnosticMetadata"];
  onPlaceholderChange: (key: string, value: string) => void;
}

export function PromptTab({
  selectedTest,
  selectedPlaceholders,
  selectedMissingPlaceholders,
  placeholderValues,
  selectedDiagnosticMetadata,
  onPlaceholderChange,
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
      {selectedPlaceholders.length > 0 ? (
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
