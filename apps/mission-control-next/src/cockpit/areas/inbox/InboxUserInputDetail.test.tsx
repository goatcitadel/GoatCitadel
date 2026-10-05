// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ChatThreadResponse,
  ChatUserInputPromptRecord,
  OperatorInboxItem,
  OperatorInboxResponse,
} from "@goatcitadel/contracts";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxUserInputDetail } from "./InboxUserInputDetail";
import { queryKeys } from "../../data/query-keys";

const api = vi.hoisted(() => ({
  fetchOperatorInbox: vi.fn(),
  fetchChatThread: vi.fn(),
  answerChatUserInputPrompt: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({
  fetchOperatorInbox: api.fetchOperatorInbox,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  fetchChatThread: api.fetchChatThread,
  answerChatUserInputPrompt: api.answerChatUserInputPrompt,
}));

const item: OperatorInboxItem = {
  id: "user_input:prompt-a",
  kind: "user_input",
  group: "needs_decision",
  title: "Choose a route",
  summary: "Which route should run?",
  createdAt: "2026-09-28T00:00:00Z",
  source: { workspaceId: "default", sessionId: "session-a", turnId: "turn-a", promptId: "prompt-a" },
  href: "/chat?sessionId=session-a&shell=classic",
};
const prompt: ChatUserInputPromptRecord = {
  promptId: "prompt-a",
  turnId: "turn-a",
  kind: "single_select",
  required: true,
  title: "Choose a route",
  question: "Which route should run?",
  options: [{ optionId: "safe", label: "Safe path", description: "Use the reviewed route." }],
};
const projection: OperatorInboxResponse = {
  authority: "derived_projection",
  workspaceId: "default",
  generatedAt: "2026-09-28T00:00:00Z",
  items: [item],
  coverage: [],
  counts: {
    needs_decision: { known: 1, complete: true },
    proposals: { known: 0, complete: true },
    needs_attention: { known: 0, complete: false },
    updates: { known: 0, complete: false },
  },
};

function threadWith(currentPrompt: ChatUserInputPromptRecord): ChatThreadResponse {
  return {
    sessionId: "session-a",
    activeLeafTurnId: "turn-a",
    turns: [
      {
        turnId: "turn-a",
        trace: {
          sessionId: "session-a",
          status: "waiting_for_user_input",
          pendingUserInput: currentPrompt,
        },
      },
    ],
  } as unknown as ChatThreadResponse;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchOperatorInbox.mockResolvedValue(projection);
  api.fetchChatThread.mockResolvedValue(threadWith(prompt));
  api.answerChatUserInputPrompt.mockResolvedValue({
    ok: true,
    sessionId: "session-a",
    turnId: "turn-a",
    promptId: "prompt-a",
    resumed: true,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The Inbox area keeps the Inbox cached; seed it from the mocked owner read, then forget that read. */
async function seedCachedInbox(client: QueryClient) {
  client.setQueryData(queryKeys.inbox("default"), await api.fetchOperatorInbox("default"));
  api.fetchOperatorInbox.mockClear();
}

async function renderDetail(inboxItem = item) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await seedCachedInbox(client);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <UiPreferencesProvider>
          <InboxUserInputDetail item={inboxItem} workspaceId="default" />
        </UiPreferencesProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    if (api.fetchChatThread.mock.results[0]) await api.fetchChatThread.mock.results[0].value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`Missing ${label} button: ${document.body.textContent}`);
  return found;
}

describe("Inbox Chat question", () => {
  it("reviews a choice, re-reads both owners, then submits the exact answer once", async () => {
    await renderDetail();
    // Opening checks the cached Inbox; only the answer re-reads it.
    expect(api.fetchOperatorInbox).not.toHaveBeenCalled();
    const radio = container.querySelector<HTMLInputElement>('input[type="radio"]');
    if (!radio) throw new Error("Missing option");
    await act(async () => radio.click());
    await act(async () => button("Review answer").click());
    expect(document.body.textContent).toContain("Safe path");
    expect(api.answerChatUserInputPrompt).not.toHaveBeenCalled();
    await act(async () => button("Confirm answer").click());
    expect(api.fetchOperatorInbox).toHaveBeenCalledTimes(1);
    expect(api.fetchChatThread).toHaveBeenCalledTimes(2);
    expect(api.answerChatUserInputPrompt).toHaveBeenCalledOnce();
    expect(api.answerChatUserInputPrompt).toHaveBeenCalledWith("session-a", "turn-a", "prompt-a", {
      response: { kind: "single_select", optionId: "safe" },
    });
    expect(container.textContent).toContain("Gateway accepted the answer");
  });

  it("submits trimmed free text through the same guarded owner endpoint", async () => {
    api.fetchChatThread.mockResolvedValue(threadWith({ ...prompt, kind: "text", options: undefined }));
    await renderDetail();
    const input = container.querySelector<HTMLInputElement>('input[type="text"]');
    if (!input) throw new Error("Missing answer field");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "  Use the safe route  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Review answer").click());
    await act(async () => button("Confirm answer").click());
    expect(api.answerChatUserInputPrompt).toHaveBeenCalledWith("session-a", "turn-a", "prompt-a", {
      response: { kind: "text", text: "Use the safe route" },
    });
  });

  it("refuses a changed question after review", async () => {
    api.fetchChatThread
      .mockResolvedValueOnce(threadWith(prompt))
      .mockResolvedValueOnce(threadWith({ ...prompt, question: "Choose a different route" }));
    await renderDetail();
    const radio = container.querySelector<HTMLInputElement>('input[type="radio"]');
    if (!radio) throw new Error("Missing option");
    await act(async () => radio.click());
    await act(async () => button("Review answer").click());
    await act(async () => button("Confirm answer").click());
    expect(api.answerChatUserInputPrompt).not.toHaveBeenCalled();
    expect(container.textContent).toContain("The question changed or is no longer waiting");
  });

  it("never reads a thread or offers action for a foreign Inbox projection", async () => {
    api.fetchOperatorInbox.mockResolvedValue({ ...projection, workspaceId: "other" });
    await renderDetail();
    expect(api.fetchChatThread).not.toHaveBeenCalled();
    expect(container.textContent).toContain("no longer waiting in the selected workspace");
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "Review answer")).toBe(
      false,
    );
  });

  it("does not offer an expired question as a current action", async () => {
    const expiredAt = "2026-01-01T00:00:00.000Z";
    api.fetchOperatorInbox.mockResolvedValue({ ...projection, items: [{ ...item, expiresAt: expiredAt }] });
    api.fetchChatThread.mockResolvedValue(threadWith({ ...prompt, expiresAt: expiredAt }));
    await renderDetail({ ...item, expiresAt: expiredAt });
    expect(container.textContent).toContain("no longer waiting in the selected workspace");
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "Review answer")).toBe(
      false,
    );
  });

  it("keeps secure configuration in Chat", async () => {
    api.fetchChatThread.mockResolvedValue(
      threadWith({
        ...prompt,
        kind: "text",
        options: undefined,
        secureConfiguration: {
          targetId: "provider-a",
          targetLabel: "Provider",
          secretFieldLabel: "Key",
          storage: "os_keychain",
          scope: "installation",
          verification: "live_probe",
        },
      }),
    );
    await renderDetail();
    expect(container.textContent).toContain("Open Chat to enter it through the existing secure flow");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "Review answer")).toBe(
      false,
    );
  });

  it("locks another answer after an uncertain request outcome", async () => {
    api.answerChatUserInputPrompt.mockRejectedValue(new Error("Connection lost"));
    await renderDetail();
    const radio = container.querySelector<HTMLInputElement>('input[type="radio"]');
    if (!radio) throw new Error("Missing option");
    await act(async () => radio.click());
    await act(async () => button("Review answer").click());
    await act(async () => button("Confirm answer").click());
    expect(api.answerChatUserInputPrompt).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Answer outcome is uncertain");
    expect([...container.querySelectorAll("button")].some((entry) => entry.textContent === "Review answer")).toBe(
      false,
    );
  });

  it("keeps the answer form while the question is rechecked", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await seedCachedInbox(client);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <UiPreferencesProvider>
            <InboxUserInputDetail item={item} workspaceId="default" />
          </UiPreferencesProvider>
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.querySelector('input[type="radio"]')).not.toBeNull());
    let release!: () => void;
    api.fetchChatThread.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(threadWith(prompt));
        }),
    );
    await act(async () => {
      void client.invalidateQueries();
      // Query status reaches React on a zero-delay timer; let it fire inside act.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Checking for changes…");
    expect(container.querySelector('input[type="radio"]')).not.toBeNull();
    await act(async () => release());
    await vi.waitFor(() => expect(container.textContent).not.toContain("Checking for changes…"));
  });
});
