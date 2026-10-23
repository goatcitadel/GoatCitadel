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
import { OLDER_KANBAN_VIEW } from "./WorkMoreViews";
import { WORK_VIEWS as VIEWS } from "./work-views";

const ROUTED_VIEWS: readonly string[] = [...VIEWS.map((item) => item.id), OLDER_KANBAN_VIEW.id];

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
  const view = rest[0] && ROUTED_VIEWS.includes(rest[0]) ? rest[0] : "board";
  // WK-01: the older Kanban opens from the Board's "More" menu; while it is open its tab names the current page.
  const tabs = view === OLDER_KANBAN_VIEW.id ? [...VIEWS, OLDER_KANBAN_VIEW] : VIEWS;
  // Each view draws these tabs in its own AreaHeader, under its title, in every load state.
  return (
    <AreaTabsProvider label="Work views" tabs={tabs} current={view} navigate={(href) => navigate(href)}>
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
