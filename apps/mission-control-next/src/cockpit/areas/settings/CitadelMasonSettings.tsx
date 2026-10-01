import { useId, useState } from "react";
import { useMasonEditor } from "../../../features/native-routes/library/use-mason-editor";
import { useMasonStaging } from "../../../features/native-routes/library/use-mason-staging";
import { MasonAnswerFields } from "../../../features/native-routes/library/MasonAnswerFields";
import { useDraftLeaveDialogState } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

export function CitadelMasonSettings({ citadelId }: { citadelId: string }) {
  const control = useMasonEditor(citadelId),
    messageId = useId();
  const stage = useMasonStaging(citadelId, control.review, control.identity);
  const [answerReview, setAnswerReview] = useState<string | null>(null);
  const leave = useDraftLeaveDialogState(control.leave.dialogProps);
  const hasAnswerReview = answerReview === control.identity;
  function closeAnswerReview() {
    // Dismissal during the fresh read cancels that admission, including Escape/X.
    control.invalidateReview();
    setAnswerReview(null);
  }
  return (
    <section id="citadel-mason" aria-label="Citadel Mason" className="space-y-4">
      <header>
        <h3 className="font-display text-md font-semibold text-fg">Mason setup</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Collect the purpose, priorities and boundaries, then review a Blueprint before staging its Charter and
          Chambers.
        </p>
        <p className="mt-1 text-xs text-fg-muted">
          Mason sessions are global setup records. This editor associates a session with your selected Citadel in this
          app only. Session writes have no atomic revision guard; staging uses the Citadel structure revision.
        </p>
      </header>
      {control.loading ? <p role="status">Loading Mason session…</p> : null}
      {control.error ? (
        <p role="alert" className="text-sm text-status-failed">
          {control.error}
        </p>
      ) : null}
      {control.attempt.message ? (
        <p role={control.attempt.phase === "uncertain" ? "alert" : "status"} className="text-sm text-status-waiting">
          {control.attempt.message}
        </p>
      ) : null}
      {!control.session ? (
        <Button disabled={control.locked || !citadelId || control.loading} onClick={() => void control.startSession()}>
          Start setup
        </Button>
      ) : (
        <>
          <details className="text-sm text-fg-secondary">
            <summary>Session details</summary>
            <dl className="mt-2 space-y-1">
              <dt>Session ID</dt>
              <dd className="break-all font-mono text-xs">{control.session.sessionId}</dd>
              <dt>Captured status</dt>
              <dd>{control.session.status}</dd>
              <dt>Selected Citadel</dt>
              <dd className="break-all font-mono text-xs">{citadelId}</dd>
            </dl>
          </details>
          <MasonAnswerFields
            value={control.answersDraft.value}
            disabled={control.locked}
            onChange={control.changeAnswer}
          />
          {control.answersDraft.isDirty ? <p className="text-xs text-fg-muted">Unsaved structured answers</p> : null}
          {control.cannotClearName ? <p role="alert" className="text-sm text-status-waiting">A captured Blueprint name cannot be cleared. Enter its new name.</p> : null}
          {control.answersDraft.hasRemoteChanges ? (
            <p role="alert" className="text-sm text-status-waiting">
              Saved answers changed. Your draft is preserved. Compare the captured answers before discarding or revising
              it.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                control.locked ||
                !control.answersDraft.isDirty ||
                control.answersDraft.hasRemoteChanges ||
                control.cannotClearName ||
                control.messageDraft.isDirty ||
                !control.answersDraft.value.kind ||
                !control.answersDraft.value.purpose?.trim()
              }
              onClick={() => setAnswerReview(control.identity)}
            >
              Review answers
            </Button>
            <Button disabled={control.locked || !control.answersDraft.isDirty} onClick={control.answersDraft.discard}>
              Discard answer changes
            </Button>
          </div>
          <details className="rounded-md border border-line-subtle p-3 text-sm text-fg-secondary">
            <summary>Ask the configured model to interpret an answer</summary>
            <p className="mt-2">
              This sends your message and captured answers to the configured model. Do not include secrets. Structured
              answers above do not call a model.
            </p>
            <p className="mt-2">{control.questions[control.questionIndex]}</p>
            <label htmlFor={messageId} className="mt-3 block">
              Message the Mason
            </label>
            <textarea
              id={messageId}
              rows={3}
              disabled={control.locked}
              value={control.messageDraft.value}
              onChange={(event) => control.changeMessage(event.target.value)}
              className="mt-1 block w-full rounded-md border border-line bg-canvas px-3 py-2 text-sm text-fg"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                disabled={control.locked || !control.messageDraft.value.trim() || control.answersDraft.isDirty}
                onClick={() => void control.sendMessage()}
              >
                Send to the Mason
              </Button>
              <Button
                disabled={control.questionIndex <= 0 || control.locked}
                onClick={() => control.changeQuestion(control.questionIndex - 1)}
              >
                Previous question
              </Button>
              <Button
                disabled={control.questionIndex >= control.questions.length - 1 || control.locked}
                onClick={() => control.changeQuestion(control.questionIndex + 1)}
              >
                Next question
              </Button>
            </div>
          </details>
          <Button disabled={control.locked || !control.canDraft} onClick={() => void control.draftAndReview()}>
            Draft &amp; review Blueprint
          </Button>
        </>
      )}
      <Button
        size="sm"
        disabled={["checking", "saving"].includes(control.attempt.phase)}
        onClick={() => void control.refresh()}
      >
        Refresh Mason session
      </Button>
      {control.review ? (
        <div className="space-y-3 rounded-md border border-line bg-sunken p-3" aria-label="Drafted Blueprint">
          <h4 className="text-sm font-semibold text-fg">{control.review.summary.name}</h4>
          <p className="text-sm text-fg-secondary">{control.review.blueprint.charter.purpose}</p>
          <p className="text-sm text-fg-secondary">Risk posture: {control.review.blueprint.charter.riskPosture}. Model policy: {control.review.blueprint.charter.modelPolicyDefault}.</p>
          <dl className="space-y-2 text-sm text-fg-secondary">{(["goals", "boundaries", "successDefinition"] as const).map(key => <div key={key}><dt>{key}</dt><dd className="break-words">{control.review?.blueprint.charter[key].join("; ") || "None specified"}</dd></div>)}</dl>
          <ul className="space-y-1 text-sm text-fg-secondary" aria-label="Reviewed Chambers">{control.review.blueprint.chambers.map((chamber, index) => <li key={index}>{chamber.name} · {chamber.sensitivity} · {chamber.sealed ? "Sealed" : "Not sealed"}</li>)}</ul>
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg-secondary">
            {control.review.summary.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
          <Button disabled={stage.locked || stage.checking || control.locked} onClick={() => void stage.prepare()}>
            Review staging
          </Button>
        </div>
      ) : null}
      {stage.notice ? (
        <p role="status" className="text-sm text-fg-secondary">
          {stage.notice}
        </p>
      ) : null}
      {stage.attempt.message ? (
        <p role={stage.attempt.phase === "uncertain" ? "alert" : "status"} className="text-sm text-status-waiting">
          {stage.attempt.message}
        </p>
      ) : null}
      <Dialog
        open={hasAnswerReview}
        onOpenChange={(open) => {
          if (!open) closeAnswerReview();
        }}
        title="Save these Mason answers?"
        description="Save structured setup answers to this global Mason session. This does not stage the Citadel or call a model."
      >
        <p className="break-words text-sm text-fg-secondary">{control.answersDraft.value.purpose}</p>
        <dl className="mt-3 space-y-2 text-sm text-fg-secondary">
          {Object.entries(control.answerPatch).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd className="break-words">{Array.isArray(value) ? value.join("; ") : String(value)}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            disabled={control.locked}
            onClick={() =>
              void control.saveAnswers().then((saved) => {
                if (saved) setAnswerReview(null);
              })
            }
          >
            Save reviewed answers
          </Button>
          <Button disabled={control.attempt.phase === "saving"} onClick={closeAnswerReview}>
            Cancel
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={Boolean(stage.review)}
        onOpenChange={(open) => {
          if (!open) stage.cancel();
        }}
        title="Stage this Blueprint?"
        description="Replace the Charter and add the reviewed Chambers. Existing Chambers are retained and the default Chamber is cleared. Staging does not connect accounts or open Gates."
      >
        <dl className="space-y-2 text-sm text-fg-secondary">
          <dt>Citadel</dt>
          <dd>{stage.review?.target.record?.name}</dd>
          <dt>Current purpose</dt>
          <dd className="break-words">{stage.review?.target.charter?.purpose ?? "No Charter yet"}</dd>
          <dt>Reviewed purpose</dt>
          <dd className="break-words">{stage.review?.candidate.blueprint.charter.purpose}</dd>
          <dt>Chambers to add</dt>
          <dd>{stage.review?.candidate.blueprint.chambers.length}</dd>
        </dl>
        <details className="mt-3 text-xs text-fg-muted">
          <summary>Revision evidence</summary>
          <p className="break-all font-mono">{stage.review?.target.revision}</p>
        </details>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="danger" disabled={stage.locked} onClick={() => void stage.confirm()}>
            Stage reviewed Blueprint
          </Button>
          <Button disabled={stage.attempt.phase === "saving"} onClick={stage.cancel}>
            Cancel
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={control.leave.dialogProps.open}
        onOpenChange={(open) => {
          if (!open) control.leave.dialogProps.onCancel();
        }}
        title="Unsaved Mason answers"
        description={leave.description}
      >
        <div className="flex flex-wrap gap-2">
          {leave.canKeep ? <Button onClick={control.leave.dialogProps.onContinue}>Keep draft</Button> : null}
          <Button variant="danger" onClick={leave.discard}>
            Discard changes
          </Button>
          <Button onClick={control.leave.dialogProps.onCancel}>Cancel</Button>
        </div>
      </Dialog>
    </section>
  );
}
