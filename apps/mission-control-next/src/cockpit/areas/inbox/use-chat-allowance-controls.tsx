import { useId, useState } from "react";
import {
  chatToolGrantDurationsFor,
  isGoogleWorkspaceReadTool,
  type ChatToolGrantDuration,
} from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";

const DURATION_LABELS: Record<ChatToolGrantDuration, string> = {
  "15m": "15 minutes",
  "1h": "1 hour",
  "8h": "8 hours",
  "24h": "24 hours",
  "7d": "7 days",
};

export function useChatAllowanceControls(
  offerTemporaryGrant: boolean,
  pending: boolean,
  approve: (duration: ChatToolGrantDuration) => void,
  toolName: string,
) {
  const [grantDuration, setGrantDuration] = useState<ChatToolGrantDuration>();
  const grantPanelId = useId();
  const googleRead = isGoogleWorkspaceReadTool(toolName);
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
        {googleRead ? "Approve for a duration" : "Allow this tool in this Chat"}
      </Button>
    ) : null,
    panel:
      offerTemporaryGrant && grantDuration ? (
        <section id={grantPanelId} aria-label="Temporary tool allowance" className="space-y-2">
          <p className="text-xs text-fg-muted">
            {googleRead
              ? "Approve this request and allow future reads from the same Google sign-in in this Chat until the allowance expires."
              : "Approve this request and allow future calls to this tool in this Chat until the allowance expires."}{" "}
            Policy and required safety checks still apply.
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
                {chatToolGrantDurationsFor(toolName).map((duration) => (
                  <option key={duration} value={duration}>
                    {DURATION_LABELS[duration]}
                  </option>
                ))}
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
