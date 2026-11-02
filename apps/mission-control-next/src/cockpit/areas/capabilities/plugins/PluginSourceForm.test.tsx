// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSourceForm } from "./PluginSourceForm";
import type { PluginSourceFormKind } from "./plugin-links";

let container: HTMLDivElement;
let root: Root;
const onCheck = vi.fn();

const fields = () => [...container.querySelectorAll<HTMLInputElement>("input")];
const labels = () => [...container.querySelectorAll("label")].map((label) => label.textContent);
const alerts = () => [...container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent);
const checkButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "Check")!;

async function render(kind: PluginSourceFormKind, props: { checking?: boolean; error?: string } = {}) {
  await act(async () =>
    root.render(
      <PluginSourceForm kind={kind} checking={props.checking ?? false} error={props.error} onCheck={onCheck} />,
    ),
  );
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => checkButton().click());
}

beforeEach(() => {
  onCheck.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Plugin source form", () => {
  it("refuses a Git address that isn't https before checking", async () => {
    await render("git");
    expect(labels()).toEqual(["Git repository address*", "Commit, branch or tag"]);

    for (const address of [
      "http://github.com/acme/tools",
      "github.com/acme/tools",
      "ssh://git@github.com/acme/tools",
    ]) {
      await type(fields()[0]!, address);
      await submit();
      expect(alerts()).toEqual(["Enter an https address, like https://github.com/name/repo."]);
    }
    // Editing the address clears the refusal.
    await type(fields()[0]!, "https://github.com/acme/tool");
    expect(alerts()).toEqual([]);
    expect(onCheck).not.toHaveBeenCalled();
  });

  it("keeps a user name or token in the address from leaving the browser", async () => {
    await render("git");
    await type(fields()[0]!, "https://octo:ghp_secret@github.com/acme/tools");
    await submit();
    expect(alerts()).toEqual(["Leave your user name and token out of the address, like https://github.com/name/repo."]);
    expect(onCheck).not.toHaveBeenCalled();
  });

  it("sends a commit, branch or tag only when one is typed", async () => {
    await render("git");
    await type(fields()[0]!, "  https://github.com/acme/tools  ");
    await submit();
    // A blank one is left out: the route takes 1 to 256 characters when it is sent at all.
    expect(onCheck).toHaveBeenLastCalledWith({ kind: "git", url: "https://github.com/acme/tools" });

    await type(fields()[1]!, "  v1.2.0 ");
    await submit();
    expect(onCheck).toHaveBeenLastCalledWith({ kind: "git", url: "https://github.com/acme/tools", ref: "v1.2.0" });
  });

  it("asks for a folder on the computer GoatCitadel runs on", async () => {
    await render("folder");
    expect(labels()).toEqual(["Folder path*"]);
    expect(container.textContent).toContain("A folder on the computer GoatCitadel runs on.");

    await submit();
    expect(alerts()).toEqual(["Enter the folder's full path."]);
    expect(onCheck).not.toHaveBeenCalled();

    await type(fields()[0]!, "  D:\\plugins\\meeting-tools ");
    await submit();
    // Which paths are allowed is GoatCitadel's to decide.
    expect(onCheck).toHaveBeenCalledExactlyOnceWith({ kind: "folder", path: "D:\\plugins\\meeting-tools" });
  });

  it("shows a refusal only while the field holds what it was about", async () => {
    await render("git");
    await type(fields()[0]!, "https://example.com/acme/tools");
    await submit();
    await render("git", { error: "GoatCitadel installs plugins only from GitHub, GitLab, Bitbucket or Codeberg." });
    expect(alerts()).toEqual(["GoatCitadel installs plugins only from GitHub, GitLab, Bitbucket or Codeberg."]);

    await type(fields()[0]!, "https://example.com/acme/other");
    expect(alerts()).toEqual([]);
    await type(fields()[0]!, " https://example.com/acme/tools");
    expect(alerts()).toHaveLength(1);
  });

  it("says it is checking on its one button", async () => {
    await render("folder", { checking: true });
    const busy = container.querySelector<HTMLButtonElement>('button[aria-busy="true"]');
    expect(busy?.textContent).toBe("Checking…");
  });
});
