import { useCockpitRoute } from "../../app/use-cockpit-route";
import { EmptyState } from "../../ui/EmptyState";
import { AreaTabsProvider } from "../../ui/AreaHeader";
import { WorkBoard } from "./WorkBoard";
import { WorkHistory } from "./WorkHistory";
import { WorkRunDetail } from "./WorkRunDetail";
import { WorkSchedules } from "./WorkSchedules";
import { WorkTaskDetail } from "./WorkTaskDetail";
import { WorkKanban, WorkArchive } from "./WorkKanban";
import { WorkAutomation } from "./WorkAutomation";

const VIEWS = [
  { id: "board", label: "Board", href: "/work" },
  { id: "history", label: "History", href: "/work/history" },
  { id: "schedules", label: "Schedules", href: "/work/schedules" },
  { id: "kanban", label: "Classic Kanban", href: "/work/kanban" },
  { id: "archive", label: "Archived tasks", href: "/work/archive" },
  { id: "automation", label: "Automation designer", href: "/work/automation" },
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
  const view = rest[0] && VIEWS.some((item) => item.id === rest[0]) ? rest[0] : "board";
  // Each view draws these tabs in its own AreaHeader, under its title, in every load state.
  return (
    <AreaTabsProvider label="Work views" tabs={VIEWS} current={view} navigate={(href) => navigate(href)}>
      {view === "history" ? (
        <WorkHistory />
      ) : view === "schedules" ? (
        <WorkSchedules />
      ) : view === "kanban" ? (
        <WorkKanban />
      ) : view === "archive" ? (
        <WorkArchive />
      ) : view === "automation" ? (
        <WorkAutomation />
      ) : (
        <WorkBoard />
      )}
    </AreaTabsProvider>
  );
}
