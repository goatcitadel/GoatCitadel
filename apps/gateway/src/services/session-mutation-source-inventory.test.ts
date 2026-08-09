import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SESSION_MUTATION_SOURCE_INVENTORY } from "./session-mutation-classification.js";

const gatewaySourceRoot = fileURLToPath(new URL("../", import.meta.url));

describe("session mutation source inventory", () => {
  it("uses unique stable semantic ids and names an owning service", () => {
    const ids = SESSION_MUTATION_SOURCE_INVENTORY.map((record) => record.sourceId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const record of SESSION_MUTATION_SOURCE_INVENTORY) {
      expect(record.sourceId).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u);
      expect(record.owner).toMatch(/^[a-z0-9-]+$/u);
      expect(record.rationale.trim().length).toBeGreaterThan(20);
    }
  });

  it("covers every canonical turn producer, continuation, terminal exemption, and retired legacy owner", () => {
    const ids = new Set(SESSION_MUTATION_SOURCE_INVENTORY.map((record) => record.sourceId));
    for (const required of [
      "chat.entry.append",
      "chat.prep.user-message.persist",
      "chat.dispatch.provider",
      "chat.agent-runner.effect-truth.persist",
      "chat.agent-runner.usage.persist",
      "chat.durable-run.create-bind",
      "chat.durable-run.resume",
      "chat.durable-run.terminal",
      "chat.continuation.user-input.resolve",
      "chat.autonomous.cron.ingress",
      "chat.autonomous.heartbeat.ingress",
      "chat.autonomous.proactive.ingress",
      "chat.external.companion-reply.ingress",
      "chat.external.integration-reply.ingress",
      "chat.post-commit.child.admit",
      "chat.post-commit.child.dispatch",
      "chat.post-commit.child.stage",
      "chat.post-commit.parent.capability-gap",
      "chat.post-commit.parent.realtime",
      "chat.post-commit.parent.agent-end",
      "chat.post-commit.learned-memory.retired",
      "chat.post-commit.memory-prewarm.retired",
      "chat.post-commit.commitments-direct.retired",
      "chat.entry.post-commit-direct.retired",
      "chat.stream.post-commit-direct.retired",
      "chat.approval.operator-resolution",
      "chat.approval.terminal-materialize",
      "chat.turn.cancel",
      "chat.legacy.background-review.retired",
      "chat.legacy.memory-maintenance.retired",
    ]) {
      expect(ids.has(required), required).toBe(true);
    }
  });

  it("guards production prepare, continuation, child-stage, and terminalization callsites", () => {
    expect(productionCallsiteCounts("prepareAgentChatTurn\\s*\\(")).toEqual({
      "services/chat-autonomous-turn-service.ts": 2,
      "services/chat-turn-entry-service.ts": 7,
      "services/chat-turn-prep-service.ts": 1,
      "services/chat-turn-runtime-host-composition.ts": 1,
      "services/durable-execution-service.ts": 2,
      "services/gateway-service.ts": 6,
    });
    expect(productionCallsiteCounts("\\.resolveDurableChatUserInput\\s*\\(")).toEqual({
      "services/chat-message-route-runtime.ts": 1,
    });
    expect(productionCallsiteCounts("\\.runPostCommitChildStage\\s*\\(")).toEqual({
      "services/gateway-service.ts": 1,
    });
    expect(productionCallsiteCounts("\\.closeTurnWrite\\s*\\(")).toEqual({
      "services/chat-autonomous-turn-service.ts": 1,
      "services/chat-turn-entry-service.ts": 2,
      "services/durable-run-service.ts": 1,
      "services/gateway-service.ts": 1,
      "services/session-control-runtime-owner.ts": 1,
      "services/session-control-service.ts": 1,
    });
  });

  it("keeps retired direct post-commit promotion and prewarm producers absent", () => {
    for (const relativePath of [
      "services/chat-turn-entry-service.ts",
      "services/chat-turn-stream-service.ts",
      "services/durable-execution-service.ts",
    ]) {
      const source = readFileSync(resolve(gatewaySourceRoot, relativePath), "utf8");
      expect(source, relativePath).not.toMatch(/\.extractAndPersistLearnedMemory\s*\(/u);
      expect(source, relativePath).not.toMatch(/\.recordTurnCommitments\s*\(/u);
      expect(source, relativePath).not.toMatch(/\.scheduleChatMemoryContextPrewarm\s*\(/u);
    }
  });
});

function productionCallsiteCounts(pattern: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of listProductionTypeScriptFiles(gatewaySourceRoot)) {
    const count = readFileSync(file, "utf8").match(new RegExp(pattern, "gu"))?.length ?? 0;
    if (count === 0) continue;
    counts[relative(gatewaySourceRoot, file).replaceAll("\\", "/")] = count;
  }
  return counts;
}

function listProductionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) return listProductionTypeScriptFiles(absolutePath);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || /\.(?:test|spec)\.ts$/u.test(entry.name)) return [];
    return [absolutePath];
  });
}
