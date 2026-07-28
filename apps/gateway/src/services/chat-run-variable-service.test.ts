import { describe, expect, it } from "vitest";
import { RUN_VARIABLE_SCHEMA_VERSION, hashRunVariableSchema } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { resolveChatRunVariableRequest } from "./chat-run-variable-service.js";

function createFixture() {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
  storage.chatSessionMeta.ensure("session-1", undefined, "workspace-1");
  const schema = {
    version: RUN_VARIABLE_SCHEMA_VERSION,
    fields: [{ id: "topic", label: "Topic", type: "text" as const, required: true }],
  };
  const replaced = storage.promptPacks.replacePackTests({
    packId: "pack-1",
    name: "Typed pack",
    runVariableSchema: schema,
    tests: [{ code: "TEST-1", title: "Typed", prompt: "Explain {{topic}}.", orderIndex: 0 }],
  });
  return { storage, schema, pack: replaced.pack, test: replaced.tests[0]! };
}

describe("resolveChatRunVariableRequest", () => {
  it("revalidates and freezes a prompt-pack invocation with session-scoped evidence", () => {
    const fixture = createFixture();
    const invocation = {
      ownerKind: "prompt_pack" as const,
      ownerId: fixture.pack.packId,
      ownerRevision: fixture.pack.updatedAt,
      templateId: fixture.test.testId,
      schemaHash: hashRunVariableSchema(fixture.schema),
      values: { topic: "durable leases" },
    };
    const resolved = resolveChatRunVariableRequest(fixture.storage, "session-1", {
      content: "Explain durable leases.",
      templateInvocation: invocation,
    });
    expect(resolved.runVariableEvidence).toMatchObject({
      ownerId: "pack-1",
      templateId: fixture.test.testId,
      bindings: { topic: "durable leases" },
    });
    expect(fixture.storage.chatSessionRunVariables.get("session-1", "prompt_pack", "pack-1")?.bindings).toEqual({
      topic: "durable leases",
    });
    fixture.storage.close();
  });

  it("rejects forged previews, stale schemas, and cross-owner test injection", () => {
    const fixture = createFixture();
    const base = {
      ownerKind: "prompt_pack" as const,
      ownerId: fixture.pack.packId,
      ownerRevision: fixture.pack.updatedAt,
      templateId: fixture.test.testId,
      schemaHash: hashRunVariableSchema(fixture.schema),
      values: { topic: "leases" },
    };
    expect(() =>
      resolveChatRunVariableRequest(fixture.storage, "session-1", {
        content: "Forged content",
        templateInvocation: base,
      }),
    ).toThrow(/stale or forged/u);
    expect(() =>
      resolveChatRunVariableRequest(fixture.storage, "session-1", {
        content: "Explain leases.",
        templateInvocation: { ...base, schemaHash: "0".repeat(64) },
      }),
    ).toThrow(/schema changed/u);
    const other = fixture.storage.promptPacks.replacePackTests({
      packId: "pack-2",
      name: "Other",
      runVariableSchema: fixture.schema,
      tests: [{ code: "OTHER", title: "Other", prompt: "Other {{topic}}", orderIndex: 0 }],
    });
    expect(() =>
      resolveChatRunVariableRequest(fixture.storage, "session-1", {
        content: "Other leases",
        templateInvocation: { ...base, templateId: other.tests[0]!.testId },
      }),
    ).toThrow(/does not belong/u);
    fixture.storage.close();
  });
});
