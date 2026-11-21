import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { describeChatTimerStatus } from "@goatcitadel/contracts";
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
import "./styles/chat-timer.css";

type PanelState = NonNullable<MissionThreadedActiveSessionSurfaceProps["chatTimerPanel"]>;

export function ChatTimerPanel({ panel }: { panel: PanelState }) {
  return (
    <Dialog open={panel.open} onOpenChange={(open) => !open && panel.onClose()}>
      <DialogContent className="mc-next-chat-timer" aria-describedby="chat-timer-description">
        <DialogHeader>
          <DialogTitle>Set a Chat timer</DialogTitle>
          <DialogDescription id="chat-timer-description">
            {panel.delayMs
              ? "The countdown starts when you confirm. Choose where to receive the reminder."
              : "The reminder appears in this Chat. Choose a notification rule to control delivery elsewhere."}
          </DialogDescription>
        </DialogHeader>

        <div className="mc-next-chat-timer__form">
          {panel.delayMs ? (
            <p className="mc-next-chat-timer__wide">
              <strong>Duration</strong> · {formatTimerDelay(panel.delayMs)}
            </p>
          ) : (
            <label>
              <span>Due date and time</span>
              <input
                type="datetime-local"
                value={panel.dueAt}
                onChange={(event) => panel.onDueAtChange(event.currentTarget.value)}
                required
              />
            </label>
          )}
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
            <span>Destination</span>
            <select
              value={panel.notificationRuleId}
              onChange={(event) => panel.onNotificationRuleChange(event.currentTarget.value)}
            >
              <option value="">This Chat</option>
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
                    {describeChatTimerStatus(timer)} ·{" "}
                    {new Date(timer.dueAt).toLocaleString(undefined, { timeZone: timer.timezone })} · {timer.timezone}
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
            {panel.busy ? "Saving…" : "Create timer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatTimerDelay(delayMs: number): string {
  const [amount, unit] =
    delayMs % 3_600_000 === 0
      ? [delayMs / 3_600_000, "hour"]
      : delayMs % 60_000 === 0
        ? [delayMs / 60_000, "minute"]
        : [delayMs / 1_000, "second"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}
