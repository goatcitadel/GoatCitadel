// Cockpit Chat keeps one conversation list (ConversationListPanel): the desktop rail
// (complementary "Conversations") and, below md, a "Conversations" sheet opened from the
// header's "Conversations" button. Both hold the filters, Recent/Archived, the rows in
// navigation "Conversations" (the current row has aria-current="page") and Load more.
// These helpers drive either layout by accessible name.
export const CONVERSATIONS = "Conversations";
export const CLOSE_SHEET = "Close sheet";
const SEARCH_HIT_ACTION = "Open matching message";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** A row's accessible name starts with the conversation label, then its time, status and preview. */
export function conversationRowName(title) {
  return new RegExp(`^${escapeRegex(title)}`, "u");
}

function rail(page) {
  return page.getByRole("complementary", { name: CONVERSATIONS, exact: true });
}

function sheet(page) {
  return page.getByRole("dialog", { name: CONVERSATIONS, exact: true });
}

/** The visible list container: the desktop rail, or the phone sheet (opened if needed). */
export async function openConversationList(page, { timeout = 30_000 } = {}) {
  const opener = page.getByRole("button", { name: CONVERSATIONS, exact: true });
  await rail(page).or(sheet(page)).or(opener).filter({ visible: true }).first().waitFor({ timeout });
  if (await rail(page).isVisible()) return rail(page);
  if (!(await sheet(page).isVisible())) await opener.click({ timeout });
  await sheet(page).waitFor({ timeout });
  return sheet(page);
}

/** Close the phone sheet when it is open; the desktop rail stays. */
export async function closeConversationList(page) {
  const open = sheet(page);
  if (!(await open.isVisible())) return;
  await open.getByRole("button", { name: CLOSE_SHEET, exact: true }).click();
  await open.waitFor({ state: "hidden" });
}

export function conversationNavigation(list) {
  return list.getByRole("navigation", { name: CONVERSATIONS, exact: true });
}

/** Conversation rows only: search-hit "Open matching message" buttons are not conversations. */
export function conversationRows(list) {
  return conversationNavigation(list).getByRole("button").filter({ hasNotText: SEARCH_HIT_ACTION });
}

/** Choose a conversation by its label. Choosing closes the phone sheet. */
export async function selectConversation(page, title) {
  const list = await openConversationList(page);
  await conversationNavigation(list)
    .getByRole("button", { name: conversationRowName(title) })
    .first()
    .click();
}

/**
 * The label text of the row the list marks current (aria-current="page"), read from the list
 * itself rather than the URL. With expectedTitle it waits until that row is current. The phone
 * sheet is closed again afterwards.
 */
export async function readCurrentConversation(page, { expectedTitle, timeout = 10_000 } = {}) {
  const list = await openConversationList(page);
  const current = conversationNavigation(list).locator('button[aria-current="page"]');
  const deadline = Date.now() + timeout;
  let label = null;
  try {
    for (;;) {
      label = (await current.count()) ? ((await current.first().textContent()) ?? "").trim() : null;
      if (!expectedTitle || label?.startsWith(expectedTitle) || Date.now() >= deadline) break;
      await page.waitForTimeout(250);
    }
  } finally {
    await closeConversationList(page);
  }
  return label;
}
