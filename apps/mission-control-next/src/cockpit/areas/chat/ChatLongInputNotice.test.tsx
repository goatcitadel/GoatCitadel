// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatLongInputNotice, LONG_INPUT_NOTICE_CHARS } from "./ChatLongInputNotice";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Long input notice", () => {
  it("stays silent below the threshold", () => {
    act(() => root.render(<ChatLongInputNotice draft={"a".repeat(LONG_INPUT_NOTICE_CHARS - 1)} />));
    expect(container.textContent).toBe("");
  });

  it("says how long the message is at the threshold and does not block sending", () => {
    act(() => root.render(<ChatLongInputNotice draft={"a".repeat(60_000)} />));
    const note = container.querySelector('[role="status"]');
    expect(note?.textContent).toContain("60,000 characters");
    expect(note?.textContent).toContain("You can still send it");
    expect(container.querySelector("button")).toBeNull();
  });
});
