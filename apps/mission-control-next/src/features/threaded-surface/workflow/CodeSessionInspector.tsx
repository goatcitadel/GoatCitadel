import { useId } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { CodeInspectorSection, CodeInspectorSectionId } from "./code-workbench-model";

export function CodeSessionInspector({
  expandedSections,
  onClose,
  onToggleSection,
  sections,
  variant,
}: {
  expandedSections: Set<CodeInspectorSectionId>;
  onClose?: () => void;
  onToggleSection: (sectionId: CodeInspectorSectionId, open: boolean) => void;
  sections: CodeInspectorSection[];
  variant: "inline" | "drawer";
}) {
  const disclosureIdPrefix = useId();

  return (
    <section className="mc-next-code-session-inspector" data-variant={variant} aria-label="Code session inspector">
      <header className="mc-next-code-session-inspector-head">
        <div>
          <p className="mc-next-panel-kicker">Session inspector</p>
          <h5>Code context</h5>
        </div>
        {onClose ? (
          <button type="button" className="mc-next-panel-button icon" aria-label="Close inspector" onClick={onClose}>
            <X size={14} />
          </button>
        ) : null}
      </header>
      <div className="mc-next-code-session-inspector-stack">
        {sections.map((section) => {
          const expanded = expandedSections.has(section.id);
          const controlsId = `${disclosureIdPrefix}-${section.id}`;
          return (
            <details
              key={section.id}
              className="mc-next-code-session-inspector-section"
              open={expanded}
              onToggle={(event) => onToggleSection(section.id, event.currentTarget.open)}
            >
              <summary aria-expanded={expanded} aria-controls={controlsId}>
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>{section.label}</span>
                <em>{section.summary}</em>
              </summary>
              <div id={controlsId} className="mc-next-code-session-inspector-rows">
                {section.rows.map((row) => (
                  <div key={`${section.id}-${row.label}`} className="mc-next-code-session-inspector-row">
                    <span>{row.label}</span>
                    <strong data-tone={row.tone ?? "muted"} title={row.title}>
                      {row.value}
                    </strong>
                  </div>
                ))}
                {section.extra ? <div className="mc-next-code-session-inspector-extra">{section.extra}</div> : null}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
