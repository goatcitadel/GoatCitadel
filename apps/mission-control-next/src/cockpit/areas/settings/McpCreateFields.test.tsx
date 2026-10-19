// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEmptyMcpCreateForm,
  type McpCreateForm,
} from "../../../features/native-routes/settings/sections/mcp-editor-drafts";
import { McpCreateFields, mcpEnableBlockedReason } from "./McpCreateFields";

let root: Root, container: HTMLDivElement;
function Harness({ initial }: { initial: McpCreateForm }) {
  const [draft, setDraft] = useState(initial);
  return <McpCreateFields draft={draft} disabled={false} onChange={setDraft} />;
}
const input = (name: string) => container.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
async function type(target: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function blur(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("new MCP server fields", () => {
  it("marks required fields and ties a blur error to the server URL", async () => {
    await act(async () => root.render(<Harness initial={{ ...createEmptyMcpCreateForm(), transport: "http" }} />));
    expect(input("Server label").getAttribute("aria-required")).toBe("true");
    const url = input("Server URL");
    expect(url.getAttribute("aria-required")).toBe("true");
    await type(url, "example.test/mcp");
    expect(url.getAttribute("aria-invalid")).toBeNull();
    await blur(url);
    expect(url.getAttribute("aria-invalid")).toBe("true");
    const [errorId] = url.getAttribute("aria-describedby")!.split(" ");
    expect(document.getElementById(errorId!)?.textContent).toContain("Enter a full URL");
    await type(url, "https://example.test/mcp");
    expect(url.getAttribute("aria-invalid")).toBeNull();
  });

  it("says why Save as enabled is unavailable and ties the reason to the checkbox", async () => {
    await act(async () => root.render(<Harness initial={{ ...createEmptyMcpCreateForm(), transport: "http" }} />));
    const checkbox = container.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(checkbox.disabled).toBe(true);
    expect(document.getElementById(checkbox.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Enter a server URL to save it as enabled.",
    );
    await type(input("Server URL"), "https://example.test/mcp");
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.hasAttribute("aria-describedby")).toBe(false);
  });

  it("names the quarantine and sign-in blocks in plain words", () => {
    const remote = { ...createEmptyMcpCreateForm(), transport: "http" as const, url: "https://example.test/mcp" };
    expect(mcpEnableBlockedReason({ ...remote, trustTier: "quarantined" })).toBe(
      "Quarantined servers are saved disabled.",
    );
    expect(mcpEnableBlockedReason({ ...remote, authType: "token" })).toContain("token sign-in needs");
    expect(mcpEnableBlockedReason(createEmptyMcpCreateForm())).toBeUndefined();
  });
});
