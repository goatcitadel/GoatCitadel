import { describe, expect, it } from "vitest";
import type { ChatMessageRecord } from "@goatcitadel/contracts";
import { buildConversationCompactionSummary, trimNewestContextMessagesForPromptCache } from "./chat-compaction.js";

function createMessage(input: Pick<ChatMessageRecord, "role" | "content"> & { messageId: string }): ChatMessageRecord {
  return {
    messageId: input.messageId,
    sessionId: "sess-1",
    role: input.role,
    actorType: input.role === "assistant" ? "agent" : "user",
    actorId: input.role === "assistant" ? "assistant" : "operator",
    content: input.content,
    timestamp: "2026-03-12T10:00:00.000Z",
  };
}

describe("buildConversationCompactionSummary", () => {
  it("preserves decisions, failures, and notable artifacts", () => {
    const summary = buildConversationCompactionSummary([
      createMessage({
        messageId: "m1",
        role: "user",
        content:
          "We decided to keep the fallback on `browser.search` and avoid changing C:\\code\\personal-ai\\apps\\gateway\\src\\services\\chat-turn-agent-runner.ts.",
      }),
      createMessage({
        messageId: "m2",
        role: "assistant",
        content:
          "The last attempt failed with TIMEOUT and the blocked source https://example.com/report. Retry with a different host instead.",
      }),
      createMessage({
        messageId: "m3",
        role: "user",
        content: "Please implement the fix but do not remove the prior rejection path.",
      }),
    ]);

    expect(summary).toContain("Compacted conversation context.");
    expect(summary).toContain("Decisions and constraints:");
    expect(summary).toContain("Failed attempts and issues:");
    expect(summary).toContain("Notable artifacts:");
    expect(summary).toContain("browser.search");
    expect(summary).toContain("C:\\code\\personal-ai\\apps\\gateway\\src\\services\\chat-turn-agent-runner.ts");
    expect(summary).toContain("https://example.com/report");
    expect(summary).toContain("TIMEOUT");
    expect(summary).toContain("Recent context:");
  });

  it("pins the original and latest user ask ahead of the digest", () => {
    const summary = buildConversationCompactionSummary([
      createMessage({ messageId: "m1", role: "user", content: "Build me a churn dashboard for Q3 with cohort splits" }),
      createMessage({
        messageId: "m2",
        role: "assistant",
        content: "Working on it. I decided to use the metrics API.",
      }),
      createMessage({ messageId: "m3", role: "user", content: "Actually also add a retention heatmap" }),
      createMessage({ messageId: "m4", role: "assistant", content: "There was an error calling the metrics API." }),
    ]);

    expect(summary).toBeDefined();
    const originalIdx = summary!.indexOf("Original ask:");
    const latestIdx = summary!.indexOf("Latest ask:");
    expect(originalIdx).toBeGreaterThanOrEqual(0);
    expect(latestIdx).toBeGreaterThan(originalIdx);
    expect(summary).toContain("churn dashboard");
    expect(summary).toContain("retention heatmap");
    expect(latestIdx).toBeLessThan(summary!.indexOf("Decisions and constraints:"));
  });

  it("emits a single ask section when there is only one user message", () => {
    const summary = buildConversationCompactionSummary([
      createMessage({ messageId: "m1", role: "user", content: "Summarize the repo" }),
      createMessage({ messageId: "m2", role: "assistant", content: "ok" }),
    ]);

    expect(summary).toContain("Original ask:");
    expect(summary).not.toContain("Latest ask:");
  });

  it("omits ask sections when no user messages exist", () => {
    const summary = buildConversationCompactionSummary([
      createMessage({ messageId: "m1", role: "assistant", content: "standalone note" }),
    ]);

    expect(summary).toBeDefined();
    expect(summary).not.toContain("Original ask:");
  });

  it("returns undefined for empty or whitespace-only messages", () => {
    const summary = buildConversationCompactionSummary([
      createMessage({ messageId: "m1", role: "user", content: "   " }),
      createMessage({ messageId: "m2", role: "assistant", content: "\n\t" }),
    ]);

    expect(summary).toBeUndefined();
  });

  it("trims newest tool/context payloads first to keep older prefixes stable", () => {
    const messages = [
      { role: "system", content: "Pinned instruction block." },
      { role: "user", content: "Please compare the latest release notes." },
      { role: "assistant", content: "I will use the recent search context." },
      { role: "tool", name: "browser.extract", tool_call_id: "call-1", content: `Result ${"x".repeat(4000)}` },
      { role: "system", content: `Policy ${"y".repeat(2200)}` },
    ] as const;

    const trimmed = trimNewestContextMessagesForPromptCache(messages as never, 260);

    expect(trimmed[0]).toEqual(messages[0]);
    expect(trimmed[1]).toEqual(messages[1]);
    expect(trimmed[2]).toEqual(messages[2]);
    expect(trimmed[3]?.content).toContain("cache-stable prompt prefix");
    expect(trimmed[3]?.content).toContain("Role=tool");
    expect(trimmed[3]?.content).toContain("name=browser.extract");
    expect(trimmed[3]?.content).toContain("tool_call_id=call-1");
    expect(trimmed[3]?.content).toContain("Snippet=Result");
    expect(trimmed[4]?.content).toContain("cache-stable prompt prefix");
    expect(trimmed[4]?.content).toContain("Role=system");
    expect(trimmed[4]?.content).toContain("Snippet=Policy");
  });

  it("scales token estimates by the model multiplier when deciding what to trim", () => {
    const messages = [
      { role: "system", content: "Pinned instruction block." },
      { role: "user", content: "Question." },
      { role: "tool", name: "search", tool_call_id: "call-9", content: `Result ${"z".repeat(800)}` },
    ] as const;

    // ~212 estimated tokens at multiplier 1; budget sits above that but below 2x.
    const budget = 320;
    const atDefault = trimNewestContextMessagesForPromptCache(messages as never, budget);
    expect(atDefault[2]?.content).toContain("Result");
    expect(atDefault[2]?.content).not.toContain("cache-stable prompt prefix");

    const atDoubled = trimNewestContextMessagesForPromptCache(messages as never, budget, 2);
    expect(atDoubled[2]?.content).toContain("cache-stable prompt prefix");
    expect(atDoubled[2]?.content).toContain("Snippet=Result");
  });
});
