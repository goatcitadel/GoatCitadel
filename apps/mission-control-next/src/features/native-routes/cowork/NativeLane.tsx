import { AlertTriangle, CheckCircle2, CircleDashed, Eye, PlayCircle } from "lucide-react";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { EmptyState } from "../primitives";
import { formatDateTime, formatTaskStatus } from "../shared/native-helpers";

type NativeLaneProps = {
  title: string;
  count: number;
  items: TaskRecord[];
  selectedTaskId?: string;
  onSelect?: (taskId: string) => void;
};

export function NativeLane({ title, count, items, selectedTaskId, onSelect }: NativeLaneProps) {
  return (
    <section className="mc-next-directory-lane">
      <div className="mc-next-directory-lane-head">
        <strong>{title}</strong>
        <span>{count}</span>
      </div>
      {items.length === 0 ? (
        <EmptyState size="compact" title="No items in this lane." />
      ) : (
        <div className="mc-next-directory-lane-list">
          {items.map((item) => (
            <button
              key={item.taskId}
              type="button"
              className={`mc-next-directory-lane-item${selectedTaskId === item.taskId ? " is-selected" : ""}`}
              data-status={item.status}
              aria-pressed={selectedTaskId === item.taskId}
              aria-label={`${item.title}: ${formatTaskStatus(item.status)}, ${item.priority} priority`}
              onClick={() => onSelect?.(item.taskId)}
            >
              <div className="mc-next-directory-lane-meta">
                <span>{item.priority}</span>
                <span>{formatDateTime(item.updatedAt)}</span>
              </div>
              <strong title={item.title}>{item.title}</strong>
              <p title={item.description?.trim() || undefined}>{item.description?.trim() || "No description yet."}</p>
              <div className="mc-next-directory-lane-status" data-status={item.status}>
                <TaskStatusIcon status={item.status} />
                <span>{formatTaskStatus(item.status)}</span>
                {item.assignedAgentId ? (
                  <span className="mc-next-directory-lane-agent">Agent {item.assignedAgentId}</span>
                ) : null}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function TaskStatusIcon({ status }: { status: TaskRecord["status"] }) {
  if (status === "blocked") {
    return <AlertTriangle className="h-4 w-4" aria-hidden="true" />;
  }
  if (status === "review") {
    return <Eye className="h-4 w-4" aria-hidden="true" />;
  }
  if (status === "in_progress" || status === "testing") {
    return <PlayCircle className="h-4 w-4" aria-hidden="true" />;
  }
  if (status === "done") {
    return <CheckCircle2 className="h-4 w-4" aria-hidden="true" />;
  }
  return <CircleDashed className="h-4 w-4" aria-hidden="true" />;
}
