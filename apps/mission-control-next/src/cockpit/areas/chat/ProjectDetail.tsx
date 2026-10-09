import { ProjectHome } from "./ProjectHome";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChatProjectRecord } from "@goatcitadel/contracts";
import {
  archiveChatProject,
  restoreChatProject,
  createChatSession,
  fetchChatSessions,
  fetchChatProjects,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { ProjectEditor } from "./ProjectEditor";
import { ProjectFanout } from "./ProjectFanout";

export function ProjectDetail({
  project,
  workspaceId,
  citadelId,
  refresh,
  available,
  pinned,
  togglePin,
}: {
  project: ChatProjectRecord;
  workspaceId: string;
  citadelId?: string;
  available: boolean;
  pinned: boolean;
  refresh: () => Promise<unknown>;
  togglePin: () => void;
}) {
  const route = useCockpitRoute();
  const access = useProjectAccess(JSON.stringify([citadelId, workspaceId, project]));
  const [editing, setEditing] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ token: object; action: "archive" | "restore" } | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    pending.current = false;
    setBusy(false);
    setReview(null);
  }, [access.identity]);
  const sessions = useQuery({
    queryKey: ["chat-project-sessions", access.identity],
    queryFn: ({ signal }) =>
      fetchChatSessions({ workspaceId, citadelId, scope: "mission", view: "active", limit: 200 }, { signal }),
    staleTime: 30_000,
  });
  const currentSessions = sessions.data?.items.filter((item) => item.workspaceId === workspaceId) ?? [];
  const projectSessions = currentSessions.filter((item) => item.projectId === project.projectId);
  const [assignment, setAssignment] = useState("");
  async function action(kind: "archive" | "restore" | "conversation") {
    if (
      !access.current() ||
      !available ||
      pending.current ||
      (kind !== "conversation" && review?.token !== access.token)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    setReview(null);
    try {
      const fresh = (
        await fetchChatProjects("all", 300, workspaceId, citadelId, { signal: new AbortController().signal })
      ).items.find((item) => item.projectId === project.projectId && item.workspaceId === workspaceId);
      if (!access.current()) return;
      if (!fresh || fresh.revision !== project.revision || fresh.lifecycleStatus !== project.lifecycleStatus)
        throw new Error("This project changed. Refresh and review its current revision before trying again.");
      if (kind === "conversation") {
        if (fresh.lifecycleStatus !== "active") throw new Error("Restore this project before starting a conversation.");
        const session = await createChatSession(
          {
            workspaceId,
            citadelId,
            projectId: project.projectId,
            mode: "chat",
            origin: "operator",
            title: `Chat - ${project.name}`,
          },
          { originSurface: "chat" },
        );
        if (access.current())
          route.navigate(
            `/chat?sessionId=${encodeURIComponent(session.sessionId)}&projectId=${encodeURIComponent(project.projectId)}`,
          );
      } else {
        await (kind === "archive" ? archiveChatProject : restoreChatProject)(project.projectId, project.revision);
        if (access.current()) {
          pending.current = false;
          setBusy(false);
          await refresh();
        }
      }
    } catch (cause) {
      if (access.current()) {
        setError(describeApiError(cause).summary);
        pending.current = false;
        setBusy(false);
        await refresh();
      }
    } finally {
      if (access.current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <section className="grid gap-3 rounded-lg border border-line p-4">
        <h2 className="break-words font-display text-xl">{project.name}</h2>
        <p className="break-words text-sm text-fg-secondary">{project.description || "No description provided."}</p>
        <p className="text-sm">{project.lifecycleStatus === "archived" ? "Archived project" : "Active project"}</p>
        <p className="break-all text-sm">Workspace path: {project.workspacePath}</p>
        {error ? <Callout tone="error">{error}</Callout> : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={togglePin}>{pinned ? "Unpin project" : "Pin project"}</Button>
          <Button
            disabled={!available || busy || project.lifecycleStatus !== "active"}
            onClick={() => setEditing(true)}
          >
            Edit project
          </Button>
          <Button
            disabled={!available || busy}
            onClick={() =>
              setReview({ token: access.token, action: project.lifecycleStatus === "archived" ? "restore" : "archive" })
            }
          >
            {project.lifecycleStatus === "archived" ? "Restore project" : "Archive project"}
          </Button>
          <Button
            disabled={!available || busy || project.lifecycleStatus !== "active"}
            onClick={() => void action("conversation")}
          >
            New conversation in project
          </Button>
        </div>
        <TechnicalDetails label="Project identity and provenance">
          <p className="break-all">
            Project {project.projectId} · Revision {project.revision} · Workspace {workspaceId} · Citadel{" "}
            {citadelId ?? "default"}
          </p>
          <p>
            Created {project.createdAt} · Updated {project.updatedAt}
          </p>
          <p>Color: {project.color || "Not set"}. Pins are local presentation preferences.</p>
        </TechnicalDetails>
        <ClassicOwnerLink
          href={`/projects/${encodeURIComponent(project.projectId)}?workspaceId=${encodeURIComponent(workspaceId)}`}
          scope={access.identity}
          label="Open project home, intake and artifacts in Classic"
        />
      </section>
      {editing ? (
        <ProjectEditor
          project={project}
          workspaceId={workspaceId}
          citadelId={citadelId}
          available={available}
          refresh={refresh}
          onSaved={() => setEditing(false)}
          onClose={() => setEditing(false)}
        />
      ) : null}
      <section aria-label="Project conversations" className="grid gap-3 rounded-lg border border-line p-4">
        <h2 className="font-display text-lg">Conversations</h2>
        {sessions.isFetching ? <p role="status">Reading conversations…</p> : null}
        {sessions.error ? <Callout tone="error">{describeApiError(sessions.error).summary}</Callout> : null}
        {!sessions.isPending && !sessions.error && !projectSessions.length ? (
          <p>No active conversations in the loaded history.</p>
        ) : null}
        {projectSessions.map((session) => (
          <Button
            key={session.sessionId}
            className="h-auto justify-start whitespace-normal break-words py-2 text-left"
            onClick={() => route.navigate(`/chat?sessionId=${encodeURIComponent(session.sessionId)}`)}
          >
            {session.title || "Untitled conversation"}
          </Button>
        ))}
        <label className="grid gap-1 text-sm">
          Conversation to assign
          <select
            aria-label="Conversation to assign"
            className="min-w-0 rounded-md border border-line bg-raised p-2"
            value={assignment}
            onChange={(event) => setAssignment(event.target.value)}
          >
            <option value="">Choose a conversation</option>
            {currentSessions
              .filter((session) => session.projectId !== project.projectId)
              .map((session) => (
                <option key={session.sessionId} value={session.sessionId}>
                  {session.title || "Untitled conversation"}
                </option>
              ))}
          </select>
        </label>
        <p className="text-sm text-fg-secondary">
          Review destination context in the selected conversation before assigning it. Existing turns and drafts stay;
          future turns use this project's context and the Gateway resets workbench context.
        </p>
        <Button
          disabled={!available || !assignment || Boolean(sessions.error) || project.lifecycleStatus !== "active"}
          onClick={() =>
            route.navigate(
              `/chat?sessionId=${encodeURIComponent(assignment)}&assignProjectId=${encodeURIComponent(project.projectId)}`,
            )
          }
        >
          Review conversation assignment
        </Button>
        <p className="text-xs text-fg-muted">
          Showing up to 200 recent conversations. Use Chat history to locate older conversations.
        </p>
      </section>
      <ProjectHome key={`home:${access.identity}`} project={project} workspaceId={workspaceId} citadelId={citadelId} available={available} />
      <ProjectFanout key={`fanout:${access.identity}`} project={project} workspaceId={workspaceId} citadelId={citadelId} />
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
        title={review?.action === "restore" ? "Restore project" : "Archive project"}
        description={`Review ${project.name} in workspace ${workspaceId}.`}
      >
        <p className="mb-3 text-sm">
          {review?.action === "restore"
            ? "Restore returns this project to active lists. Previously revoked or expired grants remain unchanged."
            : "Archive removes this project from active lists. This does not delete it or its conversations. Archived projects cannot authorize automatic fan-out."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setReview(null)}>Cancel</Button>
          <Button
            disabled={busy || !available || review?.token !== access.token}
            onClick={() => {
              if (review) void action(review.action);
            }}
          >
            {review?.action === "restore" ? "Confirm restore" : "Confirm archive"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
