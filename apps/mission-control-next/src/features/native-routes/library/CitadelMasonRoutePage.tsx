import { useId, useState } from "react";
import { Hammer, RefreshCw, Send, Sparkles } from "lucide-react";
import type { MasonAnswers } from "@goatcitadel/contracts";
import { useMasonEditor } from "./use-mason-editor";
import { useMasonStaging } from "./use-mason-staging";
import { MasonAnswerFields } from "./MasonAnswerFields";
import { NativeCard, NativeDisclosureCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner } from "../primitives";
import { DetailInspector } from "../../../components/DetailInspector";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

type MasonStageState = "complete" | "active" | "pending";

function buildMasonStages(
  answers: Partial<MasonAnswers>,
  sessionStarted: boolean,
  reviewComplete: boolean,
): Array<{ label: string; detail: string; state: MasonStageState }> {
  const definitionComplete = Boolean(answers.kind && answers.purpose?.trim());
  const prioritiesComplete = Boolean(answers.goals?.length || answers.successDefinition?.length);
  const boundariesComplete = Boolean(
    answers.riskPosture || answers.boundaries?.length || answers.sensitiveAreas?.length,
  );
  const checkpoints = [sessionStarted, definitionComplete, prioritiesComplete, boundariesComplete, reviewComplete];
  const firstIncomplete = checkpoints.findIndex((complete) => !complete);
  const activeIndex = firstIncomplete === -1 ? checkpoints.length - 1 : firstIncomplete;
  const labels = [
    ["Begin", "Open a guided staging session."],
    ["Define", "Name the Citadel and state its purpose."],
    ["Priorities", "Capture goals and what success means."],
    ["Boundaries", "Describe risk posture, sealed areas, and limits."],
    ["Review", "Generate and inspect the Blueprint before activation."],
  ] as const;

  return labels.map(([label, detail], index) => ({
    label,
    detail,
    state: checkpoints[index] ? "complete" : index === activeIndex ? "active" : "pending",
  }));
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
  activeWorkspaceId,
  activeCitadelId = activeWorkspaceId,
  activeWorkspaceName,
  activeCitadelName = activeWorkspaceName,
}: NativeRoutePagesProps) {
  const messageInputId = useId();
  const control = useMasonEditor(activeCitadelId);
  const stage = useMasonStaging(activeCitadelId, control.review, control.identity);
  const [reviewOpen, setReviewOpen] = useState(false);
  const { session, questionIndex, leave, messageDraft, startSession } = control;
  const message = messageDraft.value;
  const questions = { items: control.questions, loading: control.loading, error: control.error };
  const sessionState = { busy: control.locked, error: control.attempt.message ?? control.error };
  const review = { loading: control.locked, summary: control.review?.summary, error: control.error };
  const submitMessage = control.sendMessage;
  const draftAndReview = () => { setReviewOpen(true); void control.draftAndReview(); };
  const answerRows = session ? describeAnswers(session.answers) : [];
  const canDraft = control.canDraft;
  const masonStages = buildMasonStages(session?.answers ?? {}, Boolean(session), Boolean(review.summary));

  return (
    <NativePageFrame
      icon={Hammer}
      area="library"
      kicker={routeKicker(route)}
      title="Citadel setup"
      description={`Stage a Citadel for ${activeCitadelName} by answering the Mason — nothing is connected or activated until you review and confirm.`}
      loading={questions.loading}
      error={questions.error}
    >
      <section className="mc-next-mason-progress" aria-label="Citadel staging progress">
        <div className="mc-next-mason-progress-copy">
          <span>Draft only · nothing activates yet</span>
          <strong>Blueprint progress</strong>
          <p>These checkpoints summarize captured answers. They do not activate the Citadel or open any Gate.</p>
        </div>
        <ol>
          {masonStages.map((stage, index) => (
            <li key={stage.label} data-state={stage.state} aria-current={stage.state === "active" ? "step" : undefined}>
              <span>{index + 1}</span>
              <div>
                <strong>{stage.label}</strong>
                <small>{stage.detail}</small>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <NativeGrid className="mc-next-calm-directory">
        <NativeDisclosureCard id="mason-questions"
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
          <div className="mc-next-mason-preflight" aria-label="Staging preflight">
            <strong>Preflight</strong>
            <span>{questions.items.length > 0 ? "Setup prompts ready" : "Setup prompts unavailable"}</span>
            <span>{session ? "Session is staged" : "No staging session yet"}</span>
            <span>{canDraft ? "Minimum Blueprint inputs captured" : "Kind and purpose still required"}</span>
            <span>{review.summary ? "Blueprint reviewed" : "Activation remains unavailable"}</span>
          </div>
        </NativeDisclosureCard>

        <NativeCard
          title={questions.items[questionIndex] ?? "Tell the Mason about this Citadel"}
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
              <NativeDisclosureCard id="mason-answers" title="Your answers"><NativeList
                items={answerRows.map((row) => ({ title: row.title, body: row.body }))}
                emptyLabel="No answers captured yet — tell the Mason about your Citadel below."
                density="compact"
              /></NativeDisclosureCard>
              <NativeDisclosureCard id="mason-structured-answers" title="Structured answers without a model">
                <MasonAnswerFields value={control.answersDraft.value} disabled={control.locked} onChange={control.changeAnswer} />
                {control.answersDraft.hasRemoteChanges ? <NoticeBanner tone="warning" message="Saved answers changed. Your draft is preserved; refresh and compare before saving." /> : null}
                {control.cannotClearName ? <NoticeBanner tone="warning" message="A captured Blueprint name cannot be cleared. Enter its new name." /> : null}
                <NativeButton disabled={control.locked || !control.answersDraft.isDirty || control.answersDraft.hasRemoteChanges || control.messageDraft.isDirty || control.cannotClearName} onClick={() => void control.saveAnswers()}>Save structured answers</NativeButton>
                <NativeButton disabled={control.locked} onClick={control.answersDraft.discard}>Discard answer changes</NativeButton>
              </NativeDisclosureCard>
              <p className="mc-next-settings-copy">Question {Math.min(questionIndex + 1, questions.items.length)} of {questions.items.length} · The Mason</p>
              <div className="mc-next-settings-button-row"><NativeButton variant="ghost" disabled={questionIndex === 0} onClick={() => control.changeQuestion(Math.max(0, questionIndex - 1))}>Previous question</NativeButton><NativeButton variant="ghost" disabled={questionIndex >= questions.items.length - 1} onClick={() => control.changeQuestion(Math.min(questions.items.length - 1, questionIndex + 1))}>Next question</NativeButton></div>
              <label className="mc-next-mason-field" htmlFor={messageInputId}>
                <span>Message the Mason</span>
                <textarea
                  id={messageInputId}
                  className="mc-next-settings-textarea"
                  value={message}
                  rows={3}
                  placeholder="e.g. I run a small startup; keep finances and legal sealed and prefer local models for sensitive work."
                  onChange={(event) => control.changeMessage(event.target.value)}
                />
              </label>
              <NativeButton
                variant="default"
                disabled={sessionState.busy || message.trim().length === 0 || control.answersDraft.isDirty}
                onClick={() => void submitMessage()}
              >
                <Send size={16} />
                {sessionState.busy ? "Interpreting…" : "Send to the Mason"}
              </NativeButton>
            </>
          )}
        </NativeCard>

        <DetailInspector open={reviewOpen} title="Blueprint review" onClose={() => { stage.cancel(); setReviewOpen(false); }}>{review.loading ? <p role="status">Drafting Blueprint…</p> : null}
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
            {control.review ? <dl>
              <dt>Risk posture</dt><dd>{control.review.blueprint.charter.riskPosture}</dd>
              <dt>Model policy</dt><dd>{control.review.blueprint.charter.modelPolicyDefault}</dd>
              <dt>Goals</dt><dd>{control.review.blueprint.charter.goals.join("; ") || "None specified"}</dd>
              <dt>Success criteria</dt><dd>{control.review.blueprint.charter.successDefinition.join("; ") || "None specified"}</dd>
              <dt>Chambers to add</dt><dd>{control.review.blueprint.chambers.map(chamber => `${chamber.name}: ${chamber.sensitivity}, ${chamber.sealed ? "sealed" : "not sealed"}`).join("; ")}</dd>
            </dl> : null}
            <NativeButton disabled={stage.locked || stage.checking || control.locked} onClick={() => void stage.prepare()}>Review staging</NativeButton>
            {stage.review ? <section aria-label="Confirm Blueprint staging">
              <p>Replace the Charter and add {stage.review.candidate.blueprint.chambers.length} Chambers in {stage.review.target.record?.name}. Existing Chambers are retained, and the default Chamber is cleared. No accounts are connected and no Gates are opened.</p>
              <p>Current purpose: {stage.review.target.charter?.purpose ?? "No Charter yet"}</p>
              <p>Reviewed purpose: {stage.review.candidate.blueprint.charter.purpose}</p>
              <NativeButton disabled={stage.locked} onClick={() => void stage.confirm()}>Stage reviewed Blueprint</NativeButton>
              <NativeButton disabled={stage.attempt.phase === "saving"} onClick={stage.cancel}>Cancel staging</NativeButton>
            </section> : null}
            {stage.notice ? <p role="status">{stage.notice}</p> : null}
            {stage.attempt.message ? <NoticeBanner tone="warning" message={stage.attempt.message} /> : null}
          </NativeCard>
        ) : review.error ? (
          <NativeCard title="Blueprint review" subtitle="The draft could not be reviewed.">
            <NoticeBanner tone="error" message={review.error} />
          </NativeCard>
        ) : null}
        </DetailInspector>
      </NativeGrid>

      <NativeButton disabled={["checking", "saving"].includes(control.attempt.phase)} onClick={() => void control.refresh()}>Refresh Mason session</NativeButton>
      {leave.dialog}
      <p className="mc-next-mason-footnote">
        <RefreshCw size={12} aria-hidden="true" />
        Mason sessions are global setup records with no atomic revision guard. Sending a message calls your configured model. Structured answers and Blueprint drafting do not call a model. Staging uses the selected Citadel structure revision.
      </p>
    </NativePageFrame>
  );
}
