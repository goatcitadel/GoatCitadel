import { useCallback, useEffect, useId, useState } from "react";
import { Hammer, RefreshCw, Send, Sparkles } from "lucide-react";
import type { BlueprintReviewSummary, MasonAnswers, MasonSession } from "@goatcitadel/contracts";
import {
  createMasonSession,
  draftBlueprintFromMasonSession,
  getMasonSetupQuestions,
  reviewMasonBlueprint,
  sendMasonMessage,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { getErrorMessage } from "../shared/native-helpers";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

interface QuestionsState {
  loading: boolean;
  error: string | null;
  items: string[];
}

interface SessionState {
  session: MasonSession | null;
  busy: boolean;
  error: string | null;
}

interface ReviewState {
  loading: boolean;
  error: string | null;
  summary: BlueprintReviewSummary | null;
}

/** Flatten the partial answers into operator-readable rows for the session summary. */
function describeAnswers(answers: Partial<MasonAnswers>): Array<{ title: string; body?: string }> {
  const rows: Array<{ title: string; body?: string }> = [];
  if (answers.kind) rows.push({ title: "Kind", body: answers.kind });
  if (answers.name) rows.push({ title: "Name", body: answers.name });
  if (answers.purpose) rows.push({ title: "Purpose", body: answers.purpose });
  if (answers.riskPosture) rows.push({ title: "Risk posture", body: answers.riskPosture });
  if (answers.goals?.length) rows.push({ title: "Goals", body: answers.goals.join(", ") });
  if (answers.sensitiveAreas?.length) {
    rows.push({ title: "Sensitive areas (become sealed Chambers)", body: answers.sensitiveAreas.join(", ") });
  }
  if (answers.boundaries?.length) rows.push({ title: "Boundaries", body: answers.boundaries.join(", ") });
  if (answers.successDefinition?.length) {
    rows.push({ title: "Success", body: answers.successDefinition.join(", ") });
  }
  return rows;
}

/**
 * The Mason setup surface (spec §9 / §6.1). Walks the operator from the setup
 * questions through a draft Blueprint, exercising the conversational message
 * step (freeform → model interpretation → merged answers) and the
 * review-before-activation summary. Staging never connects accounts or opens Gates.
 */
export function CitadelMasonRoutePage({
  route,
  activeWorkspaceName,
  activeCitadelName = activeWorkspaceName,
}: NativeRoutePagesProps) {
  const messageInputId = useId();
  const [questions, setQuestions] = useState<QuestionsState>({ loading: true, error: null, items: [] });
  const [sessionState, setSessionState] = useState<SessionState>({ session: null, busy: false, error: null });
  const [message, setMessage] = useState("");
  const [review, setReview] = useState<ReviewState>({ loading: false, error: null, summary: null });

  useEffect(() => {
    let cancelled = false;
    setQuestions((current) => ({ ...current, loading: true, error: null }));
    void getMasonSetupQuestions()
      .then((items) => {
        if (!cancelled) {
          setQuestions({ loading: false, error: null, items });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setQuestions({ loading: false, error: getErrorMessage(error), items: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startSession = useCallback(async () => {
    setSessionState((current) => ({ ...current, busy: true, error: null }));
    try {
      const session = await createMasonSession();
      setSessionState({ session, busy: false, error: null });
      setReview({ loading: false, error: null, summary: null });
    } catch (error) {
      setSessionState((current) => ({ ...current, busy: false, error: getErrorMessage(error) }));
    }
  }, []);

  const submitMessage = useCallback(async () => {
    const session = sessionState.session;
    const trimmed = message.trim();
    if (!session || !trimmed) {
      return;
    }
    setSessionState((current) => ({ ...current, busy: true, error: null }));
    try {
      const updated = await sendMasonMessage(session.sessionId, trimmed);
      setSessionState({ session: updated, busy: false, error: null });
      setMessage("");
    } catch (error) {
      setSessionState((current) => ({ ...current, busy: false, error: getErrorMessage(error) }));
    }
  }, [message, sessionState.session]);

  const draftAndReview = useCallback(async () => {
    const session = sessionState.session;
    if (!session) {
      return;
    }
    setReview({ loading: true, error: null, summary: null });
    try {
      const blueprint = await draftBlueprintFromMasonSession(session.sessionId);
      const summary = await reviewMasonBlueprint(blueprint);
      setReview({ loading: false, error: null, summary });
    } catch (error) {
      setReview({ loading: false, error: getErrorMessage(error), summary: null });
    }
  }, [sessionState.session]);

  const session = sessionState.session;
  const answerRows = session ? describeAnswers(session.answers) : [];
  // Mirrors contracts' masonSessionCanDraft (kind + non-empty purpose). Inlined so
  // this browser surface never value-imports the contracts barrel, which pulls in
  // the Node-only `node:crypto` Vault primitives and crashes in the browser.
  const canDraft = session
    ? typeof session.answers.kind === "string" && (session.answers.purpose ?? "").trim().length > 0
    : false;

  return (
    <NativePageFrame
      icon={Hammer}
      area="library"
      kicker={routeKicker(route)}
      title="The Mason"
      description={`Stage a Citadel for ${activeCitadelName} by answering the Mason — nothing is connected or activated until you review and confirm.`}
      loading={questions.loading}
      error={questions.error}
    >
      <NativeGrid>
        <NativeCard
          title="Setup questions"
          subtitle="The Mason works through these to draft your Charter, Chambers, and boundaries."
          stats={[{ label: "Questions", value: String(questions.items.length) }]}
        >
          {questions.items.length === 0 ? (
            <EmptyState size="compact" title="No setup questions available." />
          ) : (
            <ol className="mc-next-mason-questions">
              {questions.items.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ol>
          )}
        </NativeCard>

        <NativeCard
          title="Your answers"
          subtitle="Reply in plain language; the Mason interprets it into the Blueprint. You can also keep refining."
          stats={[
            { label: "Status", value: session ? session.status : "not started" },
            { label: "Captured", value: String(answerRows.length) },
          ]}
          actions={
            session ? (
              <NativeButton
                variant="outline"
                disabled={!canDraft || review.loading}
                onClick={() => void draftAndReview()}
              >
                <Sparkles size={16} />
                {review.loading ? "Drafting…" : "Draft & review Blueprint"}
              </NativeButton>
            ) : undefined
          }
        >
          {sessionState.error ? <NoticeBanner tone="error" message={sessionState.error} /> : null}
          {!session ? (
            <div className="mc-next-mason-start">
              <p>Start a session and tell the Mason what this Citadel is for.</p>
              <NativeButton variant="default" disabled={sessionState.busy} onClick={() => void startSession()}>
                <Hammer size={16} />
                {sessionState.busy ? "Starting…" : "Start setup"}
              </NativeButton>
            </div>
          ) : (
            <>
              <NativeList
                items={answerRows.map((row) => ({ title: row.title, body: row.body }))}
                emptyLabel="No answers captured yet — tell the Mason about your Citadel below."
                density="compact"
              />
              <label className="mc-next-mason-field" htmlFor={messageInputId}>
                <span>Message the Mason</span>
                <textarea
                  id={messageInputId}
                  className="mc-next-settings-textarea"
                  value={message}
                  rows={3}
                  placeholder="e.g. I run a small startup; keep finances and legal sealed and prefer local models for sensitive work."
                  onChange={(event) => setMessage(event.target.value)}
                />
              </label>
              <NativeButton
                variant="default"
                disabled={sessionState.busy || message.trim().length === 0}
                onClick={() => void submitMessage()}
              >
                <Send size={16} />
                {sessionState.busy ? "Interpreting…" : "Send to the Mason"}
              </NativeButton>
            </>
          )}
        </NativeCard>

        {review.summary ? (
          <NativeCard
            title="Blueprint review"
            subtitle="Review-before-activation: staging a Citadel never connects accounts or opens Gates."
            stats={[
              { label: "Chambers", value: String(review.summary.chamberCount) },
              { label: "Sealed", value: String(review.summary.sealedChamberCount) },
            ]}
          >
            <ul className="mc-next-mason-review">
              {review.summary.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </NativeCard>
        ) : review.error ? (
          <NativeCard title="Blueprint review" subtitle="The draft could not be reviewed.">
            <NoticeBanner tone="error" message={review.error} />
          </NativeCard>
        ) : null}
      </NativeGrid>

      <p className="mc-next-mason-footnote">
        <RefreshCw size={12} aria-hidden="true" />
        The Mason runs on your configured model. With no model set, structured answers still draft a Blueprint.
      </p>
    </NativePageFrame>
  );
}
