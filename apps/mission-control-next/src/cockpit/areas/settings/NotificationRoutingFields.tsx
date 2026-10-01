import { NOTIFICATION_EVENT_TYPES, type NotificationTargetKind } from "@goatcitadel/contracts";
import type { NotificationRoutingOwner } from "../../../features/native-routes/settings/sections/use-notification-routing";
import { integrationInputClass } from "./IntegrationFormFields";

export function NotificationRoutingFields({ owner: s }: { owner: NotificationRoutingOwner }) {
  return (
    <fieldset disabled={s.attempt.locked} className="space-y-3">
      <legend className="font-semibold">
        {s.editor === "target" ? "New notification destination" : "New notification rule"}
      </legend>
      {s.editor === "target" ? (
        <>
          <label className="block text-sm">
            Destination label
            <input
              aria-label="Destination label"
              className={integrationInputClass}
              value={s.targetForm.label}
              onChange={(event) => s.setTargetForm((value) => ({ ...value, label: event.target.value }))}
            />
          </label>
          <label className="block text-sm">
            Destination kind
            <select
              aria-label="Destination kind"
              className={integrationInputClass}
              value={s.targetForm.kind}
              onChange={(event) =>
                s.setTargetForm((value) => ({ ...value, kind: event.target.value as NotificationTargetKind }))
              }
            >
              <option value="channel_connection">Configured channel</option>
              <option value="https_webhook">Keychain HTTPS webhook</option>
            </select>
          </label>
          {s.targetForm.kind === "channel_connection" ? (
            <label className="block text-sm">
              Notification channel
              <select
                aria-label="Notification channel"
                className={integrationInputClass}
                value={s.targetForm.channelConnectionId}
                onChange={(event) =>
                  s.setTargetForm((value) => ({ ...value, channelConnectionId: event.target.value }))
                }
              >
                <option value="">Choose an enabled channel</option>
                {s.channels.map((item) => (
                  <option key={item.connectionId} value={item.connectionId}>
                    {item.label} · {item.status}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <p className="text-sm text-fg-secondary">
                Use existing keychain references. Endpoint URLs and credential values are never entered or stored in
                this form.
              </p>
              <label className="block text-sm">
                Webhook URL secret reference
                <input
                  aria-label="Webhook URL secret reference"
                  className={integrationInputClass}
                  value={s.targetForm.webhookUrlSecretRef}
                  onChange={(event) =>
                    s.setTargetForm((value) => ({ ...value, webhookUrlSecretRef: event.target.value }))
                  }
                />
              </label>
              <label className="block text-sm">
                Credential secret reference (optional)
                <input
                  aria-label="Credential secret reference (optional)"
                  className={integrationInputClass}
                  value={s.targetForm.credentialSecretRef}
                  onChange={(event) =>
                    s.setTargetForm((value) => ({ ...value, credentialSecretRef: event.target.value }))
                  }
                />
              </label>
            </>
          )}
        </>
      ) : (
        <>
          <label className="block text-sm">
            Rule label
            <input
              aria-label="Notification rule label"
              className={integrationInputClass}
              value={s.ruleForm.label}
              onChange={(event) => s.setRuleForm((value) => ({ ...value, label: event.target.value }))}
            />
          </label>
          <label className="block text-sm">
            Delivery policy
            <select
              aria-label="Notification delivery policy"
              className={integrationInputClass}
              value={s.ruleForm.deliveryPolicy}
              onChange={(event) =>
                s.setRuleForm((value) => ({ ...value, deliveryPolicy: event.target.value as "always" | "when_away" }))
              }
            >
              <option value="when_away">Only when away</option>
              <option value="always">Always</option>
            </select>
          </label>
          <fieldset className="space-y-2">
            <legend>Events</legend>
            {NOTIFICATION_EVENT_TYPES.map((type) => (
              <label className="flex gap-2 break-all text-sm" key={type}>
                <input
                  type="checkbox"
                  checked={s.ruleForm.eventTypes.includes(type)}
                  onChange={() => s.toggleEventType(type)}
                />
                {type}
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-2">
            <legend>Active destinations</legend>
            {s.activeTargets.map((target) => (
              <label className="flex gap-2 break-words text-sm" key={target.targetId}>
                <input
                  type="checkbox"
                  checked={s.ruleForm.targetIds.includes(target.targetId)}
                  onChange={() => s.toggleTarget(target.targetId)}
                />
                {target.label}
              </label>
            ))}
            {!s.activeTargets.length ? (
              <p className="text-sm text-fg-muted">Create an active destination before creating a rule.</p>
            ) : null}
          </fieldset>
        </>
      )}
    </fieldset>
  );
}
