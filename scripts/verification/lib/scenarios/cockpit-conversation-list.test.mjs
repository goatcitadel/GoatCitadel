import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeConversationList,
  conversationRowName,
  openConversationList,
  readCurrentConversation,
  selectConversation,
} from "./cockpit-conversation-list.mjs";

/** A role-path fake: desktop shows the rail; a phone shows the Conversations button, which opens the sheet. */
function fakeConversationPage(layout, { currentLabel = "Alpha 2m ago" } = {}) {
  const calls = [];
  let sheetOpen = false;
  const visible = (key) => {
    if (key === "complementary:Conversations") return layout === "desktop";
    if (key === "dialog:Conversations") return layout === "phone" && sheetOpen;
    if (key === "button:Conversations") return layout === "phone" && !sheetOpen;
    return true;
  };
  const describe = (role, options) => `${role}:${options?.name ?? ""}`;
  function locator(path) {
    const key = path[0];
    const self = {
      or: () => locator([...path, "or"]),
      filter: () => self,
      first: () => self,
      waitFor: async (options) => calls.push(["waitFor", path.join(" > "), options?.state ?? "visible"]),
      isVisible: async () => visible(key),
      count: async () => 1,
      textContent: async () => currentLabel,
      getByRole: (role, options) => locator([...path, describe(role, options)]),
      locator: (selector) => locator([...path, selector]),
      click: async () => {
        const target = path.join(" > ");
        calls.push(["click", target]);
        if (target === "button:Conversations") sheetOpen = true;
        else if (key === "dialog:Conversations" && path.at(-1).startsWith("button:")) sheetOpen = false;
      },
    };
    return self;
  }
  return {
    calls,
    page: { getByRole: (role, options) => locator([describe(role, options)]), waitForTimeout: async () => {} },
  };
}

test("row names match the conversation label as a literal prefix", () => {
  const name = conversationRowName("Composer [literal].title");
  assert.ok(name.test("Composer [literal].title2m agoActive"));
  assert.ok(!name.test("Composer ltitle"));
  assert.ok(!name.test("Other Composer [literal].title"));
});

test("desktop chooses a conversation from the rail without opening a sheet", async () => {
  const { page, calls } = fakeConversationPage("desktop");
  await selectConversation(page, "Alpha");
  const clicks = calls.filter(([kind]) => kind === "click").map(([, target]) => target);
  assert.deepEqual(clicks, ["complementary:Conversations > navigation:Conversations > button:/^Alpha/u"]);
});

test("a phone opens the Conversations sheet and chooses the row inside it", async () => {
  const { page, calls } = fakeConversationPage("phone");
  await selectConversation(page, "Alpha");
  const clicks = calls.filter(([kind]) => kind === "click").map(([, target]) => target);
  assert.deepEqual(clicks, [
    "button:Conversations",
    "dialog:Conversations > navigation:Conversations > button:/^Alpha/u",
  ]);
});

test("reading the current row opens and then closes the phone sheet", async () => {
  const { page, calls } = fakeConversationPage("phone", { currentLabel: "  Alpha 2m ago " });
  assert.equal(await readCurrentConversation(page, { expectedTitle: "Alpha" }), "Alpha 2m ago");
  const clicks = calls.filter(([kind]) => kind === "click").map(([, target]) => target);
  assert.deepEqual(clicks, ["button:Conversations", "dialog:Conversations > button:Close sheet"]);
  // Already closed: closing again is a no-op.
  await closeConversationList(page);
  assert.equal(calls.filter(([kind]) => kind === "click").length, 2);
});

test("an open phone sheet is reused rather than toggled", async () => {
  const { page, calls } = fakeConversationPage("phone");
  await openConversationList(page);
  await openConversationList(page);
  assert.equal(calls.filter(([kind, target]) => kind === "click" && target === "button:Conversations").length, 1);
});
