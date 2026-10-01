// @vitest-environment happy-dom
import { act, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import type { Dialog } from "../../ui/Dialog";
import { McpServerEditor } from "./McpServerEditor";
import { __resetMcpServerMutationsForTests } from "../../../features/native-routes/settings/mcp-server-mutation";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
const api = vi.hoisted(() => ({ fetchMcpServer: vi.fn(), updateMcpServer: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: ComponentProps<typeof Dialog>) =>
    open ? <section aria-label={title}>{children}</section> : null,
}));
const fixture = (): McpServerRecord => ({
  serverId: "mcp-editor",
  revision: "a".repeat(64),
  label: "Original server",
  transport: "stdio",
  command: "node",
  args: ["--credential", "[REDACTED]"],
  authType: "none",
  enabled: false,
  status: "disconnected",
  category: "development",
  trustTier: "restricted",
  costTier: "free",
  policy: {
    requireFirstToolApproval: true,
    redactionMode: "strict",
    allowedToolPatterns: [],
    blockedToolPatterns: [],
    allowedEnvKeys: [],
  },
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
});
let saved: McpServerRecord;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const close = vi.fn();
const button = (name: string) => [...container.querySelectorAll("button")].find((node) => node.textContent === name)!;
async function click(name: string) {
  await act(async () => button(name).click());
}
async function typeLabel(value: string) {
  const label = [...container.querySelectorAll("label")].find((node) => node.textContent === "Label")!;
  const input = container.querySelector<HTMLInputElement>(`[id="${label.htmlFor}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input.value).toBe(value);
}
async function field(name: string, value: string) {
  const label = [...container.querySelectorAll("label")].find((node) => node.textContent === name)!;
  const node = container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `[id="${label.htmlFor}"]`,
  )!;
  await act(async () => {
    const prototype =
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : node instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function render() {
  await act(async () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <McpServerEditor workspaceId="workspace" serverId="mcp-editor" onClose={close} />
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Credentials and trust"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetMcpServerMutationsForTests();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  saved = fixture();
  api.fetchMcpServer.mockImplementation(async () => structuredClone(saved));
  api.updateMcpServer.mockImplementation(async (_id, input) => {
    saved = {
      ...saved,
      ...Object.fromEntries(
        Object.entries(input).filter(([key, value]) => key !== "expectedRevision" && value !== undefined),
      ),
      revision: "b".repeat(64),
    };
    return structuredClone(saved);
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});
describe("native saved MCP editor", () => {
  it("reviews full policy and exact argument boundaries, cancels, then saves through the shared CAS", async () => {
    await render();
    await field("Process arguments — one per line", "--mode\nread only");
    await field("Tool output redaction", "basic");
    await field("Allowed tool patterns — one per line", "read.*\ninspect");
    await field("Blocked tool patterns — one per line", "read.private");
    await field("Allowed environment keys — one per line", "LANG\nLC_ALL");
    await field("Policy notes", "Reviewed metadata");
    await click("Review MCP changes");
    expect(container.textContent).toContain("--mode · read only");
    expect(container.textContent).toContain("read.private");
    await click("Cancel review");
    expect(api.updateMcpServer).not.toHaveBeenCalled();
    await click("Review MCP changes");
    await click("Save reviewed MCP configuration");
    expect(api.updateMcpServer).toHaveBeenCalledExactlyOnceWith(
      "mcp-editor",
      expect.objectContaining({
        expectedRevision: "a".repeat(64),
        args: ["--mode", "read only"],
        policy: {
          requireFirstToolApproval: true,
          redactionMode: "basic",
          allowedToolPatterns: ["read.*", "inspect"],
          blockedToolPatterns: ["read.private"],
          allowedEnvKeys: ["LANG", "LC_ALL"],
          notes: "Reviewed metadata",
        },
      }),
    );
    expect(saved.enabled).toBe(false);
  });
  it("withholds invalid environment names without silently dropping a reviewed entry", async () => {
    await render();
    await field("Allowed environment keys — one per line", "LANG\nNOT VALID");
    await click("Review MCP changes");
    await click("Save reviewed MCP configuration");
    expect(api.updateMcpServer).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Environment keys");
  });
  it("reviews and cancels without writes, then saves exact fields with owner CAS and preserves credentials", async () => {
    await render();
    await typeLabel("Reviewed server");
    await click("Review MCP changes");
    expect(container.textContent).toContain("close its current connections");
    await click("Cancel review");
    expect(api.updateMcpServer).not.toHaveBeenCalled();
    await click("Review MCP changes");
    await click("Save reviewed MCP configuration");
    expect(api.updateMcpServer).toHaveBeenCalledExactlyOnceWith("mcp-editor", {
      expectedRevision: "a".repeat(64),
      label: "Reviewed server",
      command: "node",
      url: undefined,
      enabled: false,
      category: "development",
    });
    expect(saved.args).toEqual(["--credential", "[REDACTED]"]);
    expect(container.textContent).toContain("MCP server updated.");
    expect(container.textContent).not.toContain("Unsaved MCP server draft");
  });
  it("retains edited fields across owner conflict and requires a separate current review before saving", async () => {
    await render();
    await typeLabel("Retained draft");
    await click("Review MCP changes");
    saved = { ...saved, label: "Peer label", revision: "c".repeat(64) };
    await click("Save reviewed MCP configuration");
    await vi.waitFor(() => expect(container.textContent).toContain("Peer label"));
    expect(api.updateMcpServer).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Unsaved MCP server draft");
    await click("Use current server review");
    expect(api.updateMcpServer).not.toHaveBeenCalled();
    await click("Review MCP changes");
    await click("Save reviewed MCP configuration");
    expect(api.updateMcpServer).toHaveBeenCalledExactlyOnceWith(
      "mcp-editor",
      expect.objectContaining({ label: "Retained draft", expectedRevision: "c".repeat(64) }),
    );
  });
  it("retains an unknown outcome across editor remount and prevents repeat save", async () => {
    await render();
    await typeLabel("Uncertain draft");
    await click("Review MCP changes");
    api.updateMcpServer.mockRejectedValueOnce(new Error("Lost response"));
    await click("Save reviewed MCP configuration");
    expect(container.textContent).toContain("MCP save outcome is unconfirmed");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(button("Review MCP changes").disabled).toBe(true);
    expect(api.updateMcpServer).toHaveBeenCalledTimes(1);
  });
  it("cancels dispatch if the editor unmounts during the fresh owner read", async () => {
    await render();
    await typeLabel("Abandoned draft");
    await click("Review MCP changes");
    const pending = deferred<McpServerRecord>();
    api.fetchMcpServer.mockReturnValueOnce(pending.promise);
    await click("Save reviewed MCP configuration");
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => pending.resolve(saved));
    expect(api.updateMcpServer).not.toHaveBeenCalled();
  });
  it("keeps or discards a dirty draft only through the leave decision", async () => {
    await render();
    await typeLabel("Kept draft");
    await click("Close editor");
    expect(close).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
    expect(button("Save and continue")).toBeUndefined();
    expect(container.textContent).toContain("review the exact fields in the editor");
    expect(api.updateMcpServer).not.toHaveBeenCalled();
    await click("Keep draft and close");
    expect(close).toHaveBeenCalledTimes(1);
    expect(api.updateMcpServer).not.toHaveBeenCalled();
  });
});
