import { useState } from "react";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { useNotificationRouting } from "../../../features/native-routes/settings/sections/use-notification-routing";
import { useDraftLeaveDialogState } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { NotificationRoutingFields } from "./NotificationRoutingFields";

export function NotificationRoutingSettings({
  workspaceId,
  channels,
}: {
  workspaceId: string;
  channels: IntegrationConnection[];
}) {
  const s = useNotificationRouting(workspaceId, channels),
    leave = useDraftLeaveDialogState(s.leave.dialogProps);
  const [limit, setLimit] = useState(20);
  return (
    <section aria-label="Notification routing" className="min-w-0 space-y-4 rounded-md border border-line p-4">
      <header>
        <h3 className="font-display text-md font-semibold">Notification routing</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Workspace-owned destinations and rules. Test sends contact the selected destination only after explicit
          review. Normal rules may send matching future events.
        </p>
      </header>
      {s.loading ? (
        <p role="status" className="text-sm">
          Loading notification routing…
        </p>
      ) : null}
      {s.loadError ? (
        <p role="alert" className="text-sm text-status-failed">
          Notification routing unavailable: {s.loadError}
        </p>
      ) : null}
      {s.notice ? (
        <p role="status" className="break-words text-sm">
          {s.notice.message}
        </p>
      ) : null}
      {s.attempt.phase === "uncertain" ? (
        <p role="alert" className="text-sm text-status-waiting">
          {s.attempt.message}
        </p>
      ) : null}
      {s.editor ? (
        <>
          <NotificationRoutingFields owner={s} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={s.attempt.locked || s.loading || Boolean(s.loadError)}
              onClick={() => void (s.editor === "target" ? s.handleCreateTarget() : s.handleCreateRule())}
            >
              Review notification {s.editor === "target" ? "destination" : "rule"}
            </Button>
            <Button
              disabled={s.attempt.pending}
              onClick={() => s.leave.request(() => s.setEditor(null), [s.targetDraft.key, s.ruleDraft.key])}
            >
              Close notification editor
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={s.attempt.locked || s.loading || Boolean(s.loadError)}
              onClick={() => s.setEditor("target")}
            >
              New destination{s.targetDraft.isDirty ? " · Unsaved" : ""}
            </Button>
            <Button
              disabled={s.attempt.locked || s.loading || Boolean(s.loadError)}
              onClick={() => s.setEditor("rule")}
            >
              New rule{s.ruleDraft.isDirty ? " · Unsaved" : ""}
            </Button>
            <Button disabled={s.loading || s.attempt.pending} onClick={() => void s.reload()}>
              Refresh notification routing
            </Button>
          </div>
          <section aria-label="Notification destinations" className="space-y-2">
            <h4 className="font-semibold">Destinations</h4>
            {s.targets.slice(0, limit).map((target) => (
              <details className="rounded-md border border-line-subtle p-3" key={target.targetId}>
                <summary className="cursor-pointer break-words text-sm">
                  {target.label} · {target.lifecycleState}
                </summary>
                <p className="my-2 break-words text-sm text-fg-secondary">
                  {target.kind.replaceAll("_", " ")} · revision {target.revision}
                </p>
                <p className="break-all text-xs text-fg-muted">
                  {target.channelConnectionId ?? target.webhookUrlSecretRef}
                </p>
                {s.testDelivery(target.targetId) ? (
                  <p role="status" className="my-2 text-sm">
                    Latest test for {target.label}: {s.testDelivery(target.targetId)!.status.replaceAll("_", " ")}.{" "}
                    {s.testPending(target.targetId)
                      ? "Refresh evidence before another send."
                      : "Confirmed by the Gateway."}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    disabled={s.attempt.locked || s.testPending(target.targetId) || target.lifecycleState !== "active"}
                    onClick={() => s.handleTest(target)}
                  >
                    Review test for {target.label}
                  </Button>
                  <Button
                    disabled={s.attempt.locked || target.lifecycleState !== "active"}
                    onClick={() => s.handleTargetState(target, "disabled")}
                  >
                    Disable {target.label}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={s.attempt.locked || target.lifecycleState === "archived"}
                    onClick={() => s.handleTargetState(target, "archived")}
                  >
                    Archive destination {target.label}
                  </Button>
                </div>
              </details>
            ))}
            {!s.loading && !s.loadError && !s.targets.length ? (
              <p className="text-sm text-fg-muted">No notification destinations configured.</p>
            ) : null}
          </section>
          <section aria-label="Notification rules" className="space-y-2">
            <h4 className="font-semibold">Rules</h4>
            {s.rules.slice(0, limit).map((rule) => (
              <details className="rounded-md border border-line-subtle p-3" key={rule.ruleId}>
                <summary className="cursor-pointer break-words text-sm">
                  {rule.label} · {rule.lifecycleState}
                </summary>
                <p className="my-2 text-sm">
                  {rule.deliveryPolicy.replaceAll("_", " ")} · revision {rule.revision}
                </p>
                <p className="break-words text-sm text-fg-secondary">{rule.eventTypes.join(", ")}</p>
                <p className="my-2 break-words text-sm">
                  Destinations:{" "}
                  {rule.targetIds
                    .map(
                      (id) =>
                        s.targets.find((target) => target.targetId === id)?.label ?? `Unavailable destination ${id}`,
                    )
                    .join(", ")}
                </p>
                <Button
                  variant="danger"
                  disabled={s.attempt.locked || rule.lifecycleState === "archived"}
                  onClick={() => s.handleArchiveRule(rule)}
                >
                  Archive rule {rule.label}
                </Button>
              </details>
            ))}
            {!s.loading && !s.loadError && !s.rules.length ? (
              <p className="text-sm text-fg-muted">No notification rules configured.</p>
            ) : null}
          </section>
          {Math.max(s.targets.length, s.rules.length) > limit ? (
            <Button onClick={() => setLimit((value) => value + 20)}>Show more routing records</Button>
          ) : null}
          <details>
            <summary className="cursor-pointer text-sm">Recent delivery evidence</summary>
            <p className="my-2 text-xs text-fg-muted">
              Latest {s.deliveries.length} returned records; this is a bounded history window.
            </p>
            <ul className="space-y-3">
              {s.deliveries.map((delivery) => (
                <li className="break-words text-sm" key={delivery.deliveryId}>
                  <strong>{delivery.status.replaceAll("_", " ")}</strong>
                  <p>
                    Destination:{" "}
                    {s.targets.find((item) => item.targetId === delivery.targetId)?.label ?? delivery.targetId} ·
                    attempt {delivery.attemptCount}
                  </p>
                  <p className="text-xs text-fg-muted">{delivery.updatedAt}</p>
                  {delivery.lastError ? <p>{delivery.lastError}</p> : null}
                </li>
              ))}
            </ul>
            {!s.loading && !s.loadError && !s.deliveries.length ? (
              <p className="text-sm">No delivery records returned.</p>
            ) : null}
          </details>
        </>
      )}
      <Dialog
        open={Boolean(s.review)}
        title={s.review?.title ?? "Review notification action"}
        description={s.review?.message}
        onOpenChange={(open) => {
          if (!open && !s.attempt.pending) s.cancelReview();
        }}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant={s.review?.kind === "test" ? "danger" : "primary"}
            disabled={s.attempt.locked}
            onClick={() => void s.confirmReview()}
          >
            Apply reviewed notification action
          </Button>
          <Button disabled={s.attempt.pending} onClick={s.cancelReview}>
            Cancel notification action
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={s.leave.dialogProps.open}
        title="Unsaved notification draft"
        description={leave.description}
        onOpenChange={(open) => {
          if (!open) s.leave.dialogProps.onCancel();
        }}
      >
        <div className="flex flex-wrap gap-2">
          {leave.canKeep ? <Button onClick={s.leave.dialogProps.onContinue}>Keep draft and close</Button> : null}
          <Button variant="danger" onClick={leave.discard}>
            Discard draft
          </Button>
          <Button onClick={s.leave.dialogProps.onCancel}>Keep editing</Button>
        </div>
      </Dialog>
    </section>
  );
}
