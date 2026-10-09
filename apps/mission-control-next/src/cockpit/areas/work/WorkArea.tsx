import { useCockpitRoute } from "../../app/use-cockpit-route";
import { EmptyState } from "../../ui/EmptyState";
import { AREA_TABS } from "../../ui/area-layout";
import { WorkBoard } from "./WorkBoard";
import { WorkHistory } from "./WorkHistory";
import { WorkRunDetail } from "./WorkRunDetail";
import { WorkSchedules } from "./WorkSchedules";
import { WorkTaskDetail } from "./WorkTaskDetail";
import { WorkKanban, WorkArchive } from "./WorkKanban";
import { WorkAutomation } from "./WorkAutomation";

const VIEWS = [
  { id: "board", label: "Board", path: "/work" },
  { id: "history", label: "History", path: "/work/history" },
  { id: "schedules", label: "Schedules", path: "/work/schedules" },
  { id: "kanban", label: "Task actions", path: "/work/kanban" },
  { id: "archive", label: "Archived tasks", path: "/work/archive" },
  { id: "automation", label: "Automation Designer", path: "/work/automation" },
] as const;

export function WorkArea() {
  const { rest, navigate } = useCockpitRoute();
  if (rest[0] === "tasks" && rest[1]) {
    try {
      return <WorkTaskDetail taskId={decodeURIComponent(rest[1])} />;
    } catch {
      return <EmptyState title="Task link unavailable" description="This task link could not be read." />;
    }
  }
  if (rest[0] === "runs" && rest[1]) {
    try {
      return <WorkRunDetail runId={decodeURIComponent(rest[1])} />;
    } catch {
      return <EmptyState title="Run link unavailable" description="This run link could not be read." />;
    }
  }
  const view = VIEWS.some(item => item.id === rest[0]) ? rest[0] : "board";
  return (
    <>
      <nav aria-label="Work views" className={AREA_TABS}>
        {VIEWS.map((item) => (
          <a
            key={item.id}
            href={item.path}
            aria-current={view === item.id ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(item.path);
            }}
            className="border-b-2 border-transparent px-3 py-2 text-sm text-fg-secondary hover:text-fg aria-[current=page]:border-accent aria-[current=page]:text-fg"
          >
            {item.label}
          </a>
        ))}
      </nav>
      {view === "history" ? <WorkHistory /> : view === "schedules" ? <WorkSchedules /> : view === "kanban" ? <WorkKanban /> : view === "archive" ? <WorkArchive /> : view === "automation" ? <WorkAutomation /> : <WorkBoard />}
    </>
  );
}
