/**
 * The Inbox address for the item that is open, or for no item. The address carries only the item's public id and
 * its workspace (never a title or any argument text), so it is safe to copy, bookmark and keep in history.
 * Other parameters and the hash stay as they were. An item replaces a linked approval, as `InboxOwnerLink` does.
 */
export function inboxSelectionHref(
  location: { pathname: string; search: string; hash: string },
  itemId: string | null,
  workspaceId: string,
): string {
  const parameters = new URLSearchParams(location.search);
  parameters.set("workspaceId", workspaceId);
  if (itemId === null) {
    parameters.delete("item");
  } else {
    parameters.set("item", itemId);
    parameters.delete("approvalId");
  }
  const query = parameters.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}
