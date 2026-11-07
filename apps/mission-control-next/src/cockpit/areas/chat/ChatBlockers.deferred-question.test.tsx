// @vitest-environment happy-dom
import type { ChatUserInputPromptRecord } from "@goatcitadel/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { refuseNetwork } from "../../../test/refuse-network";
import { ChatBlockers } from "./ChatBlockers";

const questionCode = vi.hoisted(() => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started: vi.fn(), held, release };
});
vi.mock("./ChatPendingQuestion", async (importOriginal) => {
  questionCode.started();
  await questionCode.held;
  return importOriginal();
});
refuseNetwork();

it("shows the question immediately and never mounts an answer form for a retired prompt", async () => {
  const prompt: ChatUserInputPromptRecord = {
    promptId: "prompt-a",
    turnId: "turn-a",
    kind: "text",
    title: "Choose a path",
    question: "Which path?",
    required: true,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const submit = vi.fn();
  const render = (pendingUserInput: ChatUserInputPromptRecord | null, selectedSessionId = "conversation-a") =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ChatBlockers
            props={{
              pendingApproval: null,
              pendingUserInput,
              selectedSessionId,
              approvalPending: false,
              userInputPending: false,
              onApprovePending: vi.fn(),
              onDenyPending: vi.fn(),
              onSubmitUserInput: submit,
              onRefreshThread: vi.fn(),
            }}
          />
        </QueryClientProvider>,
      ),
    );
  const form = () => host.querySelector('form[aria-label="Pending question"]');
  try {
    await render(null);
    expect(questionCode.started).not.toHaveBeenCalled();
    await render(prompt);
    await vi.waitFor(() => expect(questionCode.started).toHaveBeenCalledOnce());
    expect(host.textContent).toContain(prompt.question);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading answer controls");
    expect(form()).toBeNull();

    await render(null, "conversation-b");
    await act(async () => {
      questionCode.release();
      await vi.dynamicImportSettled();
    });
    expect(host.textContent).not.toContain(prompt.question);
    expect(form()).toBeNull();
    expect(submit).not.toHaveBeenCalled();

    await render({ ...prompt, question: "Which option now?" }, "conversation-b");
    await vi.waitFor(() => expect(form()?.textContent).toContain("Which option now?"));
    expect(form()?.querySelector("input")?.value).toBe("");
  } finally {
    questionCode.release();
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});
