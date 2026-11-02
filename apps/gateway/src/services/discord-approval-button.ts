/**
 * The Discord Approve / Deny buttons on an approval message. The Gateway's comms executor puts the raw approval token in
 * each button's custom_id as `gca:<token>:a|r`; a press comes back to the bot's gateway connection, which parses it here
 * and hands it to the durable inbound command owner without the raw token.
 */

/** The durable inbound command event a button press becomes. */
export const DISCORD_APPROVAL_BUTTON_EVENT_TYPE = "discord-approval-button";

export const DISCORD_APPROVAL_BUTTON_COPY = {
  approved: "Approved.",
  denied: "Denied.",
  alreadyAnswered: "This was already answered.",
  unknown: "GoatCitadel did not recognize that approval.",
  notPaired: "Approve this Discord user in GoatCitadel before answering approvals.",
  notRouted: "GoatCitadel is not enabled for approvals in this channel or DM route.",
} as const;

export type DiscordApprovalButtonDecision = "approve" | "reject";

const DISCORD_APPROVAL_BUTTON_ID = /^gca:([^:]+):(a|r)$/;

/** The token and decision a button's custom_id carries; undefined for any other custom_id. */
export function parseDiscordApprovalButtonId(
  customId: string,
): { token: string; decision: DiscordApprovalButtonDecision } | undefined {
  const match = DISCORD_APPROVAL_BUTTON_ID.exec(customId);
  if (!match?.[1]) {
    return undefined;
  }
  return { token: match[1], decision: match[2] === "a" ? "approve" : "reject" };
}

/** The slash-command text a press stands for. The durable acceptance strips the token before it is persisted. */
export function buildDiscordApprovalButtonCommandText(button: {
  token: string;
  decision: DiscordApprovalButtonDecision;
}): string {
  return `/${button.decision === "approve" ? "approve" : "deny"} ${button.token}`;
}
