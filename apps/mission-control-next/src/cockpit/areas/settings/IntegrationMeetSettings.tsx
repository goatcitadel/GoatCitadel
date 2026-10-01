import { useState } from "react";
import type { IntegrationSettingsOwner } from "../../../features/native-routes/settings/sections/use-integration-settings";
import { MEET_OWNER_BOUNDARY } from "../../../features/native-routes/settings/sections/integration-meet-binding";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { integrationInputClass } from "./IntegrationFormFields";

export function IntegrationMeetSettings({ owner: s }: { owner: IntegrationSettingsOwner }) {
  const [limit, setLimit] = useState(10);
  const available = Boolean(s.data && !s.data.issues.some((item) => item.label === "Google Meet sessions"));
  const sessions = available ? (s.data?.meetSessions ?? []) : [];
  return (
    <section aria-label="Google Meet preparation" className="space-y-4 rounded-md border border-line-subtle p-3">
      <h4 className="font-display text-md font-semibold">Google Meet preparation</h4>
      <p className="text-sm text-fg-secondary">{MEET_OWNER_BOUNDARY}</p>
      <p className="text-xs text-fg-muted">
        Installation-wide records. Account references are configuration inputs; their presence does not verify a
        signed-in Google account.
      </p>
      {s.meetMutation.message ? (
        <p role="alert" className="text-sm text-status-waiting">
          {s.meetMutation.message}
        </p>
      ) : null}
      <fieldset disabled={s.meetMutation.locked} className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">Meeting preparation inputs</legend>
        <label className="block text-sm sm:col-span-2">
          Google Meet URL
          <input
            aria-label="Google Meet URL"
            type="url"
            className={integrationInputClass}
            value={s.meetForm.meetingUrl}
            onChange={(event) => s.setMeetForm({ ...s.meetForm, meetingUrl: event.target.value })}
          />
        </label>
        <label className="block text-sm">
          Meeting display name
          <input
            aria-label="Meeting display name"
            className={integrationInputClass}
            value={s.meetForm.displayName}
            onChange={(event) => s.setMeetForm({ ...s.meetForm, displayName: event.target.value })}
          />
        </label>
        <label className="block text-sm">
          Google account reference
          <input
            aria-label="Google account reference"
            className={integrationInputClass}
            value={s.meetForm.accountRef}
            onChange={(event) => s.setMeetForm({ ...s.meetForm, accountRef: event.target.value })}
          />
        </label>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button disabled={s.meetMutation.locked || !available || s.loading} onClick={s.handleStartGoogleMeetRealtime}>
          Review meeting preparation
        </Button>
        <Button disabled={s.meetMutation.pending || s.loading} onClick={() => void s.reload()}>
          Refresh meeting evidence
        </Button>
      </div>
      <details>
        <summary className="cursor-pointer text-sm">Gateway prerequisites without local microphone probe</summary>
        {s.data?.meetStatus ? (
          <ul className="mt-2 space-y-2 text-sm">
            {s.data.meetStatus.prerequisites.map((item) => (
              <li key={item.id}>
                {item.id}: {item.ready ? "Ready according to Gateway" : "Blocked"} · {item.message}
              </li>
            ))}
          </ul>
        ) : (
          <p role="status" className="mt-2 text-sm text-status-waiting">
            Prerequisite evidence is unavailable.
          </p>
        )}
      </details>
      {!available ? (
        <p role="status" className="text-sm text-status-waiting">
          Meeting records are unavailable.
        </p>
      ) : !sessions.length ? (
        <p className="text-sm text-fg-muted">No meeting records returned.</p>
      ) : (
        <ul className="space-y-3">
          {sessions.slice(0, limit).map((session) => (
            <li key={session.sessionId} className="rounded-md border border-line-subtle p-3">
              <h5 className="break-words text-sm font-semibold">{session.displayName || session.meetingUrl}</h5>
              <p className="text-sm text-fg-secondary">
                Recorded state: {session.state} · {session.transcript.length} transcript chunks
              </p>
              {session.failureReason ? (
                <p className="break-words text-sm text-status-waiting">{session.failureReason}</p>
              ) : null}
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer">Meeting record and handoff</summary>
                <p className="mt-2 break-all">
                  Record {session.sessionId} · Updated {session.updatedAt}
                </p>
                {session.consultHandoff ? (
                  <>
                    <p>Chat handoff: {session.consultHandoff.handoffId}</p>
                    <p className="whitespace-pre-wrap break-words">{session.consultHandoff.prompt}</p>
                    <p>
                      {session.consultHandoff.transcriptChunkIds.length} recorded transcript references; no automatic
                      Chat send.
                    </p>
                  </>
                ) : (
                  <p>No Chat handoff recorded.</p>
                )}
                {session.cleanup ? (
                  <p>
                    Gateway cleanup report: transport{" "}
                    {session.cleanup.stoppedTransport ? "marked stopped" : "not marked stopped"}, audio{" "}
                    {session.cleanup.releasedAudio ? "marked released" : "not marked released"}. External transport is
                    unverified.
                  </p>
                ) : null}
              </details>
              {["running", "consulting"].includes(session.state) ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button disabled={s.meetMutation.locked} onClick={() => s.handleConsultGoogleMeetSession(session)}>
                    Review Chat handoff
                  </Button>
                  <Button
                    variant="danger"
                    disabled={s.meetMutation.locked}
                    onClick={() => s.handleStopGoogleMeetSession(session)}
                  >
                    Review stop record
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {sessions.length > limit ? (
        <Button onClick={() => setLimit((value) => value + 10)}>Show more meeting records</Button>
      ) : null}
      <Dialog
        open={Boolean(s.meetReview)}
        title={s.meetReview?.title ?? "Review meeting action"}
        description={s.meetReview?.description}
        onOpenChange={(open) => {
          if (!open && !s.meetMutation.pending) s.cancelMeetReview();
        }}
      >
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="danger" disabled={s.meetMutation.locked} onClick={() => void s.confirmMeetReview()}>
            Apply reviewed meeting action
          </Button>
          <Button disabled={s.meetMutation.pending} onClick={s.cancelMeetReview}>
            Cancel meeting action
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
