// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { ClaudeCliBackgroundJobsNotice } from "./ClaudeCliBackgroundJobsNotice";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function render(): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <CockpitNavigationProvider>
        <ClaudeCliBackgroundJobsNotice />
      </CockpitNavigationProvider>,
    ),
  );
  return host;
}

describe("ClaudeCliBackgroundJobsNotice", () => {
  it("says background jobs are off on the Claude Code CLI, which jobs they are, and how to turn them on (#493)", () => {
    const view = render();
    const section = view.querySelector("section");
    expect(section?.getAttribute("aria-labelledby")).toBe("claude-cli-background-jobs-title");
    expect(view.querySelector("#claude-cli-background-jobs-title")?.textContent).toBe(
      "Claude Code CLI: background jobs are off",
    );
    const text = view.textContent ?? "";
    for (const job of ["follow-up suggestions", "learned facts about you", "procedure reviews"]) {
      expect(text).toContain(job);
    }
    expect(text).toContain("would start its own Claude Code process");
    expect(text).toContain("utility model");
    expect(text).toContain("provider with an API key");
    expect(text).toContain("Chat can propose that change");
    // The sentence that points at Chat links there.
    expect(view.querySelector("a")?.getAttribute("href")).toBe("/chat");
    expect(view.querySelector("a")?.textContent).toBe("Open Chat");
  });
});
