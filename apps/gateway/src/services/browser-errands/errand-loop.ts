import type { ChatCompletionMessage, ChatCompletionRequest, ChatCompletionResponse } from "@goatcitadel/contracts";
import {
  ErrandOverlayError,
  normalizeComputerActions,
  type ComputerAction,
  type ErrandBrowser,
  type ErrandTargetInfo,
} from "@goatcitadel/policy-engine";
import { classifyErrandAction, type ErrandRiskCategory } from "./errand-action-classifier.js";
import {
  ERRAND_DEFAULT_MODEL,
  ERRAND_DEFAULT_PROVIDER_ID,
  ERRAND_MAX_ACTIVE_MS,
  ERRAND_MAX_STEPS,
} from "./errand-constants.js";
import { COMPUTER_TOOL_NAME, ERRAND_SYSTEM_PROMPT, ERRAND_TOOLS, HAND_OVER_TOOL_NAME } from "./errand-model-tools.js";

export interface ErrandApprovalInput {
  category: ErrandRiskCategory;
  title: string;
  body: string;
  target: ErrandTargetInfo;
  pageUrl: string;
  peopleScreenshotPng: Buffer;
}

export interface ErrandProgress {
  step: number;
  text: string;
  modelScreenshotPng?: Buffer;
}

export type ErrandStatus =
  | "done"
  | "stopped"
  | "declined"
  | "expired"
  | "failed"
  | "step_limit"
  | "time_limit"
  | "window_closed";

export interface ErrandOutcome {
  status: ErrandStatus;
  answer?: string;
  summary: string;
  steps: number;
  modelRequests: number;
  visitedUrls: string[];
  finalScreenshotPng?: Buffer;
}

export interface ErrandLoopDeps {
  callModel(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  browser: Pick<
    ErrandBrowser,
    | "captureForModel"
    | "captureForPeople"
    | "currentUrl"
    | "runActions"
    | "describeTarget"
    | "describeFocused"
    | "overlay"
  >;
  requestApproval(input: ErrandApprovalInput): Promise<"approved" | "denied" | "expired" | "stopped">;
  waitForHandBack(reason: "sign_in" | "bot_check" | "operator"): Promise<"resumed" | "stopped">;
  /** Called with a people screenshot after an approved action finishes running (the gate's "after" evidence). */
  afterApprovedAction?(png: Buffer): Promise<void>;
  onProgress(progress: ErrandProgress): void;
  now(): number;
  signal: AbortSignal;
}

interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string;
}

type TerminalStatus = Exclude<ErrandStatus, "done" | "failed" | "step_limit" | "time_limit" | "window_closed">;

class StopErrand extends Error {
  constructor(
    readonly status: ErrandStatus,
    message: string,
  ) {
    super(message);
  }
}

const CAPTURE_FAILED_MESSAGE = "GoatCitadel could not safely take a screenshot of the page, so the errand was stopped.";

