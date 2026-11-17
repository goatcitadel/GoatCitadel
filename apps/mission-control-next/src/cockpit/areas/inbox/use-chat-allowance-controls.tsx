import { useId, useState } from "react";
import type { ChatToolGrantDuration } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";

export function useChatAllowanceControls(
  offerTemporaryGrant: boolean,
  pending: boolean,
  approve: (duration: ChatToolGrantDuration) => void,
) {
  const [grantDuration, setGrantDuration] = useState<ChatToolGrantDuration>();
  const grantPanelId = useId();
  return {
    trigger: offerTemporaryGrant ? (
      <Button
        type="button"
        size="sm"
        disabled={pending}
        aria-expanded={Boolean(grantDuration)}
        aria-controls={grantPanelId}
        onClick={() => setGrantDuration(grantDuration ? undefined : "15m")}
      >
        Allow this tool in this Chat
      </Button>
    ) : null,
    panel:
      offerTemporaryGrant && grantDuration ? (
        <section id={grantPanelId} aria-label="Temporary tool allowance" className="space-y-2">
          <p className="text-xs text-fg-muted">
            Approve this request and allow future calls to this tool in this Chat until the allowance expires. Policy
            and required safety checks still apply.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-fg-secondary">
              For how long
              <select
                className="ml-2 rounded-md border border-line bg-raised p-1 text-fg"
                value={grantDuration}
                disabled={pending}
                onChange={(event) => setGrantDuration(event.target.value as ChatToolGrantDuration)}
              >
                <option value="15m">15 minutes</option>
                <option value="1h">1 hour</option>
                <option value="8h">8 hours</option>
              </select>
            </label>
            <Button type="button" size="sm" disabled={pending} onClick={() => approve(grantDuration)}>
              Approve and allow
            </Button>
          </div>
        </section>
      ) : null,
  };
}
