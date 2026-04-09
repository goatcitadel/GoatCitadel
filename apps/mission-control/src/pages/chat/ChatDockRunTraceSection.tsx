import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";
import { ChatTraceCard } from "../../components/ChatTraceCard";

export function ChatDockRunTraceSection(props: { isChatSurface: boolean; selectedTurn: ChatThreadTurnRecord }) {
  const { isChatSurface, selectedTurn } = props;

  return (
    <Panel
      className="chat-v11-agentic-card chat-v11-trace-card chat-v11-panel-trace"
      title={isChatSurface ? "Run status" : "Run trace"}
      actions={
        <StatusChip
          tone={
            selectedTurn.trace.status === "completed"
              ? "success"
              : selectedTurn.trace.status === "failed"
                ? "critical"
                : "warning"
          }
        >
          {selectedTurn.trace.status}
        </StatusChip>
      }
    >
      <ChatTraceCard trace={selectedTurn.trace} defaultCollapsed={isChatSurface} />
    </Panel>
  );
}
