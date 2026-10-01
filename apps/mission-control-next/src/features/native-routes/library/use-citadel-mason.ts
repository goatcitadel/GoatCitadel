import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BlueprintReviewSummary, CitadelBlueprint, MasonAnswers, MasonSession } from "@goatcitadel/contracts";
import {
  createMasonSession,
  draftBlueprintFromMasonSession,
  draftMasonBlueprint,
  getMasonSession,
  getMasonSetupQuestions,
  reviewMasonBlueprint,
  sendMasonMessage,
  updateMasonSessionAnswers,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { sameBlueprintValue } from "./citadel-blueprint-binding";
import { masonCanDraft, masonReceiptMatches, masonSummaryMatches, validMasonSession } from "./mason-session-binding";
import { masonAttempt, masonAttemptKey, setMasonAttempt, subscribeMasonAttempts } from "./mason-session-state";
import { getErrorMessage } from "../shared/native-helpers";

export interface MasonReview {
  blueprint: CitadelBlueprint;
  summary: BlueprintReviewSummary;
  session: MasonSession;
}
/** Both shells use the global session owner. Citadel scope is only local editor placement. */
export function useCitadelMason(citadelId: string) {
  const installation = getGatewayApiBaseUrl(),
    scope = JSON.stringify([installation, citadelId]);
  const [sessionId, setSessionId] = useSessionViewState<string | null>(`mason:${scope}:session`, null);
  const [questionIndex, setQuestionIndex] = useSessionViewState(`mason:${scope}:question`, 0);
  const [session, setSession] = useState<MasonSession | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<MasonReview | null>(null);
  const live = useRef({ scope, sessionId, mounted: true, generation: 0, read: 0 });
  if (live.current.scope !== scope || live.current.sessionId !== sessionId) {
    live.current.scope = scope;
    live.current.sessionId = sessionId;
    live.current.generation++;
  }
  const key = masonAttemptKey(installation, sessionId);
  const attempt = useSyncExternalStore(
    subscribeMasonAttempts,
    () => masonAttempt(key),
    () => masonAttempt(key),
  );
  const currentAt = useCallback((generation: number) =>
    live.current.mounted &&
    live.current.scope === scope &&
    live.current.generation === generation &&
    getGatewayApiBaseUrl() === installation, [scope, installation]);
  const installationCurrent = () => getGatewayApiBaseUrl() === installation;
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    setSession(null);
    setReview(null);
    setError(null);
    return () => {
      owner.mounted = false;
      owner.generation++;
      owner.read++;
    };
  }, [scope]);
  useEffect(() => {
    let cancelled = false;
    void getMasonSetupQuestions()
      .then((items) => {
        if (!cancelled && getGatewayApiBaseUrl() === installation) setQuestions(items);
      })
      .catch((reason) => {
        if (!cancelled && getGatewayApiBaseUrl() === installation) setError(getErrorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [installation]);
  const refresh = useCallback(async () => {
    live.current.generation++;
    const generation = live.current.generation,
      read = ++live.current.read;
    setReview(null);
    setError(null);
    setLoading(Boolean(sessionId));
    if (!sessionId) {
      setSession(null);
      return;
    }
    try {
      const value = await getMasonSession(sessionId);
      if (!validMasonSession(value, sessionId))
        throw new Error("The Mason session response has a different or unavailable identity.");
      if (currentAt(generation) && live.current.read === read) setSession(value);
    } catch (reason) {
      if (currentAt(generation) && live.current.read === read) {
        setSession(null);
        setError(getErrorMessage(reason));
      }
    } finally {
      if (currentAt(generation) && live.current.read === read) setLoading(false);
    }
  }, [sessionId, currentAt]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  function invalidateReview() {
    live.current.generation++;
    setReview(null);
  }
  async function startSession() {
    if (masonAttempt(key).phase !== "idle" || sessionId || !citadelId) return false;
    const generation = live.current.generation;
    setMasonAttempt(key, { phase: "saving", message: "Creating a Mason session…" });
    setError(null);
    let createdId: string | null = null;
    try {
      const created = await createMasonSession();
      if (
        !installationCurrent() ||
        !validMasonSession(created) ||
        created.status !== "collecting" ||
        Object.keys(created.answers).length
      )
        throw new Error("The created Mason session could not be bound.");
      createdId = created.sessionId;
      setMasonAttempt(masonAttemptKey(installation, createdId), {
        phase: "saving",
        message: "Confirming the created Mason session…",
      });
      const after = await getMasonSession(created.sessionId);
      if (!installationCurrent() || !sameBlueprintValue(after, created))
        throw new Error("The Mason session could not be independently confirmed.");
      setMasonAttempt(key, { phase: "idle" });
      setMasonAttempt(masonAttemptKey(installation, createdId), { phase: "idle" });
      if (currentAt(generation)) {
        setSession(created);
        setQuestionIndex(0);
        setReview(null);
      }
      // Retain the receipt under its originating editor even if navigation happened.
      setSessionId(created.sessionId);
      return true;
    } catch {
      setMasonAttempt(key, {
        phase: "uncertain",
        message: "Mason session creation is unconfirmed. Further creation is withheld in this app session.",
      });
      if (createdId) {
        setMasonAttempt(masonAttemptKey(installation, createdId), {
          phase: "uncertain",
          message:
            "The created Mason session is unconfirmed. Inspect it before continuing; writes are withheld in this app session.",
        });
        setSessionId(createdId);
      }
      return false;
    }
  }
  async function mutate(
    kind: "message" | "answers",
    value: string | Partial<MasonAnswers>,
    isReviewCurrent: () => boolean,
  ) {
    const before = session ? structuredClone(session) : null;
    if (!before || before.sessionId !== sessionId || masonAttempt(key).phase !== "idle") return null;
    const generation = live.current.generation;
    let dispatched = false;
    setMasonAttempt(key, { phase: "checking", message: "Checking the current Mason answers…" });
    setError(null);
    setReview(null);
    try {
      const fresh = await getMasonSession(before.sessionId);
      if (!currentAt(generation) || !isReviewCurrent()) return null;
      if (!sameBlueprintValue(fresh, before))
        throw new Error("Mason answers changed. Refresh and review your draft before trying again.");
      setMasonAttempt(key, {
        phase: "saving",
        message: kind === "message" ? "Interpreting with the configured model…" : "Saving structured answers…",
      });
      dispatched = true;
      const receipt =
        kind === "message"
          ? await sendMasonMessage(before.sessionId, value as string)
          : await updateMasonSessionAnswers(before.sessionId, value as Partial<MasonAnswers>);
      if (
        !installationCurrent() ||
        !masonReceiptMatches(before, receipt, kind === "answers" ? (value as Partial<MasonAnswers>) : undefined)
      )
        throw new Error("Mason returned a conflicting session receipt.");
      const after = await getMasonSession(before.sessionId);
      if (!installationCurrent() || !sameBlueprintValue(after, receipt))
        throw new Error("The Mason write could not be independently confirmed.");
      setMasonAttempt(key, { phase: "idle" });
      if (currentAt(generation)) setSession(after);
      return after;
    } catch (reason) {
      if (dispatched)
        setMasonAttempt(key, {
          phase: "uncertain",
          message: "Mason write outcome is unconfirmed. Inspect the session; retries are withheld in this app session.",
        });
      else if (currentAt(generation)) setError(getErrorMessage(reason));
      return null;
    } finally {
      if (!dispatched) setMasonAttempt(key, { phase: "idle" });
    }
  }
  async function draftAndReview() {
    const before = session ? structuredClone(session) : null;
    if (!before || !masonCanDraft(before) || masonAttempt(key).phase !== "idle") return;
    const generation = live.current.generation;
    let dispatched = false;
    setMasonAttempt(key, { phase: "checking", message: "Checking the captured answers…" });
    setReview(null);
    setError(null);
    try {
      const fresh = await getMasonSession(before.sessionId);
      if (!currentAt(generation)) return;
      if (!sameBlueprintValue(before, fresh)) throw new Error("Mason answers changed. Refresh before drafting.");
      // Stateless canonical draft binds the returned session draft to the answers reviewed above.
      const expected = await draftMasonBlueprint(before.answers as MasonAnswers);
      if (!currentAt(generation)) return;
      dispatched = true;
      setMasonAttempt(key, { phase: "saving", message: "Drafting and reviewing the Blueprint…" });
      const blueprint = await draftBlueprintFromMasonSession(before.sessionId);
      if (!installationCurrent() || !sameBlueprintValue(blueprint, expected))
        throw new Error("The drafted Blueprint differs from the reviewed answers.");
      const after = await getMasonSession(before.sessionId);
      if (
        !installationCurrent() ||
        !masonReceiptMatches({ ...before, status: "drafted" }, after) ||
        !sameBlueprintValue(after.answers, before.answers)
      )
        throw new Error("The drafted session could not be confirmed.");
      const summary = await reviewMasonBlueprint(blueprint);
      if (!installationCurrent() || !masonSummaryMatches(blueprint, summary))
        throw new Error("The Blueprint review is contradictory.");
      setMasonAttempt(key, { phase: "idle" });
      if (currentAt(generation)) {
        setSession(after);
        setReview({ blueprint, summary, session: after });
      }
    } catch (reason) {
      if (dispatched)
        setMasonAttempt(key, {
          phase: "uncertain",
          message:
            "Mason draft outcome is unconfirmed. Refresh to inspect; another draft is withheld in this app session.",
        });
      else if (currentAt(generation)) setError(getErrorMessage(reason));
    } finally {
      if (!dispatched) setMasonAttempt(key, { phase: "idle" });
    }
  }
  return {
    scope,
    installation,
    sessionId,
    session,
    questions,
    questionIndex,
    setQuestionIndex,
    loading,
    error,
    review,
    attempt,
    locked: attempt.phase !== "idle",
    canDraft: masonCanDraft(session),
    refresh,
    invalidateReview,
    startSession,
    draftAndReview,
    mutate,
  };
}
