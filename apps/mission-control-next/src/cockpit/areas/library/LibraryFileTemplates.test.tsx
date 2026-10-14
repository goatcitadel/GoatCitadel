// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createFileFromTemplate,
  fetchFileTemplates,
  type FileTemplate,
} from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import {
  getGatewayCallerScope,
  setGatewayCallerScope,
  notifyGatewayAccessChanged,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { LibraryFileTemplates } from "./LibraryFileTemplates";
vi.mock("@goatcitadel/mission-control-shared/api/operators-agents-files", () => ({
  fetchFileTemplates: vi.fn(),
  createFileFromTemplate: vi.fn(),
}));
const template: FileTemplate = {
  templateId: "brief",
  title: "Research brief",
  description: "A research note with provenance.",
  defaultPath: "docs/research-brief-2026-10-14.md",
  body: "# Research\n{date}",
};
let root: Root,
  container: HTMLDivElement,
  client: QueryClient,
  caller: string,
  originalHref: string,
  originalState: unknown;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  vi.resetAllMocks();
  __resetApprovalOperationAttemptsForTests();
  __resetSessionDraftsForTests();
  caller = getGatewayCallerScope();
  setGatewayCallerScope("template-operator-a");
  originalHref = window.location.pathname + window.location.search + window.location.hash;
  originalState = window.history.state;
  window.history.replaceState(
    { retained: "template-evidence" },
    "",
    "/library/files?workspaceId=one&citadelId=personal&runId=retained&sessionId=original&keep=yes&shell=cockpit&shellScope=visit#files",
  );
  // Happy DOM queues hashchange for replaceState; settle fixture navigation before subscribing.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchFileTemplates).mockResolvedValue({ items: [{ ...template }] });
  vi.mocked(createFileFromTemplate).mockResolvedValue({
    relativePath: "proof.md",
    fullPath: "private-path",
    bytes: 27,
  });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  setGatewayCallerScope(caller);
  window.history.replaceState(originalState, "", originalHref);
});
async function render(workspaceId = "one", citadelId = "personal") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LibraryFileTemplates workspaceId={workspaceId} citadelId={citadelId} />
      </QueryClientProvider>,
    ),
  );
}
const visible = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].filter((node) => !node.closest('[aria-hidden="true"]'));
const button = (label: string) =>
  visible().find((node) => (node.getAttribute("aria-label") ?? node.textContent?.trim()) === label)!;
