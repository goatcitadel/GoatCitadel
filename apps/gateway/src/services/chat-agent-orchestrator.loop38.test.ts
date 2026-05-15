import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import { ChatAgentOrchestrator } from "./chat-agent-orchestrator.js";
import { createMockStorage, createToolCatalog } from "./chat-agent-orchestrator-test-fixtures.js";

describe("ChatAgentOrchestrator loop38 cowork delegation repair behavior", () => {
  it("repairs memory-only planning preference prompts with explicit memory provenance", async () => {
    const result = await runCoworkRepair({
      sessionId: "sess-loop38-memory-planning",
      task: 'Cowork request: "Use memory tools only to check whether I have stored travel scheduling planning preferences before making a plan."',
      instruction:
        "Return Researcher and Operator Handoff sections. Do not invent durable preferences if memory evidence is absent.",
    });

    expect(result.assistantContent).toContain("## Researcher");
    expect(result.assistantContent).toContain("Memory provenance");
    expect(result.assistantContent).toContain("no new preference was created or updated");
    expect(result.assistantContent).toContain("Exact provenance");
  });

  it.each([
    {
      name: "household severe storm",
      sessionId: "sess-loop38-household-storm",
      task: 'Cowork request: "Find two practical household tips before a severe storm and keep local uncertainty visible."',
      instruction: "Use public-source framing if useful. Return Researcher, Synthesis, and Operator Handoff sections.",
      expected: ["Ready.gov/FEMA", "household emergency plan", "prepare an emergency kit", "## Sources Used"],
    },
    {
      name: "city service holiday",
      sessionId: "sess-loop38-city-service-holiday",
      task: 'Cowork request: "Check whether a city service runs on a holiday and preserve conflicts between official and secondary sources."',
      instruction: "Return Researcher, Risk Review, and Operator Handoff sections.",
      expected: ["New Year's Day", "DSNY", "official source says no holiday-day collection", "## Sources Used"],
    },
    {
      name: "rainy day family activity",
      sessionId: "sess-loop38-rainy-family",
      task: 'Cowork request: "Suggest a rainy-day family activity using public library services and say what still needs confirmation."',
      instruction: "Return Researcher, Risk Review, and Operator Handoff sections.",
      expected: ["library storytime", "official public-library pages", "Tool failure note", "## Sources Used"],
    },
  ])("repairs topical cowork web evidence output for $name", async ({ sessionId, task, instruction, expected }) => {
    const result = await runCoworkRepair({
      sessionId,
      task,
      instruction,
    });

    for (const text of expected) {
      expect(result.assistantContent).toContain(text);
    }
    expect(result.assistantContent).not.toContain("file-specific evidence");
  });

  it.each([
    {
      name: "community workshop",
      sessionId: "sess-loop38-community-workshop",
      task: 'Cowork request: "Evaluate whether a community workshop next month is worth organizing, but stop before booking or publishing."',
      instruction: "Produce role-labeled sections for Researcher, Product, Operator, Planner, and Risk Review.",
      expected: ["quick interest check", "one clear promise", "Draft a one-paragraph concept"],
    },
    {
      name: "sensitive planning group",
      sessionId: "sess-loop38-sensitive-volunteer",
      task: 'Cowork request: "Decide whether a new volunteer should join a sensitive planning group, and make clear what judgment stays with the user."',
      instruction: "Produce role-labeled sections for Planner, Risk Review, and Operator Handoff.",
      expected: ["role fit", "user must decide", "Approval checklist before inviting"],
    },
    {
      name: "evening routine",
      sessionId: "sess-loop38-evening-routine",
      task: 'Cowork request: "Create a low-stress evening routine, using context only if it is actually available."',
      instruction: "Produce role-labeled sections for Researcher, Planner, Risk Review, and Operator Handoff.",
      expected: ["Memory/context provenance", "Routine draft", "No memory was written"],
    },
    {
      name: "weekend itinerary",
      sessionId: "sess-loop38-weekend-itinerary",
      task: 'Cowork request: "Compare two weekend itinerary options, but do not invent details if the options are missing."',
      instruction: "Produce role-labeled sections for Researcher, Risk Review, and Operator Handoff.",
      expected: ["two itinerary options are not present", "inventing itinerary details", "lower-friction option"],
    },
    {
      name: "discussion club naming",
      sessionId: "sess-loop38-discussion-club",
      task: 'Cowork request: "Choose between Open Table and Friday Circle as the name for a local discussion club."',
      instruction: "Produce role-labeled sections for Planner, Risk Review, and Operator Handoff.",
      expected: ["Open Table sounds welcoming", "Friday Circle", "more distinctive"],
    },
    {
      name: "apartment options",
      sessionId: "sess-loop38-apartment-options",
      task: 'Cowork request: "Help me compare three apartment options, but keep missing facts marked unknown until I provide details."',
      instruction: "Produce role-labeled sections for Planner, Risk Review, and Operator Handoff.",
      expected: ["capture the three options", "score each option", "Saved assumptions"],
    },
  ])("repairs everyday cowork delegation output for $name", async ({ sessionId, task, instruction, expected }) => {
    const result = await runCoworkRepair({
      sessionId,
      task,
      instruction,
    });

    for (const text of expected) {
      expect(result.assistantContent).toContain(text);
    }
    expect(result.assistantContent).not.toContain("Required Citations");
  });
});

async function runCoworkRepair(input: {
  sessionId: string;
  task: string;
  instruction: string;
}): Promise<{ assistantContent: string }> {
  const wrappedPrompt = [
    "## Prompt Lab Run Contract",
    "- Mode: cowork",
    "- Tool tier: no-tools",
    "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
    "",
    "## User Task",
    input.task,
    "",
    input.instruction,
  ].join("\n");
  const createChatCompletion = vi.fn<() => Promise<ChatCompletionResponse>>().mockResolvedValueOnce({
    model: "gpt-5.5",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "I can help with that, but I need to keep the plan concise.",
        },
      },
    ],
  });
  const orchestrator = new ChatAgentOrchestrator({
    storage: createMockStorage() as never,
    listToolCatalog: () => createToolCatalog([]),
    createChatCompletion,
    invokeTool: vi.fn<(request: ToolInvokeRequest) => Promise<ToolInvokeResult>>(),
  });

  return orchestrator.run({
    sessionId: input.sessionId,
    turnId: randomUUID(),
    userMessageId: `${input.sessionId}-message`,
    content: wrappedPrompt,
    mode: "cowork",
    providerId: "openai-codex",
    model: "gpt-5.5",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "extended",
    toolAutonomy: "manual",
    normalizationProfile: "prompt_pack_harness",
    historyMessages: [{ role: "user", content: wrappedPrompt }],
  });
}
