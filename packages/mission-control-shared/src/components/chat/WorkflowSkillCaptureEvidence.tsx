import { getWorkflowSkillCaptureDisplay } from "./workflow-skill-capture-display";

export function WorkflowSkillCaptureEvidence({ content, onClear }: { content: string; onClear?: () => void }) {
  const display = getWorkflowSkillCaptureDisplay(content);
  if (!display) return null;
  return (
    <>
      <details className="mc-next-thread-details">
        <summary>Review the source task</summary>
        <p>{display.request}</p>
        <pre style={{ whiteSpace: "pre-wrap", maxHeight: "16rem", overflow: "auto" }}>{display.result}</pre>
      </details>
      {onClear ? (
        <button type="button" className="mc-next-composer-inline-button" onClick={onClear}>
          Clear prepared request
        </button>
      ) : null}
    </>
  );
}