async function click(label: string) {
  expect(button(label)).toBeTruthy();
  await act(async () => button(label).click());
}
async function changePath(path: string) {
  const input = container.querySelector<HTMLInputElement>('section[aria-label="File from template"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, path);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function openReview(path = "proof.md") {
  await render();
  await click("Create from template");
  await vi.waitFor(() => expect(container.textContent).toContain("A research note with provenance."));
  await changePath(path);
  await click("Review template file");
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Target: " + path));
}

it("reads templates only after explicit opening and Cancel has no file mutation", async () => {
  await render();
  expect(fetchFileTemplates).not.toHaveBeenCalled();
  await click("Create from template");
  await vi.waitFor(() => expect(container.textContent).toContain(template.description));
  expect(fetchFileTemplates).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("installation shared file root");
  await changePath("proof.md");
  await click("Review template file");
  await click("Cancel creation");
  expect(createFileFromTemplate).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("proof.md");
});
it("re-reads the exact immutable template and creates once with a distinct canonical receipt", async () => {
  await openReview();
  await click("Create reviewed file");
  await vi.waitFor(() =>
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Gateway accepted proof.md (27 bytes)"),
  );
  expect(fetchFileTemplates).toHaveBeenCalledTimes(2);
  expect(createFileFromTemplate).toHaveBeenCalledExactlyOnceWith("brief", "proof.md");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("private-path");
  expect(button("Create reviewed file").disabled).toBe(true);
  await click("Create reviewed file");
  expect(createFileFromTemplate).toHaveBeenCalledOnce();
});
it("uses the reviewed current Gateway default path without inventing a workspace file root", async () => {
  await render();
  await click("Create from template");
  await vi.waitFor(() => expect(container.textContent).toContain(template.description));
  vi.mocked(createFileFromTemplate).mockResolvedValue({
    relativePath: template.defaultPath,
    fullPath: "private",
    bytes: 27,
  });
  await click("Review template file");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(template.defaultPath);
  await click("Create reviewed file");
  await vi.waitFor(() => expect(createFileFromTemplate).toHaveBeenCalledExactlyOnceWith("brief", template.defaultPath));
});
it.each(["changed", "missing", "forbidden"])(
  "submits no file creation after a %s canonical template preflight",
  async (condition) => {
    await openReview();
    if (condition === "changed")
      vi.mocked(fetchFileTemplates).mockResolvedValueOnce({
        items: [{ ...template, body: "Changed source body" }],
      });
    if (condition === "missing") vi.mocked(fetchFileTemplates).mockResolvedValueOnce({ items: [] });
    if (condition === "forbidden")
      vi.mocked(fetchFileTemplates).mockRejectedValueOnce(
        new ApiRequestError("Not permitted", {
          kind: "http",
          method: "GET",
          path: "/api/v1/files/templates",
          status: 403,
        }),
      );
    await click("Create reviewed file");
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull());
    expect(createFileFromTemplate).not.toHaveBeenCalled();
    await click("Cancel creation");
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("proof.md");
  },
);
it.each(["workspace", "citadel", "caller-aba", "access", "history-aba", "unmount"])(
  "rejects a held preflight across %s departure before POST",
  async (departure) => {
    await openReview();
    const pending = deferred<{ items: FileTemplate[] }>();
    vi.mocked(fetchFileTemplates).mockReturnValueOnce(pending.promise);
    await click("Create reviewed file");
    expect(createFileFromTemplate).not.toHaveBeenCalled();
    if (departure === "workspace") await render("two");
    if (departure === "citadel") await render("one", "elsewhere");
    if (departure === "caller-aba")
      await act(async () => {
        setGatewayCallerScope("template-operator-b");
        setGatewayCallerScope("template-operator-a");
      });
    if (departure === "access") await act(async () => notifyGatewayAccessChanged());
    if (departure === "history-aba")
      await act(async () => {
        const href = window.location.href;
        const state = window.history.state;
        window.history.replaceState(state, "", "/library/files?workspaceId=other#files");
        window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
        window.history.replaceState(state, "", href);
        window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
        expect(window.location.href).toBe(href);
      });
    if (departure === "unmount") await act(async () => root.render(null));
    await act(async () => pending.resolve({ items: [{ ...template }] }));
    expect(createFileFromTemplate).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  },
);
it("retains the original draft and unknown lock across Close, caller ABA and remount without replay", async () => {
  vi.mocked(createFileFromTemplate).mockRejectedValue(new Error("Response lost"));
  await openReview();
  await click("Create reviewed file");
  await vi.waitFor(() => expect(container.textContent).toContain("request outcome is uncertain"));
  expect(createFileFromTemplate).toHaveBeenCalledOnce();
  await click("Cancel creation");
  await click("Close template editor");
  await act(async () => {
    setGatewayCallerScope("template-operator-b");
    setGatewayCallerScope("template-operator-a");
  });
  await act(async () => root.render(null));
  await render();
  await click("Create from template");
  await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("proof.md"));
  expect(button("Review template file").disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
  expect(button("Discard template draft").disabled).toBe(true);
  const inspect = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
    (link) => link.textContent === "Inspect current files",
  )!;
  const destination = new URL(inspect.href);
  expect(destination.pathname).toBe("/library/files");
  expect(destination.searchParams.get("workspaceId")).toBe("one");
  expect(destination.searchParams.get("citadelId")).toBe("personal");
  expect(destination.searchParams.get("runId")).toBe("retained");
  expect(destination.searchParams.get("sessionId")).toBe("original");
  expect(destination.searchParams.get("keep")).toBe("yes");
  expect(destination.searchParams.has("shellScope")).toBe(false);
  expect(destination.hash).toBe("#files");
  await click("Review template file");
  expect(createFileFromTemplate).toHaveBeenCalledOnce();
});
it("withholds success after a mismatched receipt and keeps the original attempt locked", async () => {
  vi.mocked(createFileFromTemplate).mockResolvedValue({
    relativePath: "different.md",
    fullPath: "private",
    bytes: 27,
  });
  await openReview();
  await click("Create reviewed file");
  await vi.waitFor(() => expect(container.textContent).toContain("request outcome is uncertain"));
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Gateway accepted");
  expect(createFileFromTemplate).toHaveBeenCalledOnce();
});
