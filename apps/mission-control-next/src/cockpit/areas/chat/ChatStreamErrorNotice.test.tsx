// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatStreamErrorNotice } from "./ChatStreamErrorNotice";

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

describe("Chat stream error notice", () => {
  it("shows plain-language copy for a recognized network failure", async () => {
    await act(async () => root.render(<ChatStreamErrorNotice error="Failed to fetch" source="send" />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Can't reach the GoatCitadel gateway");
    expect(container.querySelector("details")).toBeNull();
  });

  it("keeps the generic sentence and tucks an unrecognized raw error behind a detail", async () => {
    await act(async () => root.render(<ChatStreamErrorNotice error="E_WEIRD_42 internal" source="other" />));
    expect(container.textContent).toContain("The request failed.");
    expect(container.querySelector("details")?.textContent).toContain("E_WEIRD_42 internal");
  });
});
