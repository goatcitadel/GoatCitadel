import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from "@goatcitadel/mission-control-shared/components/ui";

type PanelState = NonNullable<MissionThreadedActiveSessionSurfaceProps["chatTimerPanel"]>;

export function ChatTimerPanel({ panel }: { panel: PanelState }) {
  return (
    <Dialog open={panel.open} onOpenChange={(open) => !open && panel.onClose()}>
      <DialogContent className="mc-next-chat-timer" aria-describedby="chat-timer-description">
        <DialogHeader>
          <DialogTitle>Set a Chat timer</DialogTitle>
          <DialogDescription id="chat-timer-description">
            This durable reminder appends a system notice and never invokes a provider or model.
          </DialogDescription>
        </DialogHeader>

        <div className="mc-next-chat-timer__form">
          <label>
            <span>Due date and time</span>
            <input
              type="datetime-local"
              value={panel.dueAt}
              onChange={(event) => panel.onDueAtChange(event.currentTarget.value)}
              required
            />
          </label>
          <label>
            <span>Timezone</span>
            <input
              type="text"
              value={panel.timezone}
              onChange={(event) => panel.onTimezoneChange(event.currentTarget.value)}
              placeholder="America/Los_Angeles"
              required
            />
          </label>
          <label className="mc-next-chat-timer__wide">
            <span>Reminder message</span>
            <Textarea
              value={panel.message}
              onChange={(event) => panel.onMessageChange(event.currentTarget.value)}
              placeholder="What should Chat remind you about?"
              maxLength={4000}
              required
            />
          </label>
          <label className="mc-next-chat-timer__wide">
            <span>Notification rule</span>
            <select
              value={panel.notificationRuleId}
              onChange={(event) => panel.onNotificationRuleChange(event.currentTarget.value)}
            >
              <option value="">All matching timer rules</option>
              {panel.rules.map((rule) => (
                <option key={rule.ruleId} value={rule.ruleId}>
                  {rule.label}
                </option>
              ))}
            </select>
          </label>
          <label className="mc-next-chat-timer__check mc-next-chat-timer__wide">
            <input
              type="checkbox"
              checked={panel.cancelOnNextReply}
              onChange={(event) => panel.onCancelOnNextReplyChange(event.currentTarget.checked)}
            />
            <span>Cancel only after my next message commits successfully</span>
          </label>
        </div>

        {panel.error ? <p role="alert">{panel.error}</p> : null}
        {panel.timers.length > 0 ? (
          <section className="mc-next-chat-timer__list" aria-label="Session timers">
            <h3>Session timers</h3>
            {panel.timers.map((timer) => (
              <article key={timer.timerId}>
                <div>
                  <strong>{timer.message}</strong>
                  <span>
                    {timer.status} · {new Date(timer.dueAt).toLocaleString()} · {timer.timezone}
                  </span>
                </div>
                {timer.status === "active" ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={panel.busy}
                    onClick={() => panel.onCancelTimer(timer.timerId, timer.revision)}
                  >
                    Cancel
                  </Button>
                ) : null}
              </article>
            ))}
          </section>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={panel.onClose} disabled={panel.busy}>
            Close
          </Button>
          <Button
            type="button"
            onClick={panel.onCreate}
            disabled={panel.busy || !panel.dueAt || !panel.timezone.trim() || !panel.message.trim()}
          >
            {panel.busy ? "Creating…" : "Create timer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
