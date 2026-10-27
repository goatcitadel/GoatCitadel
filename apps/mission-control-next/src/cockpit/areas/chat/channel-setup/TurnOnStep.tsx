import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import type { TurnOnState } from "./use-turn-on";

export const TURNED_ON = "Telegram is on. Send your bot a message to try it.";
export const CLEANUP_NOTE = "GoatCitadel couldn't remove its test message. Delete it in Telegram if you like.";
/** The one thing every turn-on does that the operator can see in their chat. */
export const TEST_MESSAGE_CHANGE = "GoatCitadel sends a test message to your chat and then removes it";

/** The words of the step's button and its ending, so a page that applies a different change can say its own. */
export interface TurnOnWording {
  button: string;
  /** The button while the change is being made. */
  working: string;
  /** What the step says once the change is made. */
  done: string;
  /** The link beside it, to the channel's page. */
  doneLink: string;
}

/** Turning a new channel on. */
export const TURN_ON_WORDING: TurnOnWording = {
  button: "Turn on",
  working: "Turning on…",
  done: TURNED_ON,
  doneLink: "Open Telegram's page",
};

/**
 * What turning on will do, as plain lines. A host appears only when it is not yet allowed; when the settings could
 * not be read the caller passes none, because the page cannot say what it has not seen.
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
    ...missingHosts.map((host) => `${host} is added to the hosts GoatCitadel may reach`),
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
      return CLEANUP_NOTE;
    case "failed":
      return turnOn.message;
    case "blocked":
      return turnOn.reasons.join(" ");
    case "elsewhere":
      return turnOn.approvalId ? "Approve it in Inbox" : "Finish this in Settings";
    default:
      return undefined;
  }
}

/** The Inbox page for one approval, in the workspace the change was made in. */
function inboxApprovalHref(approvalId: string, workspaceId: string): string {
  return `/inbox?approvalId=${encodeURIComponent(approvalId)}&workspaceId=${encodeURIComponent(workspaceId)}`;
}

/** Where the last click left things, when it did not finish: the reasons, the failure, or where to go next. */
function Outcome({
  turnOn,
  workspaceId,
  settingsHref,
}: {
  turnOn: TurnOnState;
  workspaceId: string;
  settingsHref: string;
}) {
  switch (turnOn.state) {
    case "cleanup":
      return (
        <Callout tone="warning" announce={false}>
          <p>{CLEANUP_NOTE}</p>
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
          ) : (
            <NativeOwnerLink href={settingsHref} scope={workspaceId}>
              Finish this in Settings
            </NativeOwnerLink>
          )}
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
  settingsHref,
  wording = TURN_ON_WORDING,
}: {
  changes: readonly string[];
  turnOn: TurnOnState;
  onTurnOn(): void;
  /** The channel's page, once the change is made and it could be found. */
  doneHref?: string;
  disabled?: boolean;
  workspaceId: string;
  /** Where Settings has this channel's setup. */
  settingsHref: string;
  /** The button and the ending; turning a new channel on unless the page says otherwise. */
  wording?: TurnOnWording;
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
      <Outcome turnOn={turnOn} workspaceId={workspaceId} settingsHref={settingsHref} />
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
