import { useCrossProjectRecentSessions } from "@goatcitadel/mission-control-shared/hooks/useCrossProjectRecentSessions";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
export function ProjectRecents({ workspaceId }: { workspaceId: string }) {
  const recent = useCrossProjectRecentSessions(workspaceId, { limit: 4 });
  return (
    <section aria-label="Recent cross-project conversations" className="grid gap-2 rounded-lg border border-line p-3">
      <h2 className="font-display text-lg">Pick up where you left off</h2>
      {recent.loading ? (
        <p role="status">Reading recent conversations…</p>
      ) : recent.error ? (
        <p role="alert">{recent.error}</p>
      ) : recent.items.length ? (
        <ul className="grid gap-2">
          {recent.items.map((item) => (
            <li key={item.sessionId}>
              <NativeOwnerLink
                scope={[workspaceId, item.sessionId]}
                href={`/chat?sessionId=${encodeURIComponent(item.sessionId)}${item.projectId ? `&projectId=${encodeURIComponent(item.projectId)}` : ""}`}
              >
                {item.title || "Untitled conversation"} · {item.projectLabel}
              </NativeOwnerLink>
            </li>
          ))}
        </ul>
      ) : (
        <p>No recent project conversations.</p>
      )}
    </section>
  );
}
