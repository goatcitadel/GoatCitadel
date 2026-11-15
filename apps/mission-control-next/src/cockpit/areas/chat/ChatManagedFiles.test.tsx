// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatApprovalModeState, ManagedProjectFileRevision } from "@goatcitadel/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatManagedFiles } from "./ChatManagedFiles";
import * as api from "@goatcitadel/mission-control-shared/api/chat-managed-files";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";

let access: { data?: { actorSource: string } } = { data: { actorSource: "none" } };
vi.mock("../../../app/use-current-access", () => ({ useCurrentAccess: () => access }));

vi.mock("@goatcitadel/mission-control-shared/api/chat-managed-files", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  downloadChatManagedFile: vi.fn(),
  fetchChatApprovalMode: vi.fn(),
  fetchChatManagedFiles: vi.fn(),
  publishChatManagedFile: vi.fn(),
  restoreChatManagedFile: vi.fn(),
  updateChatApprovalMode: vi.fn(),
}));

const mode: ChatApprovalModeState = {
  mode: "auto",
  modeRevision: "mode-revision",
  autoAvailable: true,
  workspaceId: "workspace",
  projectId: "project",
};
const file: ManagedProjectFileRevision = {
  workspaceId: "workspace",
  projectId: "project",
  path: "notes/brief.txt",
  revisionId: "latest",
  previousRevisionId: "prior",
  contentSha256: "a".repeat(64),
  byteLength: 5,
  deleted: false,
  canRestore: true,
};

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

const forbidden = new ApiRequestError("API error 403", {
  kind: "http",
  method: "GET",
  path: "/api/v1/chat/sessions/session/approval-mode",
  status: 403,
});

beforeEach(() => {
  access = { data: { actorSource: "none" } };
  vi.resetAllMocks();
  vi.mocked(api.fetchChatApprovalMode).mockResolvedValue(mode);
  vi.mocked(api.fetchChatManagedFiles).mockResolvedValue({ items: [file] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.restoreAllMocks();
});

async function render(sessionId = "session", turnId?: string) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ChatManagedFiles
          sessionId={sessionId}
          workspaceId="workspace"
          projectId="project"
          projectName="Launch"
          canMutate
          turnId={turnId}
          turnActive={false}
        />
      </QueryClientProvider>,
    ),
  );
}

function button(name: string) {
  return Array.from(document.body.querySelectorAll("button")).find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === name,
  );
}

async function click(name: string) {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(button(name)?.disabled, name).toBe(false);
  });
  await act(async () => button(name)!.click());
}

it("opts in with the current mode revision and names the managed destination", async () => {
  vi.mocked(api.fetchChatApprovalMode).mockResolvedValueOnce({ ...mode, mode: "standard" });
  vi.mocked(api.updateChatApprovalMode).mockResolvedValue(mode);
  await render();
  expect(button("Managed files")).toBeUndefined();
  await click("Use Auto mode");
  expect(api.updateChatApprovalMode).toHaveBeenCalledWith(
    "session",
    { mode: "auto", expectedModeRevision: mode.modeRevision },
    expect.any(AbortSignal),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("the managed workspace for Launch"));
});

it("publishes an existing destination only after explicit overwrite confirmation", async () => {
  vi.mocked(api.fetchChatManagedFiles).mockResolvedValue({ items: [file], publishAvailable: true });
  vi.mocked(api.publishChatManagedFile)
    .mockResolvedValueOnce({ status: "overwrite_required", path: file.path, overwriteRevision: "first-review" })
    .mockResolvedValueOnce({ status: "overwrite_required", path: file.path, overwriteRevision: "fresh-review" })
    .mockResolvedValueOnce({ status: "published", path: file.path, contentSha256: file.contentSha256! });
  await render();
  await click("Managed files");
  await click("Publish notes/brief.txt");
  await click("Cancel");
  expect(api.publishChatManagedFile).toHaveBeenCalledTimes(1);
  expect(button("Overwrite and publish")).toBeUndefined();
  await click("Publish notes/brief.txt");
  await click("Overwrite and publish");
  expect(api.publishChatManagedFile).toHaveBeenNthCalledWith(
    3,
    "session",
    {
      path: file.path,
      expectedRevision: file.revisionId,
      expectedModeRevision: mode.modeRevision,
      overwriteRevision: "fresh-review",
    },
    expect.any(AbortSignal),
  );
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Published notes/brief.txt to the original project folder."),
  );
});

