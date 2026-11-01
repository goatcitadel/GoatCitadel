import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionRequest, ChatCompletionResponse } from "@goatcitadel/contracts";
import { ErrandOverlayError, type ComputerAction, type ErrandTargetInfo } from "@goatcitadel/policy-engine";
import { runErrandLoop, type ErrandLoopDeps } from "./errand-loop.js";

const PNG = Buffer.from("png-bytes");
const PEOPLE_PNG = Buffer.from("people-png");

function target(partial: Partial<ErrandTargetInfo> = {}): ErrandTargetInfo {
  return {
    x: 10,
    y: 10,
    tagName: "BUTTON",
    role: "button",
    text: "Next",
    isPasswordLike: false,
    isOneTimeCode: false,
    isOpaque: false,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    ...partial,
  };
}

function toolReply(name: string, args: unknown, id = "call_1"): ChatCompletionResponse {
  return {
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  };
}

function textReply(text: string): ChatCompletionResponse {
  return { choices: [{ index: 0, message: { role: "assistant", content: text } }] };
}

const click = (about = "Click it", extra: Record<string, unknown> = {}) =>
  toolReply("computer", { actions: [{ type: "click", x: 5, y: 6, button: "left" }], about_to: about, ...extra });

type BeforeAction = (action: ComputerAction, index: number) => Promise<"proceed" | "halt">;

function makeDeps(replies: ChatCompletionResponse[], overrides: Partial<ErrandLoopDeps> = {}) {
  const requests: ChatCompletionRequest[] = [];
  let index = 0;
  const ran: ComputerAction[] = [];
  const browser = {
    captureForModel: vi.fn(async () => PNG),
    captureForPeople: vi.fn(async () => PEOPLE_PNG),
    currentUrl: vi.fn(() => "https://shop.example/cart"),
    describeTarget: vi.fn(async (): Promise<ErrandTargetInfo | null> => target()),
    describeFocused: vi.fn(
      async (): Promise<ErrandTargetInfo | null> => target({ tagName: "INPUT", role: "textbox", text: "" }),
    ),
    runActions: vi.fn(async (actions: ComputerAction[], before: BeforeAction) => {
      let count = 0;
      for (const [i, action] of actions.entries()) {
        if ((await before(action, i)) === "halt") {
          return { ran: count, halted: true };
        }
        ran.push(action);
        count += 1;
      }
      return { ran: count, halted: false };
    }),
    overlay: {} as never,
  };
  const deps: ErrandLoopDeps = {
    callModel: vi.fn(async (request: ChatCompletionRequest) => {
      requests.push(JSON.parse(JSON.stringify({ ...request, signal: undefined })) as ChatCompletionRequest);
      const next = replies[Math.min(index, replies.length - 1)]!;
      index += 1;
      return next;
    }),
    browser,
    requestApproval: vi.fn(async () => "approved" as const),
    waitForHandBack: vi.fn(async () => "resumed" as const),
    onProgress: vi.fn(),
    now: () => 0,
    signal: new AbortController().signal,
    ...overrides,
  };
  return { deps, browser, requests, ran };
}

