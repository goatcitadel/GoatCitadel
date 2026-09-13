import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSessionStatusResponse } from "@goatcitadel/contracts";
import {
  fetchChatSessionStatus,
  stopChatFanout,
} from "@goatcitadel/mission-control-shared/api/client";

type Snapshot = {
  open: boolean;
  loading: boolean;
  error: string | null;
  status: ChatSessionStatusResponse | null;
};
const empty: Snapshot = {
  open: false,
  loading: false,
  error: null,
  status: null,
};

export function useChatSessionStatus({
  sessionId,
  workspaceId,
  enabled,
  pushLocalNotice,
}: {
  sessionId: string | null;
  workspaceId: string;
  enabled: boolean;
  pushLocalNotice: (message: string, tone: "success") => void;
}) {
  const scope = JSON.stringify([workspaceId, sessionId, enabled]);
  const owner = useRef({ scope, generation: 0 });
  if (owner.current.scope !== scope)
    owner.current = { scope, generation: owner.current.generation + 1 };
  const viewGeneration = owner.current.generation;
  const request = useRef(0),
    stopping = useRef<number | null>(null),
    mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    generation: number;
    value: Snapshot;
  }>({
    scope,
    generation: viewGeneration,
    value: empty,
  });
  const panel =
    snapshot.scope === scope && snapshot.generation === viewGeneration
      ? snapshot.value
      : empty;
  const update = useCallback(
    (change: (current: Snapshot) => Snapshot) => {
      if (owner.current.generation !== viewGeneration) return;
      setSnapshot((current) => ({
        scope,
        generation: viewGeneration,
        value: change(
          current.scope === scope && current.generation === viewGeneration
            ? current.value
            : empty,
        ),
      }));
    },
    [scope, viewGeneration],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);
  const close = useCallback(() => {
    update((current) => ({ ...current, open: false }));
  }, [update]);
  const refresh = useCallback(
    async (open = true) => {
      if (
        !enabled ||
        !sessionId ||
        owner.current.scope !== scope ||
        stopping.current === owner.current.generation
      )
        return;
      const generation = owner.current.generation,
        ticket = ++request.current;
      const current = () =>
        mounted.current &&
        owner.current.generation === generation &&
        ticket === request.current;
      update((value) => ({
        ...value,
        open: open || value.open,
        loading: true,
        error: null,
      }));
      try {
        const status = await fetchChatSessionStatus(sessionId);
        if (!current()) return;
        if (
          status.sessionId !== sessionId ||
          status.workspaceId !== workspaceId
        )
          throw new Error(
            "The Gateway returned status for a different Chat scope.",
          );
        update((value) => ({ ...value, status, loading: false, error: null }));
      } catch (error) {
        if (current())
          update((value) => ({
            ...value,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
    },
    [enabled, scope, sessionId, update, workspaceId],
  );
  const stopFanout = useCallback(
    async (invocationId: string) => {
      if (
        !enabled ||
        !sessionId ||
        owner.current.scope !== scope ||
        stopping.current === owner.current.generation
      )
        return;
      const generation = owner.current.generation;
      stopping.current = generation;
      request.current += 1;
      const current = () =>
        mounted.current && owner.current.generation === generation;
      update((value) => ({ ...value, loading: true, error: null }));
      let stoppedStatus: string | null = null;
      try {
        const stopped = await stopChatFanout(sessionId, invocationId);
        if (!current()) return;
        if (stopped.invocationId !== invocationId || !stopped.status)
          throw new Error(
            "The Gateway did not confirm this fan-out stop request. Refresh canonical status before retrying.",
          );
        stoppedStatus = stopped.status;
        pushLocalNotice(
          "Fan-out stop response: " +
            stoppedStatus +
            ". Inspect canonical child state for cancellation settlement.",
          "success",
        );
        const status = await fetchChatSessionStatus(sessionId);
        if (!current()) return;
        if (
          status.sessionId !== sessionId ||
          status.workspaceId !== workspaceId
        )
          throw new Error(
            "The Gateway returned status for a different Chat scope.",
          );
        update((value) => ({ ...value, status, loading: false, error: null }));
      } catch (error) {
        if (current())
          update((value) => ({
            ...value,
            loading: false,
            error:
              (stoppedStatus
                ? "Stop response received (" +
                  stoppedStatus +
                  "), but canonical status could not be refreshed: "
                : "") +
              (error instanceof Error ? error.message : String(error)),
          }));
      } finally {
        if (stopping.current === generation) stopping.current = null;
      }
    },
    [enabled, scope, sessionId, update, workspaceId, pushLocalNotice],
  );
  return { panel, refresh, stopFanout, close };
}
