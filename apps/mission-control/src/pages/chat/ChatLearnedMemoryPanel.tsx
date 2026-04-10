import { ActionButton } from "../../components/ActionButton";
import { CardSkeleton } from "../../components/CardSkeleton";
import { HelpHint } from "../../components/HelpHint";
import { Panel } from "../../components/Panel";

export interface ChatLearnedMemoryItem {
  itemId: string;
  itemType: string;
  confidence: number;
  status: "active" | "superseded" | "disabled" | "conflict" | "dropped";
  content: string;
}

export interface ChatLearnedMemoryPanelProps {
  learnedMemory: ChatLearnedMemoryItem[];
  secondaryLoading: boolean;
  sending: boolean;
  selectedSessionId: string | null;
  onRebuild: () => void;
  onUpdateStatus: (itemId: string, status: "active" | "superseded" | "disabled") => void;
}

function memoryStatusHelpText(status: ChatLearnedMemoryItem["status"]): string {
  if (status === "active") return "Active memory is currently eligible to influence future turns.";
  if (status === "superseded") return "Superseded memory was replaced by a newer or more accurate item.";
  if (status === "disabled") return "Disabled memory stays in history but no longer influences future turns.";
  return "Conflict means the memory needs review before it should influence future turns.";
}

export function ChatLearnedMemoryPanel(props: ChatLearnedMemoryPanelProps) {
  const { learnedMemory, secondaryLoading, sending, selectedSessionId, onRebuild, onUpdateStatus } = props;

  return (
    <Panel
      className="chat-v11-agentic-card chat-v11-panel-memory"
      title={
        <>
          Learned memory{" "}
          <HelpHint
            label="Learned memory help"
            text="Learned memory stores facts, goals, preferences, and constraints GoatCitadel may reuse in future turns for this session."
          />
        </>
      }
      subtitle="Review what GoatCitadel is carrying forward for future turns in this session."
      actions={<ActionButton label="Rebuild" disabled={sending || !selectedSessionId} onClick={onRebuild} />}
    >
      {secondaryLoading && learnedMemory.length === 0 ? <CardSkeleton lines={5} /> : null}
      <ul className="chat-v11-memory-list">
        {learnedMemory.slice(0, 6).map((item) => (
          <li key={item.itemId}>
            <p>
              <strong>{item.itemType}</strong>
              {" · "}
              Confidence {Math.round(item.confidence * 100)}%
              <HelpHint
                label="Memory confidence help"
                text="Confidence is GoatCitadel's estimate of how reliable this memory is for future replies. It is not a completion score; higher means the system is more willing to reuse it."
              />
              {" · "}
              {item.status}
              <HelpHint label="Memory status help" text={memoryStatusHelpText(item.status)} />
            </p>
            <p>{item.content}</p>
            <div className="chat-v11-row-actions">
              <button
                type="button"
                title="Keep this memory active so it continues influencing future turns."
                disabled={sending}
                onClick={() => onUpdateStatus(item.itemId, "active")}
               className="gc-button">
                Keep
              </button>
              <button
                type="button"
                title="Mark this memory as replaced by a newer or better one."
                disabled={sending}
                onClick={() => onUpdateStatus(item.itemId, "superseded")}
               className="gc-button">
                Supersede
              </button>
              <button
                type="button"
                title="Stop using this memory without deleting its history."
                disabled={sending}
                onClick={() => onUpdateStatus(item.itemId, "disabled")}
               className="gc-button">
                Disable
              </button>
            </div>
          </li>
        ))}
        {learnedMemory.length === 0 ? (
          <li className="chat-v11-muted">No learned memory items yet. They appear after completed assistant turns.</li>
        ) : null}
      </ul>
    </Panel>
  );
}
