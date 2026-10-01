import { useEffect } from "react";
import { normalizeOpenAICodexPollDelayMs, OPENAI_CODEX_MIN_POLL_MS } from "../helpers/provider-oauth";

/** Cleanup never releases admission while an actual owner request is still in flight. */
export function useProviderOAuthPolling({
  workspaceId,
  flowId,
  pollAfterMs,
  poll,
}: {
  workspaceId: string;
  flowId?: string;
  pollAfterMs?: number;
  poll: () => Promise<number | false>;
}) {
  useEffect(() => {
    if (!flowId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const keepPolling = await poll();
      if (!cancelled && keepPolling !== false)
        timer = setTimeout(
          () => void tick(),
          Math.max(normalizeOpenAICodexPollDelayMs(keepPolling), OPENAI_CODEX_MIN_POLL_MS),
        );
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [workspaceId, flowId, pollAfterMs, poll]);
}
