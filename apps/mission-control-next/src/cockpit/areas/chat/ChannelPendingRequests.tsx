import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import type { PendingRequest } from "./channel-page-model";
import type { PairingDecision } from "./use-pairing-decision";

/**
 * People who messaged the bot and are waiting: each by name with Approve and Deny. Deny is a plain secondary button
 * (denying one request can be undone by the person asking again); ids and pairing codes stay in Technical details.
 */
export function PendingRequests({
  requests,
  busy,
  locked,
  onDecide,
}: {
  requests: readonly PendingRequest[];
  busy: { key: string; decision: PairingDecision } | null;
  locked: boolean;
  onDecide: (request: PendingRequest, decision: PairingDecision) => void;
}) {
  if (!requests.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-fg">Asking to message it</h3>
      <ul aria-label="People asking to message it" className="divide-y divide-line-subtle">
        {requests.map((request) => {
          const running = (decision: PairingDecision) => busy?.key === request.key && busy.decision === decision;
          return (
            <li key={request.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0 break-words text-base text-fg">{request.label}</span>
              <span className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  aria-label={`Approve: ${request.label}`}
                  disabled={locked || (request.kind === "telegram" && !request.code)}
                  loading={running("approve")}
                  onClick={() => onDecide(request, "approve")}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  aria-label={`Deny: ${request.label}`}
                  disabled={locked}
                  loading={running("deny")}
                  onClick={() => onDecide(request, "deny")}
                >
                  Deny
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
      <TechnicalDetails label="Request details">
        <ul>
          {requests.map((request) => (
            <li key={request.key}>
              {request.label} · {request.kind === "telegram" ? request.actorId : request.userId}
              {request.kind === "telegram" && request.code ? ` · code ${request.code}` : ""}
            </li>
          ))}
        </ul>
      </TechnicalDetails>
    </div>
  );
}
