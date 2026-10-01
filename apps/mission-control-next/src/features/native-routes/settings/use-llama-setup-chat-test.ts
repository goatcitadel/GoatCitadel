import { useEffect, useRef, useState } from "react";
import type { LlamaCppSetupChatTestResult, LlamaCppSetupProjection } from "@goatcitadel/contracts";
import { fetchLlamaCppSetup, testLlamaCppChat } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  beginLlamaAttempt,
  finishLlamaAttempt,
  llamaProjectionBinding,
  llamaProjectionReady,
  llamaSnapshot,
  useLlamaSetupState,
} from "./llama-setup-state";

export function useLlamaSetupChatTest({
  workspaceId,
  projection,
  available,
  refresh,
}: {
  workspaceId: string;
  projection?: LlamaCppSetupProjection;
  available: boolean;
  refresh: () => Promise<unknown>;
}) {
  const installation = getGatewayApiBaseUrl(),
    state = useLlamaSetupState(installation, workspaceId);
  const [review, setReview] = useState<{ projection: LlamaCppSetupProjection; epoch: number } | null>(null);
  const [result, setResult] = useState<{
    installation: string;
    workspaceId: string;
    binding: string;
    stale: boolean;
    value: LlamaCppSetupChatTestResult;
  }>();
  const [message, setMessage] = useState<string | null>(null);
  const life = useRef({ identity: "", epoch: 0, mounted: false });
  const identity = llamaSnapshot([
    installation,
    workspaceId,
    available,
    projection && llamaProjectionBinding(projection),
  ]);
  if (life.current.identity !== identity) {
    life.current.identity = identity;
    life.current.epoch++;
  }
  useEffect(() => {
    const owner = life.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.epoch++;
    };
  }, []);
  const current = (epoch: number) =>
    life.current.mounted && life.current.epoch === epoch && getGatewayApiBaseUrl() === installation;
  const eligible = Boolean(
    workspaceId &&
    available &&
    !state.attempt &&
    !state.pending &&
    projection?.chatRoute.providerId === "llamacpp" &&
    projection.chatRoute.model,
  );
  const reviewCurrent = Boolean(
    review &&
    eligible &&
    current(review.epoch) &&
    projection &&
    llamaProjectionBinding(projection) === llamaProjectionBinding(review.projection),
  );
  async function confirm() {
    if (!review || !reviewCurrent || !beginLlamaAttempt(installation)) return;
    const intent = review,
      epoch = life.current.epoch;
    let dispatched = false,
      acknowledged = false;
    setReview(null);
    setMessage(null);
    try {
      const latest = await fetchLlamaCppSetup(workspaceId);
      if (!current(epoch)) return;
      if (
        !llamaProjectionReady(latest) ||
        llamaProjectionBinding(latest) !== llamaProjectionBinding(intent.projection)
      ) {
        setMessage("The selected runtime changed. Refresh and review the Chat diagnostic again.");
        return;
      }
      dispatched = true;
      const tested = await testLlamaCppChat(workspaceId);
      if (
        getGatewayApiBaseUrl() !== installation ||
        typeof tested.success !== "boolean" ||
        tested.settingsRevision !== latest.settingsRevision ||
        tested.providerId !== "llamacpp" ||
        tested.model !== latest.chatRoute.model ||
        !Number.isFinite(tested.elapsedMs) ||
        tested.elapsedMs < 0 ||
        (tested.success && (!tested.traceRef?.trim() || !tested.responseExcerpt?.trim()))
      )
        throw new Error("The Chat diagnostic returned unrelated evidence.");
      const after = await fetchLlamaCppSetup(workspaceId);
      if (getGatewayApiBaseUrl() !== installation || !llamaProjectionReady(after))
        throw new Error("Runtime readback unavailable.");
      acknowledged = true;
      if (current(epoch)) {
        setResult({
          installation,
          workspaceId,
          binding: llamaProjectionBinding(latest),
          stale: llamaProjectionBinding(after) !== llamaProjectionBinding(latest),
          value: tested,
        });
        setMessage(
          llamaProjectionBinding(after) !== llamaProjectionBinding(latest)
            ? "The runtime changed during the diagnostic. This result is stale; review the current route before testing again."
            : tested.success
              ? "A real Chat response completed on the reviewed route."
              : "The Chat diagnostic did not complete successfully. Inspect the reported error.",
        );
        await refresh();
      }
    } catch {
      if (!dispatched && current(epoch))
        setMessage("Current setup evidence is unavailable. No Chat diagnostic was sent.");
    } finally {
      finishLlamaAttempt(installation, dispatched && !acknowledged);
    }
  }
  return {
    eligible,
    review,
    reviewCurrent,
    message,
    result: result?.installation === installation && result.workspaceId === workspaceId ? result.value : undefined,
    stale: Boolean(result && (result.stale || (projection && result.binding !== llamaProjectionBinding(projection)))),
    requestReview: () => {
      if (eligible && projection) setReview({ projection: structuredClone(projection), epoch: life.current.epoch });
    },
    cancel: () => {
      life.current.epoch++;
      setReview(null);
    },
    confirm,
  };
}
