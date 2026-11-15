// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHELL_HISTORY_POSITION } from "../../app/shell-transition";
import { cockpitHistoryPosition, commitCockpitNavigation, subscribeCockpitHistory } from "./cockpit-history";

/** What a route subscriber that renders at once would read, at the moment it is notified (no batching). */
let seenAtNotification: Array<number | null>;
let unsubscribe: () => void;

beforeEach(() => {
  window.history.replaceState({ [SHELL_HISTORY_POSITION]: 4 }, "", "/inbox?shell=cockpit");
  seenAtNotification = [];
  unsubscribe = subscribeCockpitHistory(() => seenAtNotification.push(cockpitHistoryPosition()));
});
afterEach(() => unsubscribe());

describe("the history position a visit is told apart by", () => {
  it("has already moved when a pushed address notifies its subscribers", () => {
    const before = cockpitHistoryPosition();
    commitCockpitNavigation("/work");
    expect(seenAtNotification).not.toHaveLength(0);
    for (const seen of seenAtNotification) expect(seen).not.toBe(before);
  });

  it("has already moved when a native Back reaches the subscribers", () => {
    const before = cockpitHistoryPosition();
    // The browser restores the earlier entry's state before it fires popstate.
    window.history.replaceState({ [SHELL_HISTORY_POSITION]: 3 }, "", "/inbox?shell=cockpit");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(seenAtNotification).not.toHaveLength(0);
    for (const seen of seenAtNotification) expect(seen).not.toBe(before);
  });

  it("does not move for a replace", () => {
    const before = cockpitHistoryPosition();
    commitCockpitNavigation("/work", { replace: true });
    expect(seenAtNotification).not.toHaveLength(0);
    for (const seen of seenAtNotification) expect(seen).toBe(before);
  });
});