function imageContent(text: string, png: Buffer): Array<Record<string, unknown>> {
  return [
    { type: "input_text", text },
    { type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}`, detail: "original" },
  ];
}

function readToolCalls(response: ChatCompletionResponse): { text: string; calls: ToolCallRecord[] } {
  const message = response.choices?.[0]?.message ?? {};
  const content = message.content;
  const text = typeof content === "string" ? content : "";
  const raw = Array.isArray(message.tool_calls) ? (message.tool_calls as unknown[]) : [];
  const calls: ToolCallRecord[] = [];
  for (const entry of raw) {
    const record = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
    if (!record || typeof record.id !== "string") {
      continue;
    }
    const args = record.function?.arguments;
    calls.push({
      id: record.id,
      name: typeof record.function?.name === "string" ? record.function.name : "",
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    });
  }
  return { text, calls };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function unknownTarget(x: number, y: number): ErrandTargetInfo {
  return {
    x,
    y,
    tagName: "",
    role: "",
    text: "",
    isPasswordLike: false,
    isOneTimeCode: false,
    isOpaque: false,
    rect: { x: 0, y: 0, width: 0, height: 0 },
  };
}

function actionPoint(action: ComputerAction): { x: number; y: number } | null {
  switch (action.type) {
    case "click":
    case "double_click":
      return { x: action.x, y: action.y };
    case "drag":
      return action.path[0] ?? null;
    default:
      return null;
  }
}

function approvalTitle(action: ComputerAction, subject: ErrandTargetInfo | null): string {
  if (action.type === "keypress") {
    const keys = action.keys.join("+");
    return subject?.formSubmitText ? `Press ${keys} on "${subject.formSubmitText}"` : `Press ${keys}`;
  }
  if (action.type === "type") {
    return "Type into the page";
  }
  const verb = action.type === "double_click" ? "Double-click" : action.type === "drag" ? "Drag" : "Click";
  return subject?.text ? `${verb} "${subject.text}"` : `${verb} on the page`;
}

/** Only these actions can carry the model's declared risk; the declaration is consumed by the first one. */
function carriesDeclaredRisk(action: ComputerAction): boolean {
  return action.type === "click" || action.type === "double_click" || action.type === "keypress";
}

export async function runErrandLoop(deps: ErrandLoopDeps, input: { goal: string }): Promise<ErrandOutcome> {
  const { browser, signal } = deps;
  const startedAt = deps.now();
  let pausedMs = 0;
  let steps = 0;
  let modelRequests = 0;
  const visited: string[] = [];

  const noteUrl = (): void => {
    const url = browser.currentUrl();
    if (url && !visited.includes(url)) {
      visited.push(url);
    }
  };

  const paused = async <T>(wait: () => Promise<T>): Promise<T> => {
    const before = deps.now();
    try {
      return await wait();
    } finally {
      pausedMs += deps.now() - before;
    }
  };

  const captureForModel = async (): Promise<Buffer> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await browser.captureForModel();
      } catch (error) {
        if (!(error instanceof ErrandOverlayError) || attempt >= 1) {
          throw new StopErrand("failed", CAPTURE_FAILED_MESSAGE);
        }
      }
    }
  };

  const finish = async (status: ErrandStatus, summary: string, answer?: string): Promise<ErrandOutcome> => {
    let finalScreenshotPng: Buffer | undefined;
    try {
      finalScreenshotPng = await browser.captureForPeople();
    } catch {
      finalScreenshotPng = undefined;
    }
    return {
      status,
      summary,
      steps,
      modelRequests,
      visitedUrls: visited,
      ...(answer !== undefined ? { answer } : {}),
      ...(finalScreenshotPng ? { finalScreenshotPng } : {}),
    };
  };

  const messages: ChatCompletionMessage[] = [{ role: "system", content: ERRAND_SYSTEM_PROMPT }];

  try {
    noteUrl();
    messages.push({
      role: "user",
      content: imageContent(`Errand: ${input.goal}`, await captureForModel()),
    });

    for (;;) {
      if (signal.aborted) {
        return await finish("stopped", "The errand was stopped.");
      }
      if (steps >= ERRAND_MAX_STEPS) {
        return await finish("step_limit", `The errand reached its ${ERRAND_MAX_STEPS}-step limit.`);
      }
      if (deps.now() - startedAt - pausedMs >= ERRAND_MAX_ACTIVE_MS) {
        return await finish("time_limit", "The errand reached its time limit.");
      }

      modelRequests += 1;
      const response = await deps.callModel({
        providerId: ERRAND_DEFAULT_PROVIDER_ID,
        model: ERRAND_DEFAULT_MODEL,
        messages,
        tools: ERRAND_TOOLS,
        memory: { enabled: false, mode: "off" },
        stream: false,
        signal,
      });
      if (signal.aborted) {
        return await finish("stopped", "The errand was stopped.");
      }

      const { text, calls } = readToolCalls(response);
      if (calls.length === 0) {
        const answer = text.trim();
        if (!answer) {
          return await finish("failed", "The model returned no answer and no action.");
        }
        return await finish("done", answer, answer);
      }

      steps += 1;
      const assistant = {
        role: "assistant",
        content: text,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      } as ChatCompletionMessage;
      const toolMessages: ChatCompletionMessage[] = [];

      for (const [index, call] of calls.entries()) {
        if (index > 0) {
          toolMessages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "Only one tool call is handled per turn. Repeat this call on its own if you still need it.",
          });
          continue;
        }
        const result = await handleCall(call, steps);
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: result });
      }

      // The assistant tool-call message and its tool messages are always appended together.
      messages.push(assistant, ...toolMessages);
    }
  } catch (error) {
    if (signal.aborted) {
      return await finish("stopped", "The errand was stopped.");
    }
    if (error instanceof StopErrand) {
      return await finish(error.status, error.message);
    }
    return await finish("failed", error instanceof Error ? error.message : "The errand failed.");
  }

  async function handleCall(call: ToolCallRecord, step: number): Promise<Array<Record<string, unknown>>> {
    if (call.name === HAND_OVER_TOOL_NAME) {
      return await handleHandOver(call, step);
    }
    if (call.name === COMPUTER_TOOL_NAME) {
      return await handleComputer(call, step);
    }
    return imageContent(
      `Unknown tool "${call.name}". Use ${COMPUTER_TOOL_NAME} or ${HAND_OVER_TOOL_NAME}.`,
      await captureForModel(),
    );
  }

  async function handleHandOver(call: ToolCallRecord, step: number): Promise<Array<Record<string, unknown>>> {
    let reason: "sign_in" | "bot_check" | "operator" = "operator";
    let message = "";
    try {
      const parsed = JSON.parse(call.arguments) as { reason?: unknown; message?: unknown };
      if (parsed.reason === "sign_in" || parsed.reason === "bot_check") {
        reason = parsed.reason;
      }
      message = typeof parsed.message === "string" ? parsed.message : "";
    } catch {
      // A malformed hand_over still hands over; the operator sees the page.
    }
    deps.onProgress({ step, text: message || "Waiting for the operator" });
    const answer = await paused(() => deps.waitForHandBack(reason));
    if (answer === "stopped") {
      throw new StopErrand("stopped", "The operator stopped the errand.");
    }
    noteUrl();
    return imageContent(
      "The operator handed the browser back. Look at the screen and continue.",
      await captureForModel(),
    );
  }

  async function handleComputer(call: ToolCallRecord, step: number): Promise<Array<Record<string, unknown>>> {
    let parsed: { actions?: unknown; about_to?: unknown; risk?: unknown };
    try {
      parsed = JSON.parse(call.arguments) as typeof parsed;
    } catch {
      return imageContent("The tool arguments were not valid JSON. Send the call again.", await captureForModel());
    }
    const { actions, errors } = normalizeComputerActions(parsed.actions);
    if (errors.length > 0) {
      return imageContent(`Nothing was run. ${errors.join(" ")}`, await captureForModel());
    }
    const aboutTo = typeof parsed.about_to === "string" ? parsed.about_to.trim() : "";
    let declared: ErrandRiskCategory | undefined =
      parsed.risk === "spend" || parsed.risk === "send" || parsed.risk === "delete" || parsed.risk === "settings"
        ? parsed.risk
        : undefined;
    deps.onProgress({ step, text: aboutTo || "Working on the page" });

    let terminal: StopErrand | null = null;
    let handedBack = false;
    let afterPending = false;

    const flushAfter = async (): Promise<void> => {
      if (afterPending) {
        afterPending = false;
        if (deps.afterApprovedAction) {
          await deps.afterApprovedAction(await browser.captureForPeople());
        }
      }
    };

    const beforeAction = async (action: ComputerAction): Promise<"proceed" | "halt"> => {
      await flushAfter();
      if (signal.aborted) {
        terminal = new StopErrand("stopped", "The errand was stopped.");
        return "halt";
      }
      const point = actionPoint(action);
      const isKeyboard = action.type === "type" || action.type === "keypress";
      const target = point ? await browser.describeTarget(point.x, point.y) : null;
      // Re-read right before each keyboard action: an earlier click may have moved focus.
      const focused = isKeyboard ? await browser.describeFocused() : null;
      const modelDeclared = carriesDeclaredRisk(action) ? declared : undefined;
      const verdict = classifyErrandAction({
        action,
        target,
        focused,
        pageUrl: browser.currentUrl(),
        ...(modelDeclared ? { modelDeclared } : {}),
      });

      if (verdict.kind === "handover") {
        const answer = await paused(() => deps.waitForHandBack("sign_in"));
        if (answer === "stopped") {
          terminal = new StopErrand("stopped", "The operator stopped the errand.");
        } else {
          handedBack = true;
        }
        return "halt";
      }
      if (verdict.kind === "ask") {
        const subject = isKeyboard ? focused : target;
        const pageUrl = browser.currentUrl();
        const answer = await paused(async () =>
          deps.requestApproval({
            category: verdict.category,
            title: approvalTitle(action, subject),
            body: `${aboutTo || verdict.reason} on ${hostOf(pageUrl)}`,
            target: subject ?? unknownTarget(point?.x ?? 0, point?.y ?? 0),
            pageUrl,
            peopleScreenshotPng: await browser.captureForPeople(),
          }),
        );
        if (answer !== "approved") {
          const status: TerminalStatus = answer === "denied" ? "declined" : answer;
          const summary =
            answer === "denied"
              ? "The operator declined this action."
              : answer === "expired"
                ? "The approval request expired."
                : "The operator stopped the errand.";
          terminal = new StopErrand(status, summary);
          return "halt";
        }
        if (modelDeclared) {
          declared = undefined;
        }
        afterPending = true;
      }
      return "proceed";
    };

    const result = await browser.runActions(actions, beforeAction);
    await flushAfter();
    if (terminal) {
      throw terminal;
    }
    noteUrl();

    const parts = [`Ran ${result.ran} of ${actions.length} actions.`];
    if (handedBack) {
      parts.push(
        "The operator took over for a sign-in; the remaining actions were not run. Look at the screen and continue.",
      );
    }
    if (result.error) {
      parts.push(result.error);
    }
    const png = await captureForModel();
    deps.onProgress({ step, text: aboutTo || "Working on the page", modelScreenshotPng: png });
    return imageContent(parts.join(" "), png);
  }
}