it("restores only the eligible head and refreshes after a conflict or new turn", async () => {
  const fresh = { ...file, path: "new.txt", revisionId: "new", canRestore: false };
  vi.mocked(api.fetchChatManagedFiles).mockResolvedValue({ items: [file, fresh, { ...file, projectId: "other" }] });
  vi.mocked(api.restoreChatManagedFile).mockRejectedValue(new Error("Conflict"));
  await render("session", "turn-one");
  await click("Managed files");
  await vi.waitFor(() => expect(button("Download new.txt")).toBeTruthy());
  expect(button("Restore previous version of new.txt")).toBeUndefined();
  await click("Restore previous version of notes/brief.txt");
  expect(api.restoreChatManagedFile).toHaveBeenCalledWith(
    "session",
    {
      path: file.path,
      expectedRevision: file.revisionId,
      expectedModeRevision: mode.modeRevision,
    },
    expect.any(AbortSignal),
  );
  await vi.waitFor(() =>
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("may have changed"),
  );
  vi.mocked(api.fetchChatManagedFiles).mockClear();
  await render("session", "turn-two");
  await vi.waitFor(() => expect(api.fetchChatManagedFiles).toHaveBeenCalled());
});

it("ignores a download completing after navigation to another session", async () => {
  let finish!: (bytes: Blob) => void;
  vi.mocked(api.downloadChatManagedFile).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  await render();
  await click("Managed files");
  await click("Download notes/brief.txt");
  const signal = vi.mocked(api.downloadChatManagedFile).mock.calls[0]![2];
  await render("other-session");
  expect(signal.aborted).toBe(true);
  await act(async () => finish(new Blob(["bytes"])));
  expect(download).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Downloaded");
});

it("confirms a successful restore and removes the restore action after the list refreshes", async () => {
  const restored = {
    ...file,
    revisionId: "restored",
    previousRevisionId: file.revisionId,
    canRestore: false,
    replayed: false,
  };
  vi.mocked(api.restoreChatManagedFile).mockImplementation(async () => {
    vi.mocked(api.fetchChatManagedFiles).mockResolvedValue({ items: [restored] });
    return restored;
  });
  await render();
  await click("Managed files");
  await click("Restore previous version of notes/brief.txt");
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Restored the previous version of notes/brief.txt.");
    expect(button("Restore previous version of notes/brief.txt")).toBeUndefined();
  });
  expect(api.restoreChatManagedFile).toHaveBeenCalledOnce();
});

it("finds a saved file outside the initial page by its scoped path", async () => {
  vi.mocked(api.fetchChatManagedFiles).mockImplementation(async (_session, options) => ({
    items: options?.prefix === "notes" ? [file] : [],
  }));
  await render();
  await click("Managed files");
  const input = document.body.querySelector<HTMLInputElement>("input")!;
  expect(input.labels?.[0]?.textContent).toBe("File or folder path");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "notes/");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Find files");
  await vi.waitFor(() => expect(button("Download notes/brief.txt")).toBeTruthy());
  expect(api.fetchChatManagedFiles).toHaveBeenCalledWith("session", {
    prefix: "notes",
    signal: expect.any(AbortSignal),
  });
});

it("offers retry after the first approval mode read fails and only exposes matching controls", async () => {
  vi.mocked(api.fetchChatApprovalMode).mockRejectedValueOnce(new Error("temporary Gateway failure"));
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Approval mode unavailable"));
  expect(button("Use Auto mode")).toBeUndefined();
  expect(button("Managed files")).toBeUndefined();
  await click("Retry");
  await vi.waitFor(() => expect(button("Managed files")).toBeDefined());
  expect(api.fetchChatApprovalMode).toHaveBeenCalledTimes(2);
});

it("says Auto mode needs sign-in, links to Settings › Access and offers no Retry when sign-in is off", async () => {
  vi.mocked(api.fetchChatApprovalMode).mockRejectedValue(forbidden);
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      "Auto mode and Managed files need sign-in. Set up sign-in in Settings › Access to use them in project conversations.",
    ),
  );
  expect(container.querySelector('a[href="/settings/access?shell=cockpit#device-access"]')?.textContent).toBe(
    "Set up sign-in",
  );
  expect(button("Retry")).toBeUndefined();
  expect(container.textContent).not.toContain("Approval mode unavailable");
});

it("names a local signed-in connection, not sign-in, when the caller is signed in but not local", async () => {
  access = { data: { actorSource: "token" } };
  vi.mocked(api.fetchChatApprovalMode).mockRejectedValue(forbidden);
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain(
      "Auto mode and Managed files work only from a signed-in browser on the computer that runs GoatCitadel.",
    ),
  );
  expect(container.querySelector('a[href="/settings/access?shell=cockpit#device-access"]')?.textContent).toBe(
    "Review access",
  );
  expect(button("Retry")).toBeUndefined();
});