describe("runErrandLoop", () => {
  it("finishes with the model's text answer", async () => {
    const { deps, requests } = makeDeps([click(), textReply("You have 63% left.")]);
    const outcome = await runErrandLoop(deps, { goal: "check my battery" });
    expect(outcome.status).toBe("done");
    expect(outcome.answer).toBe("You have 63% left.");
    expect(outcome.modelRequests).toBe(2);
    expect(outcome.steps).toBe(1);
    const second = requests[1]!;
    const toolMessage = second.messages.find((message) => message.role === "tool")!;
    const parts = toolMessage.content as Array<Record<string, unknown>>;
    expect(parts.map((part) => part.type)).toEqual(["input_text", "input_image"]);
    expect(String(parts[1]!.image_url)).toMatch(/^data:image\/png;base64,/);
    expect(parts[1]!.detail).toBe("original");
    expect(toolMessage.tool_call_id).toBe("call_1");
    const assistantIndex = second.messages.findIndex((m) => m.role === "assistant");
    expect(second.messages[assistantIndex + 1]!.role).toBe("tool");
    expect(requests[0]).toMatchObject({ providerId: "openai-codex", model: "gpt-6.1-sol", stream: false });
  });

  it("asks before Place your order and continues when approved", async () => {
    const { deps, browser, ran } = makeDeps([click("Place the order"), textReply("ok")]);
    browser.describeTarget.mockResolvedValue(target({ text: "Place your order" }));
    const outcome = await runErrandLoop(deps, { goal: "buy" });
    expect(deps.requestApproval).toHaveBeenCalledTimes(1);
    const input = vi.mocked(deps.requestApproval).mock.calls[0]![0];
    expect(input.category).toBe("spend");
    expect(input.title).toBe('Click "Place your order"');
    expect(input.body).toContain("Place the order");
    expect(input.body).toContain("shop.example");
    expect(input.peopleScreenshotPng).toBe(PEOPLE_PNG);
    expect(ran).toHaveLength(1);
    expect(outcome.status).toBe("done");
  });

  it("stops as declined when the operator says Not now", async () => {
    const { deps, browser, ran } = makeDeps([click()], { requestApproval: vi.fn(async () => "denied" as const) });
    browser.describeTarget.mockResolvedValue(target({ text: "Place your order" }));
    const outcome = await runErrandLoop(deps, { goal: "buy" });
    expect(outcome.status).toBe("declined");
    expect(ran).toHaveLength(0);
  });

  it("maps expired and stopped approvals to their statuses", async () => {
    for (const answer of ["expired", "stopped"] as const) {
      const { deps, browser } = makeDeps([click()], { requestApproval: vi.fn(async () => answer) });
      browser.describeTarget.mockResolvedValue(target({ text: "Place your order" }));
      expect((await runErrandLoop(deps, { goal: "buy" })).status).toBe(answer);
    }
  });

  it("hands over on a password field and resumes after Hand back", async () => {
    const { deps, browser, ran, requests } = makeDeps([click(), textReply("done")]);
    browser.describeTarget.mockResolvedValue(target({ tagName: "INPUT", role: "textbox", isPasswordLike: true }));
    const outcome = await runErrandLoop(deps, { goal: "sign in" });
    expect(deps.waitForHandBack).toHaveBeenCalledWith("sign_in");
    expect(deps.requestApproval).not.toHaveBeenCalled();
    expect(ran).toHaveLength(0);
    expect(outcome.status).toBe("done");
    const toolMessage = requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(JSON.stringify(toolMessage.content)).toContain("operator");
  });

  it("stops when the hand back wait is stopped", async () => {
    const { deps, browser } = makeDeps([click()], { waitForHandBack: vi.fn(async () => "stopped" as const) });
    browser.describeTarget.mockResolvedValue(target({ isPasswordLike: true }));
    expect((await runErrandLoop(deps, { goal: "x" })).status).toBe("stopped");
  });

  it("re-reads the focused field before typing and hands over when a click focused a password field", async () => {
    const batch = toolReply("computer", {
      actions: [
        { type: "click", x: 1, y: 1, button: "left" },
        { type: "type", text: "hunter2" },
      ],
      about_to: "Fill the form",
    });
    const { deps, browser, ran } = makeDeps([batch, textReply("done")]);
    browser.describeTarget.mockResolvedValue(target({ tagName: "LABEL", role: "", text: "Password" }));
    browser.describeFocused.mockResolvedValue(target({ tagName: "INPUT", role: "textbox", isPasswordLike: true }));
    await runErrandLoop(deps, { goal: "x" });
    expect(browser.describeFocused).toHaveBeenCalledTimes(1);
    expect(deps.waitForHandBack).toHaveBeenCalledWith("sign_in");
    expect(ran.map((a) => a.type)).toEqual(["click"]);
  });

  it("reports a malformed arguments error to the model and continues", async () => {
    const { deps, requests } = makeDeps([toolReply("computer", "{not json"), textReply("fine")]);
    const outcome = await runErrandLoop(deps, { goal: "x" });
    expect(outcome.status).toBe("done");
    expect(outcome.steps).toBe(1);
    const toolMessage = requests[1]!.messages.find((m) => m.role === "tool")!;
    const parts = toolMessage.content as Array<Record<string, unknown>>;
    expect(String(parts[0]!.text).toLowerCase()).toContain("json");
    expect(parts[1]!.type).toBe("input_image");
  });

  it("reports action validation errors to the model", async () => {
    const bad = toolReply("computer", { actions: [{ type: "click", x: 9999, y: 1 }], about_to: "x" });
    const { deps, requests, browser } = makeDeps([bad, textReply("fine")]);
    await runErrandLoop(deps, { goal: "x" });
    expect(browser.runActions).not.toHaveBeenCalled();
    const toolMessage = requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(String((toolMessage.content as Array<Record<string, unknown>>)[0]!.text)).toContain("action 1");
  });

  it("stops at 60 steps with status step_limit", async () => {
    const { deps } = makeDeps([click()]);
    const outcome = await runErrandLoop(deps, { goal: "x" });
    expect(outcome.status).toBe("step_limit");
    expect(outcome.steps).toBe(60);
  });

  it("stops at the active time limit", async () => {
    let clock = 0;
    const { deps } = makeDeps([click()], { now: () => (clock += 5 * 60_000) });
    expect((await runErrandLoop(deps, { goal: "x" })).status).toBe("time_limit");
  });

  it("time spent waiting on approval does not count toward 20 minutes", async () => {
    let clock = 0;
    const { deps, browser } = makeDeps([click(), textReply("ok")], {
      now: () => clock,
      requestApproval: vi.fn(async () => {
        clock += 25 * 60_000;
        return "approved" as const;
      }),
    });
    browser.describeTarget.mockResolvedValue(target({ text: "Place your order" }));
    expect((await runErrandLoop(deps, { goal: "buy" })).status).toBe("done");
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const { deps } = makeDeps([click()], { signal: controller.signal });
    vi.mocked(deps.onProgress).mockImplementation(() => controller.abort());
    expect((await runErrandLoop(deps, { goal: "x" })).status).toBe("stopped");
  });

  it("calls afterApprovedAction with a people screenshot after an approved click runs", async () => {
    const order: string[] = [];
    const afterApprovedAction = vi.fn(async (_png: Buffer) => {
      order.push("after");
    });
    const { deps, browser } = makeDeps([click(), textReply("ok")], { afterApprovedAction });
    browser.describeTarget.mockResolvedValue(target({ text: "Place your order" }));
    const original = browser.runActions.getMockImplementation()!;
    browser.runActions.mockImplementation(async (actions: ComputerAction[], before: BeforeAction) =>
      original(actions, async (action, i) => {
        const verdict = await before(action, i);
        if (verdict === "proceed") order.push("run");
        return verdict;
      }),
    );
    await runErrandLoop(deps, { goal: "buy" });
    expect(afterApprovedAction).toHaveBeenCalledWith(PEOPLE_PNG);
    expect(order).toEqual(["run", "after"]);
  });

  it("does not call afterApprovedAction for actions that needed no approval", async () => {
    const afterApprovedAction = vi.fn(async (_png: Buffer) => undefined);
    const { deps } = makeDeps([click(), textReply("ok")], { afterApprovedAction });
    await runErrandLoop(deps, { goal: "x" });
    expect(afterApprovedAction).not.toHaveBeenCalled();
  });

  it("uses the model's declared risk to ask for approval", async () => {
    const { deps } = makeDeps([click("Send it", { risk: "send" }), textReply("ok")]);
    await runErrandLoop(deps, { goal: "x" });
    expect(vi.mocked(deps.requestApproval).mock.calls[0]![0].category).toBe("send");
  });

  it("answers hand_over by waiting for the operator", async () => {
    const { deps } = makeDeps([
      toolReply("hand_over", { reason: "bot_check", message: "Solve the captcha" }),
      textReply("ok"),
    ]);
    const outcome = await runErrandLoop(deps, { goal: "x" });
    expect(deps.waitForHandBack).toHaveBeenCalledWith("bot_check");
    expect(outcome.status).toBe("done");
  });

  it("retries a failed model capture once, then fails the errand with a plain message", async () => {
    const { deps, browser } = makeDeps([click()]);
    browser.captureForModel.mockRejectedValue(new ErrandOverlayError("cannot hide"));
    const outcome = await runErrandLoop(deps, { goal: "x" });
    expect(outcome.status).toBe("failed");
    expect(browser.captureForModel).toHaveBeenCalledTimes(2);
    expect(deps.callModel).not.toHaveBeenCalled();
  });

  it("refuses a risky batch with several click or key actions and asks for the risky one on its own", async () => {
    const batch = toolReply("computer", {
      actions: [
        { type: "click", x: 1, y: 1, button: "left" },
        { type: "type", text: "hi" },
        { type: "keypress", keys: ["Enter"] },
      ],
      about_to: "Send the message",
      risk: "send",
    });
    const single = toolReply(
      "computer",
      { actions: [{ type: "keypress", keys: ["Enter"] }], about_to: "Send the message", risk: "send" },
      "call_2",
    );
    const { deps, ran, requests } = makeDeps([batch, single, textReply("sent")]);
    const outcome = await runErrandLoop(deps, { goal: "x" });
    const first = requests[1]!.messages.find((m) => m.role === "tool")!;
    const text = String((first.content as Array<Record<string, unknown>>)[0]!.text);
    expect(text).toContain(
      "Send the risky action in its own computer call so it can be shown to the user before it runs.",
    );
    expect(first.content as unknown[]).toHaveLength(2);
    expect(deps.requestApproval).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.requestApproval).mock.calls[0]![0].category).toBe("send");
    expect(ran.map((a) => a.type)).toEqual(["keypress"]);
    expect(outcome.steps).toBe(2);
  });

  it("spends a step on an empty reply and continues", async () => {
    const empty: ChatCompletionResponse = { choices: [{ index: 0, message: { role: "assistant", content: "" } }] };
    const { deps, requests } = makeDeps([empty, textReply("answer")]);
    const outcome = await runErrandLoop(deps, { goal: "x" });
    expect(outcome.status).toBe("done");
    expect(outcome.steps).toBe(1);
    expect(outcome.modelRequests).toBe(2);
    const last = requests[1]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("Reply with a computer or hand_over call, or a final answer.");
  });

  it("keeps only the 3 most recent screenshots and keeps tool calls paired", async () => {
    const replies = [1, 2, 3, 4, 5, 6].map((n) =>
      toolReply("computer", { actions: [{ type: "wait" }], about_to: "wait" }, "call_" + n),
    );
    const { deps, requests } = makeDeps([...replies, textReply("ok")]);
    await runErrandLoop(deps, { goal: "x" });
    const last = requests.at(-1)!;
    const images = last.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((part) => part.type === "input_image") : [],
    );
    expect(images).toHaveLength(3);
    const calls = last.messages.flatMap((m) =>
      ((m as unknown as { tool_calls?: Array<{ id: string }> }).tool_calls ?? []).map((c) => c.id),
    );
    const results = last.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(results).toEqual(calls);
    expect(calls).toHaveLength(6);
  });

  it("does not run an approved action when the signal aborts during the approval wait", async () => {
    const controller = new AbortController();
    const { deps, browser, ran } = makeDeps([click()], {
      signal: controller.signal,
      requestApproval: vi.fn(async () => {
        controller.abort();
        return "approved" as const;
      }),
    });
    browser.describeTarget.mockResolvedValue(target({ text: "Place your order" }));
    const outcome = await runErrandLoop(deps, { goal: "buy" });
    expect(ran).toHaveLength(0);
    expect(outcome.status).toBe("stopped");
  });
});
