import { useEffect, useRef, useState } from "react";
import { canonicalJsonString, type LocalAiFitRecommendation } from "@goatcitadel/contracts";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import {
  fetchLocalAiReadiness,
  startLocalAiDownload,
  startLocalAiServe,
} from "@goatcitadel/mission-control-shared/api/local-ai";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { nativeLoad, nativeLoadIssues, useAsyncLoad, type Notice } from "../shared/native-helpers";
import {
  assertLocalAiReadiness,
  groupLocalAiRecommendations,
  localAiModelKey,
  localAiReviewBinding,
  type LocalAiIntent,
} from "./local-ai-model";
import { localAiRequestLocked, setLocalAiRequest, useLocalAiRequestState } from "./local-ai-request-state";

type Review = {
  scope: string;
  generation: number;
  kind: LocalAiIntent;
  model: LocalAiFitRecommendation;
  binding: string;
  key: string;
};

/** Shared installation-scoped reads and explicit approval-intent requests. These routes execute no model work. */
export function useLocalAiSettings() {
  const { activeCitadelId } = useUiPreferences();
  const scope = activeCitadelId ?? "";
  const [selected, setSelected] = useState<{ scope: string; key: string } | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [noticeState, setNoticeState] = useState<{ scope: string; value: Notice } | null>(null);
  const setNotice = (value: Notice | null) => setNoticeState(value ? { scope, value } : null);
  const notice = noticeState?.scope === scope ? noticeState.value : null;
  const lifetime = useRef({ active: true, scope, generation: 0 });
  if (lifetime.current.scope !== scope) {
    lifetime.current.scope = scope;
    lifetime.current.generation += 1;
  }
  useEffect(() => {
    const current = lifetime.current;
    current.active = true;
    return () => {
      current.active = false;
      current.generation += 1;
    };
  }, []);
  const load = useAsyncLoad(async () => {
    const readiness = await nativeLoad(
      "Local AI readiness",
      fetchLocalAiReadiness().then(assertLocalAiReadiness),
      null,
    );
    return { scope, readiness: readiness.data, issues: nativeLoadIssues([readiness]) };
  }, [scope]);
  const data = !load.loading && !load.error && load.data?.scope === scope ? load.data : null;
  const readiness = !load.loading && !load.error ? (data?.readiness ?? null) : null;
  const recommendations = readiness?.recommendations ?? [];
  const selectedModelKey = selected?.scope === scope ? selected.key : "";
  const topRecommendation = selectedModelKey
    ? (recommendations.find((item) => localAiModelKey(item) === selectedModelKey) ?? null)
    : (recommendations[0] ?? null);
  const requestState = useLocalAiRequestState();
  // The owner has installation-wide Maps; Citadel navigation must not release a pending or uncertain request.
  const requestKey = (kind: LocalAiIntent, model = topRecommendation) =>
    JSON.stringify([getGatewayApiBaseUrl(), kind, model && localAiModelKey(model)]);
  const queueing = ["download", "serve"].some((kind) => localAiRequestLocked(requestKey(kind as LocalAiIntent)));
  const current = (generation: number) =>
    lifetime.current.active && lifetime.current.generation === generation && lifetime.current.scope === scope;
  const cancel = () => {
    lifetime.current.generation += 1;
    setReview(null);
  };
  const setSelectedModelKey = (key: string) => {
    cancel();
    setNotice(null);
    setSelected({ scope, key });
  };
  const reload = async () => {
    cancel();
    await load.reload();
  };

  function requestReview(kind: LocalAiIntent) {
    if (!readiness || !topRecommendation || queueing) return;
    const key = requestKey(kind);
    try {
      setReview({
        scope,
        generation: lifetime.current.generation,
        kind,
        model: structuredClone(topRecommendation),
        binding: localAiReviewBinding(readiness, localAiModelKey(topRecommendation)),
        key,
      });
      setNotice(null);
    } catch (error) {
      setNotice({ tone: "warning", message: describeApiError(error).summary });
    }
  }
  async function confirm() {
    if (
      !review ||
      review.scope !== scope ||
      review.generation !== lifetime.current.generation ||
      queueing ||
      !readiness ||
      !topRecommendation ||
      localAiModelKey(review.model) !== localAiModelKey(topRecommendation)
    )
      return;
    const intent = review,
      generation = lifetime.current.generation;
    if (!current(generation) || localAiRequestLocked(intent.key)) return;
    setLocalAiRequest(intent.key, { phase: "checking" });
    setNotice(null);
    let dispatched = false;
    try {
      const fresh = assertLocalAiReadiness(await fetchLocalAiReadiness());
      if (!current(generation)) return;
      if (localAiReviewBinding(fresh, localAiModelKey(intent.model)) !== intent.binding)
        throw new Error("The model fit or runtime evidence changed. Refresh and review it again.");
      setLocalAiRequest(intent.key, { phase: "requesting" });
      dispatched = true;
      const input = { modelId: intent.model.modelId, backend: intent.model.backend, approvalMode: "request" as const };
      const job = intent.kind === "download" ? await startLocalAiDownload(input) : await startLocalAiServe(input);
      if (
        !job?.jobId ||
        !job.approvalId ||
        job.status !== "requires_approval" ||
        job.modelId !== input.modelId ||
        job.backend !== input.backend
      ) {
        throw new Error("The Gateway did not confirm the exact approval request.");
      }
      if (lifetime.current.scope !== scope) throw new Error("The selected Citadel changed before request readback.");
      const owner = assertLocalAiReadiness(await fetchLocalAiReadiness());
      if (lifetime.current.scope !== scope) throw new Error("The selected Citadel changed during request readback.");
      const records = (intent.kind === "download" ? owner.downloads : owner.serveJobs).filter(
        (item) => item.jobId === job.jobId,
      );
      if (records.length !== 1 || canonicalJsonString(records[0]) !== canonicalJsonString(job))
        throw new Error("The approval request could not be confirmed in the retained job owner.");
      const message = `${intent.kind === "download" ? "Download" : "Serve"} approval request recorded. No model download or server start was performed.`;
      setLocalAiRequest(intent.key, { phase: "confirmed", message, approvalId: job.approvalId });
      if (current(generation)) {
        setReview(null);
        setNotice({ tone: "success", message });
        await load.reload();
      }
    } catch (error) {
      const message = dispatched
        ? `Request outcome is unconfirmed. Do not retry this request in this app session. Review retained jobs and approvals. ${describeApiError(error).summary}`
        : `No approval request was sent. ${describeApiError(error).summary}`;
      if (dispatched) setLocalAiRequest(intent.key, { phase: "uncertain", message });
      if (current(generation)) {
        setReview(null);
        setNotice({ tone: "error", message });
      }
    } finally {
      if (!dispatched) setLocalAiRequest(intent.key);
    }
  }
  return {
    loading: load.loading,
    error: load.error,
    data,
    readiness,
    reload,
    notice,
    recommendations,
    topRecommendation,
    selectedModelKey,
    setSelectedModelKey,
    recommendationRows: groupLocalAiRecommendations(recommendations),
    hasDetectedRuntime: readiness?.hardware.runtimes.some((runtime) => runtime.detected) ?? false,
    hasRegisteredEndpoint: Boolean(readiness?.endpoints.length),
    review: review?.scope === scope && review.generation === lifetime.current.generation ? review : null,
    requestReview,
    confirm,
    cancel,
    queueing,
    stateFor: (kind: LocalAiIntent) => requestState.stateFor(requestKey(kind)),
  };
}
