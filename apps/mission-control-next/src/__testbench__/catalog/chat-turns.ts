import {
  answerChatUserInputPrompt,
  cancelChatTurn,
  fetchChatThread,
  preflightChatRoute,
  streamAgentChatMessage,
} from "@goatcitadel/mission-control-shared/api/chat";
import { ensure, pass, summarizeEvidence, waitFor } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { createScratchSession, requireWorkspace } from "./context";
import { seedChatApprovalScenario, seedChatUserInputScenario } from "./dev-verification";

type StreamChunk = Parameters<Parameters<typeof streamAgentChatMessage>[2]>[0];

const PROMPT = "Reply with a short greeting for the GoatCitadel test bench.";

export const chatTurnChecks: readonly CheckDef[] = [
  {
    id: "chat.stream-reply",
    kind: "journey",
    domain: "chat",
    title: "Route preflight and streamed reply",
    tier: "mutate",
    needsWorkspace: true,
    description: "In the sandbox the reply comes from the deterministic stub.",
    routes: [
      "POST /api/v1/chat/sessions",
      "POST /api/v1/chat/sessions/:sessionId/route-preflight",
      "POST /api/v1/chat/sessions/:sessionId/agent-send/stream",
    ],
    steps: ["Create session", "Route preflight", "Stream reply"],
    async run(ctx) {
      const session = await ctx.step("Create session", () => createScratchSession(ctx, "stream"));
      const preflight = await ctx.step("Route preflight", () =>
        preflightChatRoute(session.sessionId, { action: "send", content: PROMPT }),
      );
      ensure(!preflight.blockedReason, `Routing is blocked: ${preflight.blockedReason}.`, preflight);
      const chunks: StreamChunk[] = [];
      await ctx.step("Stream reply", () =>
        streamAgentChatMessage(
          session.sessionId,
          {
            content: PROMPT,
            routeDecision: preflight.decision,
            providerId: preflight.decision.effectiveProviderId,
            model: preflight.decision.effectiveModel,
          },
          (chunk) => {
            chunks.push(chunk);
          },
          { signal: ctx.signal },
        ),
      );
      const text = chunks.flatMap((chunk) => (chunk.type === "delta" ? [chunk.delta] : [])).join("");
      ensure(text.trim() !== "", "The stream carried no reply text.", summarizeEvidence(chunks));
      ensure(
        chunks.some((chunk) => chunk.type === "done"),
        "The stream never sent its done event.",
        summarizeEvidence(chunks),
      );
      return pass(`Streamed ${text.length} characters: “${text.slice(0, 80)}”.`);
    },
  },
  {
    id: "chat.cancel-waiting-turn",
    kind: "journey",
    domain: "chat",
    title: "Cancel a turn that is waiting for approval",
    tier: "mutate",
    needsWorkspace: true,
    routes: [
      "POST /api/v1/chat/sessions",
      "POST /api/v1/dev/verification/chat-approval-scenario",
      "POST /api/v1/chat/sessions/:sessionId/turns/:turnId/cancel",
    ],
    steps: ["Create session", "Seed a turn waiting for approval", "Cancel the turn"],
    async run(ctx) {
      const session = await ctx.step("Create session", () => createScratchSession(ctx, "cancel"));
      const scenario = await ctx.step("Seed a turn waiting for approval", () =>
        seedChatApprovalScenario({ sessionId: session.sessionId, workspaceId: requireWorkspace(ctx) }, ctx.signal),
      );
      const result = await ctx.step("Cancel the turn", () =>
        cancelChatTurn(session.sessionId, scenario.turnId, "testbench"),
      );
      ensure(result.cancelled, "The gateway did not cancel the turn.", result);
      ensure(result.trace.status === "cancelled", `The turn is ${result.trace.status}, not cancelled.`, result);
      return pass("The waiting turn was cancelled.", result.trace);
    },
  },
  {
    id: "chat.user-input",
    kind: "journey",
    domain: "chat",
    title: "Answer a user-input prompt",
    tier: "mutate",
    needsWorkspace: true,
    routes: [
      "POST /api/v1/chat/sessions",
      "POST /api/v1/dev/verification/chat-user-input-scenario",
      "POST /api/v1/chat/sessions/:sessionId/turns/:turnId/user-input/:promptId/respond",
      "GET /api/v1/chat/sessions/:sessionId/thread",
    ],
    steps: ["Create session", "Seed a turn asking for input", "Answer the prompt", "Prompt is cleared"],
    async run(ctx) {
      const session = await ctx.step("Create session", () => createScratchSession(ctx, "user input"));
      const scenario = await ctx.step("Seed a turn asking for input", () =>
        seedChatUserInputScenario({ sessionId: session.sessionId, workspaceId: requireWorkspace(ctx) }, ctx.signal),
      );
      const answer = await ctx.step("Answer the prompt", () =>
        answerChatUserInputPrompt(session.sessionId, scenario.turnId, scenario.promptId, {
          response: { kind: "single_select", optionId: "option-a" },
        }),
      );
      ensure(answer.ok, "The gateway rejected the answer.", answer);
      await ctx.step("Prompt is cleared", () =>
        waitFor(
          () => fetchChatThread(session.sessionId),
          (thread) => thread.turns.some((turn) => turn.turnId === scenario.turnId && !turn.trace.pendingUserInput),
          { signal: ctx.signal, timeoutMs: 15_000, label: "Clearing the answered prompt" },
        ),
      );
      return pass(`Answered; the turn resumed: ${answer.resumed ? "yes" : "no"}.`, answer);
    },
  },
];
