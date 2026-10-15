import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchFilesList, uploadFile } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { LibraryFileUpload } from "./LibraryFileUpload";
vi.mock("@goatcitadel/mission-control-shared/api/operators-agents-files", () => ({
  fetchFilesList: vi.fn(),
  uploadFile: vi.fn(),
}));
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  __resetApprovalOperationAttemptsForTests();
  __resetSessionViewStateForTests();
  __resetSessionDraftsForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchFilesList).mockResolvedValue({ items: [] });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});
async function click(name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => !node.closest('[aria-hidden="true"]') && (node.getAttribute("aria-label") ?? node.textContent) === name,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function setup(path = "proof.txt") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LibraryFileUpload workspaceId="one" citadelId="personal" />
      </QueryClientProvider>,
    ),
  );
  for (const [selector, value] of [
    ["input", path],
    ["textarea", "proof"],
  ]) {
    const input = container.querySelector(selector!)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        selector === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await click("Review upload");
  await vi.waitFor(() => {
    expect(fetchFilesList).toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Checking");
  });
}
const cta = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((node) => node.textContent === name);
it("retains a successful owner receipt inside the actual portal after query invalidation settles", async () => {
  vi.mocked(uploadFile).mockResolvedValue({ relativePath: "proof.txt", fullPath: "private", bytes: 5 });
  await setup();
  await click("Upload file");
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["library", "resources", "files"] });
  });
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.closest('[aria-hidden="true"]')).toBeNull();
  expect(dialog.textContent).toContain("Gateway accepted proof.txt (5 bytes)");
  expect(dialog.textContent).not.toContain("private");
  expect(uploadFile).toHaveBeenCalledExactlyOnceWith("proof.txt", "proof");
  await click("Upload file");
  expect(uploadFile).toHaveBeenCalledTimes(1);
});
it("keeps uncertainty accessible and retains the draft on a failed write", async () => {
  vi.mocked(uploadFile).mockRejectedValue(new Error("Connection lost"));
  await setup();
  await click("Upload file");
  await act(async () => {
    await client.invalidateQueries();
  });
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("upload is not confirmed");
  await click("Close dialog");
  expect(container.querySelector("textarea")?.value).toBe("proof");
});
it("closing review does not upload", async () => {
  await setup();
  await click("Close dialog");
  expect(uploadFile).not.toHaveBeenCalled();
});
it("checks the reviewed path and offers a primary upload when no file exists there", async () => {
  vi.mocked(fetchFilesList).mockResolvedValue({
    items: [{ relativePath: "nested/proof.txt", size: 10, modifiedAt: "2026-01-01T00:00:00Z" }],
  });
  await setup("notes/proof.txt");
  expect(fetchFilesList).toHaveBeenCalledExactlyOnceWith("notes", 1000);
  expect(cta("Upload file")?.className).toContain("bg-accent");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("may replace");
});
it("names the replaced file with its size and date and makes the replace explicit", async () => {
  const modifiedAt = "2026-01-01T00:00:00Z";
  vi.mocked(fetchFilesList).mockResolvedValue({ items: [{ relativePath: "proof.txt", size: 2048, modifiedAt }] });
  await setup();
  expect(fetchFilesList).toHaveBeenCalledExactlyOnceWith(".", 1000);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    `This replaces proof.txt (2.0 KB, modified ${new Date(modifiedAt).toLocaleString()}).`,
  );
  expect(cta("Replace file")?.className).toContain("border-status-failed");
  expect(cta("Upload file")).toBeUndefined();
});
it("keeps the cautious wording when the file check cannot run or is still running", async () => {
  vi.mocked(fetchFilesList).mockReturnValue(new Promise(() => undefined));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <LibraryFileUpload workspaceId="one" citadelId="personal" />
      </QueryClientProvider>,
    ),
  );
  for (const [selector, value] of [
    ["input", "proof.txt"],
    ["textarea", "proof"],
  ]) {
    const input = container.querySelector(selector!)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        selector === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await click("Review upload");
  expect(cta("Checking file…")?.getAttribute("aria-busy")).toBe("true");
  await click("Checking file…");
  expect(uploadFile).not.toHaveBeenCalled();
  await click("Close dialog");
  client.removeQueries({ queryKey: ["library", "file-upload-target"] });
  vi.mocked(fetchFilesList).mockRejectedValue(new Error("offline"));
  await click("Review upload");
  await vi.waitFor(() =>
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("The file check could not run."),
  );
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("may replace existing content");
  expect(cta("Upload or replace file")?.className).toContain("border-status-failed");
});
