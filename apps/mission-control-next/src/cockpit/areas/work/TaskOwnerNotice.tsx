import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { taskConversationId, taskRunHref } from "./task-run-link";

type NoticeBefore = "changing execution state" | "changing ownership" | "editing board details";

/** Says a runtime owns the task, and links the run or conversation that does; never a link that opens nothing. */
export function TaskOwnerNotice({
  task,
  workspaceId,
  before,
}: {
  task: TaskRecord;
  workspaceId: string;
  before: NoticeBefore;
}) {
  const scope = [workspaceId, task.taskId];
  const runHref = taskRunHref(task);
  const sessionId = taskConversationId(task);
  if (runHref)
    return (
      <>
        A run is handling this task. Review its run before {before}.{" "}
        <NativeOwnerLink scope={scope} href={runHref} className="font-medium text-accent">
          Open linked run
        </NativeOwnerLink>
      </>
    );
  if (sessionId)
    return (
      <>
        A Chat delegation is handling this task. Review it in its conversation before {before}.{" "}
        <NativeOwnerLink
          scope={scope}
          href={`/chat?sessionId=${encodeURIComponent(sessionId)}`}
          className="font-medium text-accent"
        >
          Open linked conversation
        </NativeOwnerLink>
      </>
    );
  return (
    <>
      A run is handling this task, but no link to it was recorded. Check Work history before {before}.{" "}
      <NativeOwnerLink scope={scope} href="/work/history" className="font-medium text-accent">
        Open Work history
      </NativeOwnerLink>
    </>
  );
}
