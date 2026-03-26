import { useEffect, useMemo, useState } from "react";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { StatusChip } from "./StatusChip";

interface CodeBlockRecord {
  id: string;
  language: string;
  content: string;
}

function extractCodeBlocks(content: string): CodeBlockRecord[] {
  const matches = Array.from(content.matchAll(/```([\w.+-]*)\n([\s\S]*?)```/g));
  return matches.map((match, index) => ({
    id: `code-block-${index}`,
    language: match[1]?.trim() || "text",
    content: (match[2] ?? "").trim(),
  })).filter((block) => block.content.length > 0);
}

export function CodeWorkbenchPanel({
  selectedTurn,
  projectName,
  needsProjectBinding,
}: {
  selectedTurn: ChatThreadTurnRecord | null;
  projectName?: string;
  needsProjectBinding: boolean;
}) {
  const codeBlocks = useMemo(
    () => extractCodeBlocks(selectedTurn?.assistantMessage?.content ?? ""),
    [selectedTurn?.assistantMessage?.content],
  );
  const [activeBlockIndex, setActiveBlockIndex] = useState(0);
  const [drafts, setDrafts] = useState<string[]>([]);

  useEffect(() => {
    setActiveBlockIndex(0);
    setDrafts(codeBlocks.map((block) => block.content));
  }, [codeBlocks, selectedTurn?.turnId]);

  const activeBlock = codeBlocks[activeBlockIndex];
  const activeDraft = drafts[activeBlockIndex] ?? "";

  return (
    <aside className="chat-code-workbench">
      <header className="chat-code-workbench-head">
        <div>
          <h4>Code Workbench</h4>
          <p>
            {needsProjectBinding
              ? "Bind a project to turn this into an execution-ready code lane."
              : projectName
                ? `Project-bound editing surface for ${projectName}.`
                : "Editable code lane sourced from the selected turn."}
          </p>
        </div>
        <div className="chat-code-workbench-chips">
          <StatusChip tone={needsProjectBinding ? "warning" : "success"}>
            {needsProjectBinding ? "Unbound" : "Project ready"}
          </StatusChip>
          {selectedTurn ? (
            <StatusChip tone={selectedTurn.trace.status === "completed" ? "success" : selectedTurn.trace.status === "failed" ? "critical" : "warning"}>
              {selectedTurn.trace.status}
            </StatusChip>
          ) : null}
        </div>
      </header>

      {codeBlocks.length > 0 ? (
        <>
          <div className="chat-code-workbench-tabs" role="tablist" aria-label="Code snippets">
            {codeBlocks.map((block, index) => (
              <button
                key={block.id}
                type="button"
                className={index === activeBlockIndex ? "active" : ""}
                onClick={() => setActiveBlockIndex(index)}
              >
                {block.language || "snippet"} {index + 1}
              </button>
            ))}
          </div>
          <div className="chat-code-workbench-meta">
            <span>{activeBlock?.language ?? "text"}</span>
            <span>{activeDraft.split(/\r?\n/).length} lines</span>
          </div>
          <textarea
            className="chat-code-workbench-editor"
            value={activeDraft}
            onChange={(event) => {
              const next = [...drafts];
              next[activeBlockIndex] = event.target.value;
              setDrafts(next);
            }}
            spellCheck={false}
            aria-label="Editable code workbench"
          />
          <p className="chat-code-workbench-note">
            Editable scratchpad sourced from fenced code blocks in the selected assistant turn. Edits stay local to this surface for now.
          </p>
        </>
      ) : (
        <div className="chat-code-workbench-empty">
          <p>No code snippets extracted yet.</p>
          <p>Select a turn with fenced code blocks or ask GoatCitadel to draft an implementation here.</p>
        </div>
      )}
    </aside>
  );
}
