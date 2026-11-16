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
    expect(host.querySelector('[aria-busy="true"]')?.textContent).toContain("Loading answer controls");
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

function blockerProps(pendingUserInput: ChatUserInputPromptRecord | null) {
  return {
    pendingApproval: null,
    pendingUserInput,
    selectedSessionId: "conversation-skip",
    approvalPending: false,
    userInputPending: false,
    onApprovePending: vi.fn(),
    onDenyPending: vi.fn(),
    onSubmitUserInput: vi.fn(),
    onRefreshThread: vi.fn(),
  };
}

async function renderSkippable(prompt: ChatUserInputPromptRecord) {
  questionCode.release();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatBlockers props={blockerProps(prompt)} />
      </QueryClientProvider>,
    ),
  );
  const cleanup = async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  };
  return { host, cleanup };
}

function press(host: HTMLElement, name: string) {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === name);
  expect(button, name).toBeDefined();
  return act(async () => button!.click());
}

it("replaces a skipped optional question with a line you can undo, and nothing is sent", async () => {
  const prompt: ChatUserInputPromptRecord = {
    promptId: "prompt-skip",
    turnId: "turn-a",
    kind: "text",
    title: "Pick a name",
    question: "What name?",
    required: false,
    delivery: "background",
  };
  const { host, cleanup } = await renderSkippable(prompt);
  try {
    await vi.waitFor(() => expect(host.querySelector('form[aria-label="Pending question"]')).not.toBeNull());
    await press(host, "Skip question");
    expect(host.querySelector("form")).toBeNull();
    expect(host.textContent).toContain("You skipped “Pick a name”. The work goes on without your answer.");
    await press(host, "Show the question again");
    await vi.waitFor(() => expect(host.querySelector('form[aria-label="Pending question"]')).not.toBeNull());
    expect(host.textContent).not.toContain("You skipped");
  } finally {
    await cleanup();
  }
});

it("offers no skip for a question that holds the turn", async () => {
  const prompt: ChatUserInputPromptRecord = {
    promptId: "prompt-hold",
    turnId: "turn-a",
    kind: "text",
    title: "Pick",
    question: "Which?",
    required: true,
  };
  const { host, cleanup } = await renderSkippable(prompt);
  try {
    await vi.waitFor(() => expect(host.querySelector('form[aria-label="Pending question"]')).not.toBeNull());
    expect(host.textContent).not.toContain("Skip question");
  } finally {
    await cleanup();
  }
});
