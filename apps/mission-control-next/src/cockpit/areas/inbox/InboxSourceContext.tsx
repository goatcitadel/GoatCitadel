import { useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { readInboxSourceContext } from "./inbox-source-context";

export function InboxSourceContext({ item, workspaceId }: { item: OperatorInboxItem; workspaceId: string }) {
  const preferences = useUiPreferences();
  const installation = getGatewayApiBaseUrl();
  const sessionId = item.source.sessionId;
  const key = JSON.stringify([
    installation,
    workspaceId,
    preferences.activeWorkspaceId,
    preferences.activeCitadelId,
    item.source.workspaceId,
    item.id,
    item.createdAt,
    item.updatedAt,
    sessionId,
  ]);
  const viewRef = useRef({ key });
  if (viewRef.current.key !== key) viewRef.current = { key };
  const view = viewRef.current;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const eligible = Boolean(
    sessionId &&
    item.source.workspaceId === workspaceId &&
    (preferences.activeWorkspaceId ?? "default") === workspaceId,
  );
  const query = useQuery({
    queryKey: ["chat", "inbox-source-context", key],
    enabled: eligible,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: ({ signal }) =>
      readInboxSourceContext(
        workspaceId,
        sessionId!,
        signal,
        () => mounted.current && viewRef.current === view && getGatewayApiBaseUrl() === installation,
      ),
  });
  const message = !query.isFetching && !query.isError && eligible ? query.data : undefined;
  return (
    <section aria-label="Source conversation context" className="rounded-md border border-line bg-sunken p-3">
      <h3 className="text-sm font-medium text-fg">Most recent stored message</h3>
      <p className="mt-1 text-xs text-fg-muted">
        Current conversation context; the decision above still requires its own exact review.
      </p>
      {query.isFetching ? (
        <p role="status" className="mt-2 text-xs text-fg-muted">
          Reading source conversation…
        </p>
      ) : !eligible || query.isError || message === undefined ? (
        <p className="mt-2 text-xs text-fg-muted">Source conversation context unavailable.</p>
      ) : message === null ? (
        <p className="mt-2 text-xs text-fg-muted">No stored messages were returned.</p>
      ) : (
        <>
          <p className="mt-2 text-xs text-fg-muted">
            {message.role} · <time dateTime={message.timestamp}>{new Date(message.timestamp).toLocaleString()}</time>
          </p>
          <blockquote className="mt-2 whitespace-pre-wrap break-words text-sm text-fg-secondary">
            {message.text || "This message has no text content."}
            {message.truncated ? "…" : ""}
          </blockquote>
        </>
      )}
    </section>
  );
}
