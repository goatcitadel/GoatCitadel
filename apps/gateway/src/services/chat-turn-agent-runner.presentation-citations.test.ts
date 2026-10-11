import { expect, it, vi } from "vitest";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import { createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";

it("blocks uncited research PDF arguments before governed tool invocation", () => {
  const invokeTool = vi.fn();
  const runner = new ChatTurnAgentRunner({
    storage: createMockStorage() as never,
    listToolCatalog: () => [],
    createChatCompletion: vi.fn(),
    invokeTool,
  });
  const preflight = (runner as unknown as {
    preflightToolInvocation(input: Record<string, unknown>): { blockedReason?: string };
  }).preflightToolInvocation({
    toolName: "presentations.create",
    userContent: "Research some budget vacations and put them into a PDF.",
    historyMessages: [], webMode: "auto", mode: "chat", priorToolRuns: [],
    rawArgs: {
      path: "budget-vacations.pdf", title: "Budget vacations", format: "pdf",
      research: {
        asOfDate: "2026-10-11", geography: "International",
        physicalDigitalBoundary: "Travel", inclusionCriteria: ["Low costs"],
        exclusions: ["Airfare"], methodology: ["Travel guide"],
        limitations: ["Estimates"], competitors: ["Vietnam"], comparisonCriteria: ["Daily cost"],
      },
      sources: [{ id: "guide", title: "Travel guide", publisher: "Example", role: "independent", url: "https://example.com/travel" }],
      slides: [{ title: "Vietnam travel costs", bullets: ["Daily budget is $50."] }],
    },
  });
  expect(preflight.blockedReason).toContain("structured citations");
  expect(preflight.blockedReason).toContain("blocked this deck before writing");
  expect(invokeTool).not.toHaveBeenCalled();
});
