import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChatProjectRecord } from "@goatcitadel/contracts";
import {
  fetchChatSessions,
  fetchChatGeneratedArtifacts,
  fetchChatProjects,
  createChatSession,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  PROJECT_INTAKE_MODES,
  deriveProjectHome,
  type ProjectIntakeMode,
} from "../../../features/native-routes/projects/ProjectsRoutePage.helpers";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

export function ProjectHome({
  project,
  workspaceId,
  citadelId,
  available,
}: {
  project: ChatProjectRecord;
  workspaceId: string;
  citadelId?: string;
  available: boolean;
}) {
  const access = useProjectAccess(JSON.stringify([workspaceId, citadelId, project])),
    route = useCockpitRoute();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(false);
  const sessions = useQuery({
    queryKey: ["project-home", access.identity, "sessions"],
    queryFn: () =>
      fetchChatSessions({ workspaceId, citadelId, scope: "all", view: "all", includeHidden: true, limit: 1000 }),
    retry: false,
  });
  const artifacts = useQuery({
    queryKey: ["project-home", access.identity, "artifacts"],
    queryFn: () => fetchChatGeneratedArtifacts({ workspaceId, citadelId, projectId: project.projectId, limit: 1000 }),
    retry: false,
  });
  const currentSessions =
    sessions.data?.items.filter((item) => item.workspaceId === workspaceId && item.projectId === project.projectId) ??
    [];
  const currentArtifacts =
    artifacts.data?.items.filter((item) => item.workspaceId === workspaceId && item.projectId === project.projectId) ??
    [];
  const home =
    sessions.data && !sessions.isError
      ? deriveProjectHome(project, currentSessions, artifacts.data && !artifacts.isError ? currentArtifacts : undefined)
      : undefined;
  async function start(intent: ProjectIntakeMode, transition: { isCurrent: () => boolean; navigate: (href: string) => void }) {
    if (!available || !transition.isCurrent() || !access.current() || pending.current || project.lifecycleStatus !== "active") return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const fresh = (await fetchChatProjects("all", 300, workspaceId, citadelId)).items.find(
        (item) => item.projectId === project.projectId && item.workspaceId === workspaceId,
      );
      if (!access.current() || !transition.isCurrent()) return;
      if (!fresh || fresh.revision !== project.revision || fresh.lifecycleStatus !== "active")
        throw new Error("Project changed. Refresh and review before starting intake.");
      const session = await createChatSession(
        {
          workspaceId,
          citadelId,
          projectId: project.projectId,
          mode: "chat",
          origin: "operator",
          title: `${intent.titlePrefix} - ${project.name}`,
          tags: ["project-intake", intent.tag],
        },
        { originSurface: "chat" },
      );
      if (!access.current() || !transition.isCurrent()) return;
      if (session.workspaceId !== workspaceId || session.projectId !== project.projectId)
        throw new Error("The returned conversation does not match this project.");
      transition.navigate(
        `/chat?sessionId=${encodeURIComponent(session.sessionId)}&projectId=${encodeURIComponent(project.projectId)}`,
      );
    } catch (cause) {
      if (access.current()) setError(describeApiError(cause).summary);
    } finally {
      pending.current = false;
      if (access.current()) setBusy(false);
    }
  }
  return (
    <section aria-label="Project overview" className="grid min-w-0 gap-3 rounded-lg border border-line p-4">
      <h2 className="font-display text-lg">Project overview</h2>
      <Button
        disabled={sessions.isFetching || artifacts.isFetching}
        onClick={() => {
          void sessions.refetch();
          void artifacts.refetch();
        }}
      >
        Refresh project overview
      </Button>
      {sessions.isPending ? <p role="status">Reading project history…</p> : null}
      {sessions.error ? (
        <Callout tone="error">{describeApiError(sessions.error).summary} Conversation history is unavailable.</Callout>
      ) : null}
      {artifacts.error ? (
        <Callout tone="warning">
          {describeApiError(artifacts.error).summary} Artifact records are unavailable; conversation references are
          partial evidence.
        </Callout>
      ) : null}
      {error ? <Callout tone="error">{error}</Callout> : null}
      <details>
        <summary>Project intake</summary>
        <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
          {PROJECT_INTAKE_MODES.map((intent) => (
            <Button
              key={intent.id}
              disabled={!available || busy || project.lifecycleStatus !== "active"}
              className="h-auto min-w-0 flex-col items-start whitespace-normal p-3 text-left"
              aria-label={`Start ${intent.label} for ${project.name}`}
              onClick={() => route.requestTransition(transition => { if (transition.isCurrent()) void start(intent, transition); })}
            >
              <span>{intent.label}</span>
              <span className="text-xs font-normal">{intent.detail}</span>
            </Button>
          ))}
        </div>
      </details>
      {home ? (
        <>
          <p>
            Latest activity: {home.lastActivityLabel}. {home.activeCount} active conversations in loaded history.
          </p>
          {home.latestByMode.chat ? (
            <NativeOwnerLink
              scope={access.identity}
              href={`/chat?sessionId=${encodeURIComponent(home.latestByMode.chat.sessionId)}&projectId=${encodeURIComponent(project.projectId)}`}
            >
              Continue Chat
            </NativeOwnerLink>
          ) : (
            <p>No continuation point in loaded history.</p>
          )}
          <details>
            <summary>Project status and readiness</summary>
            <p>
              {home.healthLabel}: {home.healthDetail}
            </p>
            <p>
              {home.artifactCount}{" "}
              {home.artifactCountSource === "records" ? "artifact records" : "conversation artifact references"} in
              loaded history.
            </p>
            <ul>
              {home.readiness.map((item) => (
                <li key={item.id}>
                  {item.label}: {item.detail}
                </li>
              ))}
            </ul>
          </details>
          <h3 className="font-semibold">Recent project work</h3>
          <ul className="grid gap-2">
            {home.recentSessions.map((session) => (
              <li key={session.sessionId}>
                <NativeOwnerLink
                  scope={access.identity}
                  href={`/chat?sessionId=${encodeURIComponent(session.sessionId)}&projectId=${encodeURIComponent(project.projectId)}`}
                >
                  {session.title || "Untitled conversation"}
                </NativeOwnerLink>
                <p className="text-xs text-fg-muted">
                  {session.lifecycleStatus} · {session.lastActivityAt}
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <NativeOwnerLink scope={access.identity} href="/library/memory">
          Review memory and provenance
        </NativeOwnerLink>
        <NativeOwnerLink
          scope={access.identity}
          href={`/library/artifacts?projectId=${encodeURIComponent(project.projectId)}`}
        >
          Reopen project artifacts
        </NativeOwnerLink>
      </div>
      {currentArtifacts.length ? (
        <ul className="grid gap-2">
          {currentArtifacts.slice(0, 20).map((artifact) => (
            <li key={artifact.artifactId}>
              <NativeOwnerLink
                scope={access.identity}
                href={`/library/artifacts?projectId=${encodeURIComponent(project.projectId)}&artifactId=${encodeURIComponent(artifact.artifactId)}`}
              >
                {artifact.title}
              </NativeOwnerLink>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-fg-muted">
        Overview reads up to 1,000 conversations and 1,000 artifacts. Counts and readiness describe returned records;
        they do not certify project completion.
      </p>
    </section>
  );
}
