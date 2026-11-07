import assert from "node:assert/strict";
import { test } from "node:test";
import { closeConversationList, openConversationList, readCurrentConversation } from "./cockpit-conversation-list.mjs";

// Radix Content remains visible during Presence exit, but data-state is already
// closed. This model changes state only when the helper waits for that exit;
// reading/clicking the retained exiting content must not manufacture a reopen.
function transitionPage({ initial = "closing", clickError, currentCount = 1 } = {}) {
  let state = initial;
  const calls = [];
  function locator(kind) {
    const self = {
      or: () => locator("available"),
      filter: () => self,
      first: () => self,
      isVisible: async () => kind === "rail" ? false : kind === "sheet" ? state !== "hidden" : true,
      count: async () => kind === "current" ? currentCount : kind === "sheet" ? Number(state !== "hidden") : 1,
      getAttribute: async (name) => {
        assert.equal(name, "data-state");
        return state === "closing" ? "closed" : state === "open" ? "open" : null;
      },
      waitFor: async (options = {}) => {
        calls.push(["wait", kind, options.state ?? "visible"]);
        if (kind === "sheet" && options.state === "hidden") {
          assert.notEqual(state, "open", "A genuinely open sheet cannot disappear without its native close");
          state = "hidden";
        } else if (kind === "sheet") {
          assert.notEqual(state, "hidden", "An opener click must precede sheet admission");
        }
      },
      getByRole: (role, options) => {
        assert.equal(options?.exact, true);
        if (role === "button" && options.name === "Close sheet") return locator("close");
        if (role === "navigation" && options.name === "Conversations") return locator("navigation");
        throw new Error("Unexpected nested role");
      },
      locator: (selector) => {
        assert.equal(selector, 'button[aria-current="page"]');
        return locator("current");
      },
      textContent: async () => {
        calls.push(["read", state]);
        assert.equal(state, "open", "Do not read a current row from an exiting sheet");
        return "Target conversation just now";
      },
      click: async (options = {}) => {
        assert.notEqual(options.force, true, "Native actionability must remain enforced");
        calls.push(["click", kind]);
        if (kind === "opener") {
          assert.equal(state, "hidden", "Wait for old sheet retirement before reopening");
          state = "open";
          return;
        }
        assert.equal(kind, "close");
        assert.equal(state, "open", "Exiting Close sheet detaches during native actionability wait");
        if (clickError) throw clickError;
        state = "closing";
      },
    };
    return self;
  }
  return {
    calls,
    state: () => state,
    page: {
      getByRole(role, options) {
        assert.deepEqual(options, { name: "Conversations", exact: true });
        const kind = { complementary: "rail", dialog: "sheet", button: "opener" }[role];
        assert.ok(kind);
        return locator(kind);
      },
      waitForTimeout: async () => { throw new Error("No fixed delay can establish native sheet retirement"); },
    },
  };
}

test("closing visible native sheet is awaited without clicking its retiring Close button", async () => {
  const fixture = transitionPage();
  await closeConversationList(fixture.page);
  assert.equal(fixture.state(), "hidden");
  assert.deepEqual(fixture.calls, [["wait", "sheet", "hidden"]]);
});

test("opening during selection exit waits for hidden then uses the native opener once", async () => {
  const fixture = transitionPage();
  await openConversationList(fixture.page);
  assert.equal(fixture.state(), "open");
  assert.deepEqual(fixture.calls.filter(([kind]) => kind === "click"), [["click", "opener"]]);
  assert.ok(fixture.calls.findIndex(row => row[0] === "wait" && row[2] === "hidden") < fixture.calls.findIndex(row => row[0] === "click"));
});

test("current-row inspection reopens after selection exit and closes only its newly opened sheet", async () => {
  const fixture = transitionPage();
  assert.equal(await readCurrentConversation(fixture.page, { expectedTitle: "Target conversation" }), "Target conversation just now");
  assert.deepEqual(fixture.calls.filter(([kind]) => kind === "click"), [["click", "opener"], ["click", "close"]]);
  assert.deepEqual(fixture.calls.filter(([kind]) => kind === "read"), [["read", "open"]]);
  assert.equal(fixture.state(), "hidden");
});

test("genuinely open native sheet still requires its exact close click and observed retirement", async () => {
  const fixture = transitionPage({ initial: "open" });
  await closeConversationList(fixture.page);
  assert.deepEqual(fixture.calls, [["click", "close"], ["wait", "sheet", "hidden"]]);
});

test("an arbitrary native close failure remains the original failure, not successful retirement", async () => {
  const error = new Error("Synthetic unrelated actionability failure");
  const fixture = transitionPage({ initial: "open", clickError: error });
  await assert.rejects(closeConversationList(fixture.page), cause => cause === error);
  assert.equal(fixture.state(), "open");
  assert.deepEqual(fixture.calls, [["click", "close"]]);
});

test("already hidden sheet requires neither a click nor a replacement opener", async () => {
  const fixture = transitionPage({ initial: "hidden" });
  await closeConversationList(fixture.page);
  assert.deepEqual(fixture.calls, []);
});

test("two current rows cannot be accepted by selecting the first label", async () => {
  const fixture = transitionPage({ initial: "open", currentCount: 2 });
  await assert.rejects(readCurrentConversation(fixture.page, { expectedTitle: "Target conversation" }), /current|unique|one|ambiguous/i);
  assert.equal(fixture.state(), "hidden", "Failure must retain owned sheet cleanup");
});
