/**
 * The governed browser errand approval conversation: the settings owner's projection and write, and the runtime
 * configuration Change Plan's prepare and description. Every check is the same one: the session must be the operator's
 * own private conversation on a channel (a writable channel binding to a direct conversation whose other person passes
 * the errand owner rule). The errand escalation runs that check again at each send.
 */

import {
  ERRAND_APPROVAL_CONVERSATION_NOT_OWN,
  ValidationError,
  readErrandApprovalSessionId,
  type BrowserErrandApprovalConversationRuntimeOperation,
} from "@goatcitadel/contracts";
import type { AssistantConfig } from "../config.js";
import type { EvolutionControlPlaneAdapterContext } from "./evolution-control-plane-adapter.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";

/** The title of the operator's own private conversation behind a session, or undefined for any other session. */
export type ErrandApprovalConversationTitle = (sessionId: string) => Promise<string | undefined>;

const IMPACT =
  "When you're away from the PC, a browser errand approval you haven't answered in 30 seconds goes to this conversation and to your phone.";
const CLEAR_IMPACT = "Waiting browser errand approvals still go to your phone.";

/** The settings projection; always present, so an empty pick reads as none rather than as an unknown setting. */
export function projectBrowserErrandSettings(
  assistant: Pick<AssistantConfig, "browserErrands">,
): NonNullable<RuntimeSettings["browserErrands"]> {
  const approvalSessionId = readErrandApprovalSessionId(assistant.browserErrands?.approvalSessionId);
  return approvalSessionId ? { approvalSessionId } : {};
}

/**
 * The settings owner's write. `null` or an empty id clears the pick. Any other id is kept only when `isOwn` says it is
 * the operator's own private conversation; without that check every id is refused, never accepted unchecked.
 */
export async function applyErrandApprovalConversation(
  assistant: Pick<AssistantConfig, "browserErrands">,
  value: string | null,
  isOwn: ((sessionId: string) => Promise<boolean>) | undefined,
): Promise<void> {
  if (value === null || !value.trim()) {
    delete assistant.browserErrands;
    return;
  }
  const sessionId = readErrandApprovalSessionId(value);
  if (!sessionId || !isOwn || !(await isOwn(sessionId))) {
    throw new ValidationError({ message: ERRAND_APPROVAL_CONVERSATION_NOT_OWN });
  }
  assistant.browserErrands = { approvalSessionId: sessionId };
}

/** The title of the picked conversation, or the one refusal when it is not the operator's own private conversation. */
async function requireOwnConversationTitle(
  sessionId: string,
  titleOf: ErrandApprovalConversationTitle | undefined,
): Promise<string> {
  const title = titleOf ? await titleOf(sessionId) : undefined;
  if (title === undefined) throw new ValidationError({ message: ERRAND_APPROVAL_CONVERSATION_NOT_OWN });
  return title;
}

/** A plan for a conversation the settings owner would refuse is never prepared. A clear needs no check. */
export async function prepareErrandApprovalConversation(
  context: EvolutionControlPlaneAdapterContext,
  change: BrowserErrandApprovalConversationRuntimeOperation,
  settings: RuntimeSettings,
  titleOf: ErrandApprovalConversationTitle | undefined,
) {
  const { approvalSessionId } = change.config;
  const title = approvalSessionId === null ? undefined : await requireOwnConversationTitle(approvalSessionId, titleOf);
  const description = describeErrandApprovalConversation(approvalSessionId, title);
  return {
    target: {
      ownerId: "runtime_settings",
      resourceId: change.operation,
      expectedRevision: settings.revision,
    },
    title: description.title,
    summary: description.summary,
    impact: description.impact,
    risk: description.risk,
    status: "awaiting_confirmation" as const,
    requiredAction: context.actions.confirmation({
      title: `Confirm ${description.title.toLowerCase()}`,
      confirmationText: description.summary,
    }),
  };
}

/** Names the conversation when its title is known: a prepare looks it up, a later step has only the plan. */
export function describeErrandApprovalConversation(approvalSessionId: string | null, title?: string) {
  if (approvalSessionId === null) {
    return {
      title: "Stop sending browser errand approvals to a channel",
      summary: "Stop sending browser errand approvals to a channel",
      completedSummary: "Waiting browser errand approvals no longer go to a channel conversation.",
      impact: CLEAR_IMPACT,
      risk: "caution" as const,
    };
  }
  return {
    title: "Choose where waiting browser errand approvals go",
    summary: `Send waiting browser errand approvals to ${title ?? "the conversation you picked"}`,
    completedSummary: `Waiting browser errand approvals now go to ${title ?? "the conversation you picked"}.`,
    impact: IMPACT,
    risk: "caution" as const,
  };
}

/**
 * The completed plan's summary, naming the conversation the write just kept. The name is read again after the write;
 * when it can't be read the summary still says the pick was saved, without a name.
 */
export async function completedErrandApprovalConversationSummary(
  approvalSessionId: string | null,
  titleOf: ErrandApprovalConversationTitle | undefined,
): Promise<string> {
  const title =
    approvalSessionId === null || !titleOf ? undefined : await titleOf(approvalSessionId).catch(() => undefined);
  return describeErrandApprovalConversation(approvalSessionId, title).completedSummary;
}

/** The conversation in plain words: its name and the channel it is on, such as "Me on Telegram". */
export function errandApprovalConversationLabel(title: string, channelName: string | undefined): string {
  return channelName ? `${title} on ${channelName}` : title;
}

/** Whether the settings owner holds exactly the plan's pick; a clear matches no pick. */
export function matchesErrandApprovalConversation(
  change: BrowserErrandApprovalConversationRuntimeOperation,
  settings: RuntimeSettings,
): boolean {
  return (settings.browserErrands?.approvalSessionId ?? null) === change.config.approvalSessionId;
}
