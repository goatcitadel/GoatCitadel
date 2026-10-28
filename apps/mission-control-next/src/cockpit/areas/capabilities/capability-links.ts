/** Links every Capabilities tab shares. */

/** The Inbox page for one approval. Plans made from Capabilities are made in the installation's own workspace. */
export const inboxApprovalHref = (approvalId: string) =>
  `/inbox?approvalId=${encodeURIComponent(approvalId)}&workspaceId=default`;

/** The link that goes with a sentence pointing to an approval, named by its destination's cockpit name. */
export interface InboxLink {
  readonly label: "Open in Inbox";
  readonly href: string;
}

export const inboxApprovalLink = (approvalId: string): InboxLink => ({
  label: "Open in Inbox",
  href: inboxApprovalHref(approvalId),
});
