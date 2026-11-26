import { describe, expect, it } from "vitest";
import { memoryClaimKey, type LearnedMemoryItemRecord, type MemoryClaim } from "@goatcitadel/contracts";
import { ChatLearnedMemoryService, inferSessionMemoryClaim } from "./chat-learned-memory-service.js";

const SESSION = "sess-1";
const WORKSPACE = "ws-1";

type Item = LearnedMemoryItemRecord & { claim?: MemoryClaim };

function createFakeRepo(seed: Item[]) {
  const items: Item[] = [...seed];
  const conflicts: Array<{ existingItemId: string; incomingItemId: string }> = [];
  const corrections: Array<{ itemId: string; content: string }> = [];
  let next = 1;
  const insertItem = (input: Partial<Item> & { content: string; status: string }) => {
    const item = {
      ...input,
      itemId: `new-${next++}`,
      sessionId: SESSION,
      sourceHash: `hash-new-${next}`,
    } as Item;
    items.push(item);
    return item;
  };
  return {
    items,
    conflicts,
    corrections,
    repo: {
      findActiveClaim: async (_sessionId: string, workspaceId: string, claim: MemoryClaim) =>
        items.filter(
          (item) =>
            item.status === "active" &&
            item.claim &&
            memoryClaimKey(workspaceId, item.claim) === memoryClaimKey(workspaceId, claim),
        ),
      findActiveByType: async (_sessionId: string, itemType: string) =>
        // Mirrors the real query, which also returns unresolved conflict rows.
        items.filter((item) => ["active", "conflict"].includes(item.status) && item.itemType === itemType),
      insertItem: async (input: Partial<Item> & { content: string; status: string }) => insertItem(input),
      insertConflict: async (input: { existingItemId: string; incomingItemId: string }) => {
        conflicts.push(input);
      },
      updateItemConfidence: async () => undefined,
      appendSource: async () => undefined,
      correctItem: async (input: { itemId: string; replacement: Partial<Item> & { content: string } }) => {
        const previous = items.find((item) => item.itemId === input.itemId)!;
        previous.status = "superseded" as Item["status"];
        corrections.push({ itemId: input.itemId, content: input.replacement.content });
        return insertItem({ ...input.replacement, status: "active" });
      },
    },
  };
}

function legacyItem(itemId: string, content: string, status: Item["status"] = "active"): Item {
  return {
    itemId,
    sessionId: SESSION,
    itemType: "preference",
    content,
    confidence: 0.8,
    status,
    redacted: false,
    sourceHash: `hash-${itemId}`,
  } as Item;
}

function createService(seed: Item[]) {
  const fake = createFakeRepo(seed);
  const service = new ChatLearnedMemoryService({
    storage: { learnedMemory: fake.repo } as never,
  });
  const say = (content: string, sourceRef: string) =>
    service.extractAndPersistLearnedMemory(SESSION, content, {
      role: "user",
      sourceRef,
      authority: "operator",
      workspaceId: WORKSPACE,
    });
  return { fake, say };
}

const active = (items: Item[]) => items.filter((item) => item.status === "active").map((item) => item.content);

describe("learned memory saved before claims existed", () => {
  it("infers a session claim only for text that names a known property", () => {
    expect(inferSessionMemoryClaim("I prefer concise replies.", SESSION)).toMatchObject({
      identity: { subject: "operator", predicate: "reply_length", scope: { kind: "session", id: SESSION } },
      value: "concise",
    });
    expect(inferSessionMemoryClaim("I work on tokenization research.", SESSION)).toBeUndefined();
  });

  it("infers nothing from a negated statement, so its polarity is never flipped", () => {
    expect(inferSessionMemoryClaim("Never give concise replies.", SESSION)).toBeUndefined();
    expect(inferSessionMemoryClaim("Don't use detailed explanations.", SESSION)).toBeUndefined();
    expect(inferSessionMemoryClaim("No, I now prefer detailed replies.", SESSION)).toMatchObject({
      value: "detailed",
    });
  });

  it("does not treat an unresolved conflict row as an active target", async () => {
    const { fake, say } = createService([
      legacyItem("old-1", "Remember that I prefer concise replies."),
      legacyItem("pending-1", "Remember that I prefer detailed replies.", "conflict"),
    ]);
    await say("No, I now prefer detailed replies.", "msg-3");
    expect(fake.corrections).toEqual([expect.objectContaining({ itemId: "old-1" })]);
  });

  it("records a conflict instead of keeping an opposite preference active beside an older unclaimed one", async () => {
    const { fake, say } = createService([legacyItem("old-1", "Remember that I prefer concise replies.")]);
    await say("Remember that I prefer detailed replies.", "msg-2");
    expect(active(fake.items)).toEqual(["Remember that I prefer concise replies."]);
    expect(fake.conflicts).toEqual([expect.objectContaining({ existingItemId: "old-1" })]);
  });

  it("lets an operator correction supersede the older unclaimed preference", async () => {
    const { fake, say } = createService([legacyItem("old-1", "Remember that I prefer concise replies.")]);
    await say("No, I now prefer detailed replies.", "msg-2");
    expect(fake.corrections).toEqual([expect.objectContaining({ itemId: "old-1" })]);
    expect(active(fake.items)).toEqual(["No, I now prefer detailed replies."]);
  });

  it("leaves an unrelated older preference untouched", async () => {
    const { fake, say } = createService([legacyItem("old-1", "Remember that I prefer TypeScript for new code.")]);
    await say("Remember that I prefer detailed replies.", "msg-2");
    expect(fake.conflicts).toEqual([]);
    expect(active(fake.items).sort()).toEqual([
      "Remember that I prefer TypeScript for new code.",
      "Remember that I prefer detailed replies.",
    ]);
  });
});
