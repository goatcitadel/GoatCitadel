import {
  HOSTS_UNKNOWN,
  inboxApprovalHref,
  inboxPlanHref,
} from "../../../../features/native-routes/settings/channel-hosts";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import type { TurnOnState } from "./use-turn-on";

export const TURNED_ON = "Telegram is on. Send your bot a message to try it.";
export const CLEANUP_NOTE = "GoatCitadel couldn't remove its test message. Delete it in Telegram if you like.";
/** The one thing every turn-on does that the operator can see in their chat. */
export const TEST_MESSAGE_CHANGE = "GoatCitadel sends a test message to your chat and then removes it";

/** The line for a host that is not yet allowed and will be added when the change is made. */
export const hostChange = (host: string) => `${host} is added to the hosts GoatCitadel may reach`;
/** Where a change that waits on a form or a secret is finished: its review in Chat. */
const FINISH_IN_CHAT = "Finish it in Chat";

/** The words of the step's button and its ending, so a page that applies a different change can say its own. */
export interface TurnOnWording {
  button: string;
  /** The button while the change is being made. */
  working: string;
  /** What the step says once the change is made. */
  done: string;
  /** The link beside it, to the channel's page. */
  doneLink: string;
  /** What the step says when the test message could not be removed, naming where to delete it. */
  cleanup: string;
}

/** Turning a new channel on. */
export const TURN_ON_WORDING: TurnOnWording = {
  button: "Turn on",
  working: "Turning on…",
  done: TURNED_ON,
  doneLink: "Open Telegram's page",
  cleanup: CLEANUP_NOTE,
};

/**
 * What turning on will do, as plain lines. A host appears only when it is not yet allowed; until the settings have
 * been read the caller passes none, because the page cannot say what it has not seen, and keeps the button off.
 */
export function turnOnChanges({
  senderName,
  botUsername,
  missingHosts,
}: {
  senderName: string;
  botUsername: string;
  missingHosts: readonly string[];
}): string[] {
  return [
    `Who can message your bot: ${senderName}`,
    `Where it posts: your chat with @${botUsername.replace(/^@/u, "")}`,
    "How it gets messages: GoatCitadel asks Telegram for new ones, so no public web address is needed",
    TEST_MESSAGE_CHANGE,
    ...missingHosts.map(hostChange),
  ];
}

/** What the step says to a screen reader about where the last click left things, or nothing before any click. */
export function turnOnStatus(turnOn: TurnOnState, wording: TurnOnWording = TURN_ON_WORDING): string | undefined {
  switch (turnOn.state) {
    case "working":
      return wording.working;
    case "done":
      return wording.done;
    case "cleanup":
      return wording.cleanup;
    case "failed":
      return turnOn.message;
    case "blocked":
      return turnOn.reasons.join(" ");
    case "elsewhere":
      if (turnOn.approvalId) return "Approve it in Inbox";
      return turnOn.reviewPlanId ? "Review it in Inbox" : FINISH_IN_CHAT;
    default:
      return undefined;
  }
}

/** Where the last click left things, when it did not finish: the reasons, the failure, or where to go next. */
function Outcome({
  turnOn,
  workspaceId,
  wording,
}: {
  turnOn: TurnOnState;
  workspaceId: string;
  wording: TurnOnWording;
}) {
  switch (turnOn.state) {
    case "cleanup":
      return (
        <Callout tone="warning" announce={false}>
          <p>{wording.cleanup}</p>
          <div className="mt-2">
            <Button size="sm" onClick={() => void turnOn.acknowledgeCleanup()}>
              Continue
            </Button>
          </div>
        </Callout>
      );
    case "blocked":
      return (
        <Callout tone="warning" announce={false}>
          {turnOn.reasons.map((reason, index) => (
            <p key={`${index}:${reason}`}>{reason}</p>
          ))}
        </Callout>
      );
    case "failed":
      return (
        <Callout tone="error" announce={false}>
          <p>{turnOn.message}</p>
        </Callout>
      );
    case "elsewhere":
      return (
        <Callout tone="info" announce={false}>
          {turnOn.approvalId ? (
            <NativeOwnerLink
              href={inboxApprovalHref(turnOn.approvalId, workspaceId)}
              scope={[workspaceId, turnOn.approvalId]}
            >
              Approve it in Inbox
            </NativeOwnerLink>
          ) : turnOn.reviewPlanId ? (
            <NativeOwnerLink
              href={inboxPlanHref(turnOn.reviewPlanId, workspaceId)}
              scope={[workspaceId, turnOn.reviewPlanId]}
            >
              Review it in Inbox
            </NativeOwnerLink>
          ) : turnOn.finishHref ? (
            <NativeOwnerLink href={turnOn.finishHref} scope={workspaceId}>
              {FINISH_IN_CHAT}
            </NativeOwnerLink>
          ) : null}
        </Callout>
      );
    default:
      return null;
  }
}

/**
 * The last step: what turning on will change, a Turn on button, and where it ended up. It adds no live region of its
 * own; the page's one status line says what happened. While a test message waits to be called fine, Continue is the
 * only way on, because turning on again would send another.
 */
export function TurnOnStep({
  changes,
  turnOn,
  onTurnOn,
  doneHref,
  disabled,
  workspaceId,
  wording = TURN_ON_WORDING,
  retryHostCheck,
}: {
  changes: readonly string[];
  turnOn: TurnOnState;
  onTurnOn(): void;
  /** The channel's page, once the change is made and it could be found. */
  doneHref?: string;
  disabled?: boolean;
  workspaceId: string;
  /** The button and the ending; turning a new channel on unless the page says otherwise. */
  wording?: TurnOnWording;
  /** Given when the hosts GoatCitadel may reach couldn't be read: the step says so, and Try again calls this. */
  retryHostCheck?: () => void;
}) {
  if (turnOn.state === "done") {
    return (
      <div className="space-y-2">
        <p>{wording.done}</p>
        {doneHref ? (
          <NativeOwnerLink href={doneHref} scope={workspaceId}>
            {wording.doneLink}
          </NativeOwnerLink>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <ul className="list-disc space-y-1 pl-5">
        {changes.map((change) => (
          <li key={change}>{change}</li>
        ))}
      </ul>
      {retryHostCheck ? (
        <Callout tone="warning" announce={false}>
          <p>{HOSTS_UNKNOWN}</p>
          <div className="mt-2">
            <Button size="sm" onClick={retryHostCheck}>
              Try again
            </Button>
          </div>
        </Callout>
      ) : null}
      <Outcome turnOn={turnOn} workspaceId={workspaceId} wording={wording} />
      {turnOn.state === "cleanup" ? null : (
        <Button
          variant="primary"
          loading={turnOn.state === "working"}
          loadingLabel={wording.working}
          disabled={disabled}
          onClick={onTurnOn}
        >
          {wording.button}
        </Button>
      )}
    </div>
  );
}
