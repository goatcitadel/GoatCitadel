import type { SessionMeta } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { sessionTitle } from "./sessions-page-model";
import { SystemOwnerLink } from "./SystemOwnerLink";
import { presentChannel, SESSION_BUDGET, SESSION_HEALTH, SESSION_KIND } from "./system-vocabulary";

export const sessionTime = (value?: string) =>
  value && Number.isFinite(Date.parse(value)) ? <TimeText value={value} /> : "Not reported";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A partial Gateway response can omit token counts: say so instead of throwing or inventing 0. */
function sessionUsage(item: SessionMeta): string {
  if (!finite(item.tokenTotal)) return "Not reported";
  const split =
    finite(item.tokenInput) && finite(item.tokenOutput)
      ? ` (${item.tokenInput.toLocaleString()} in, ${item.tokenOutput.toLocaleString()} out)`
      : "";
  return plural(item.tokenTotal, "token") + split;
}

/**
 * One session in the words System › Activity and System › Sessions share: channel, health and budget state, and a
 * native Chat link. Identifiers and usage stay in the details disclosure; `onDetails` lets a page open the session.
 */
export function SessionRow({ item, onDetails }: { item: SessionMeta; onDetails?: (sessionId: string) => void }) {
  const title = sessionTitle(item);
  return (
    <li className="space-y-1 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-semibold text-fg">{title}</h3>
        <StatusBadge status={SESSION_HEALTH[item.health] ?? { label: "Health unknown", tone: "neutral" }} />
      </div>
      <p className="text-fg-secondary">
        {presentChannel(item.channel)} · {SESSION_KIND[item.kind] ?? "Conversation"} · Last activity{" "}
        {sessionTime(item.lastActivityAt)}
      </p>
      <p className="text-fg-secondary">Budget: {SESSION_BUDGET[item.budgetState] ?? "not reported"}</p>
      <details>
        <summary className="min-h-11 cursor-pointer font-medium text-fg">Session details</summary>
        <ul className="space-y-1 break-words text-fg-secondary">
          <li>Account: {item.account || "Not reported"}</li>
          <li>Usage: {sessionUsage(item)}</li>
        </ul>
        <TechnicalDetails>
          Session ID: <code className="wrap-anywhere">{item.sessionId}</code>
        </TechnicalDetails>
      </details>
      <div className="flex flex-wrap items-center gap-3">
        <SystemOwnerLink href={`/chat?sessionId=${encodeURIComponent(item.sessionId)}`} scope={item.sessionId}>
          Open in Chat
        </SystemOwnerLink>
        {onDetails ? (
          // WCAG 2.5.3: the name starts with the visible "Details".
          <Button size="sm" aria-label={`Details: ${title}`} onClick={() => onDetails(item.sessionId)}>
            Details
          </Button>
        ) : null}
      </div>
    </li>
  );
}
