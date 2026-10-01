import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, RUN_VARIABLE_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { createDatabase } from "../../../../packages/storage/src/sqlite.js";
import { PromptPackRepository } from "../../../../packages/storage/src/prompt-pack-repo.js";
import { PromptPackService } from "./prompt-pack-service.js";
import { builtinDefinitionRevision, SECURITY_RED_TEAM_PACK_FILE } from "./prompt-pack/builtin-definition.js";
import { preparePromptPackImport } from "./prompt-pack/prepare-import.js";
import { renderPromptPackRunVariableSchema } from "./prompt-pack/run-variable-markdown.js";

const packKey = "security-red-team-v6";
const markdown = "# Review fixture\n\n# Chat\n\n## No Tools\n\n### TEST-C901: Stored definition\n\nAnswer briefly.\n";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-builtin-import-"));
  cleanups.push(() => {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("gc-builtin-import-"))
      throw new Error("Unexpected fixture path");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const db = createDatabase({ dbPath: ":memory:" });
  cleanups.push(() => db.close());
  const repository = new PromptPackRepository(db);
  const file = path.join(root, "eval-assets", SECURITY_RED_TEAM_PACK_FILE);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, markdown);
  const create = vi.spyOn(repository, "createPackWithTestsIfAbsent");
  const replace = vi.spyOn(repository, "replacePackTests");
  const requireFeatureEnabled = vi.fn();
  const callbacks = {
    createChatSession: vi.fn(),
    agentSendChatMessage: vi.fn(),
    createChatCompletion: vi.fn(),
    getPromptRunnerModelDefaults: vi.fn(),
    getPromptJudgeModelDefaults: vi.fn(),
    backgroundTasks: new Set<Promise<unknown>>(),
  };
  const service = new PromptPackService(
    {
      storage: { promptPacks: repository },
      config: { rootDir: root },
      requireFeatureEnabled,
      isFeatureEnabled: () => true,
    } as never,
    callbacks as never,
  );
  const refresh = vi
    .spyOn(service as never, "refreshPromptPackExportFileBestEffort")
    .mockResolvedValue(undefined as never);
  return { service, repository, file, create, replace, refresh, requireFeatureEnabled, callbacks };
}

describe("guarded built-in prompt-pack import owner", () => {
  it("advertises the exact absent key, imports that reviewed definition, and never runs it", async () => {
    const fixture = setup();
    fixture.repository.replacePackTests({ packId: "unrelated-copy", name: "Defensive Security Evaluation", tests: [] });
    // A bounded legacy evidence list cannot establish absence at the fixed key.
    vi.spyOn(fixture.repository, "listPacks").mockReturnValue([]);
    const advertised = (await fixture.service.listSecurityEvalPacks()).items[0]!.importCapability!;
    expect(advertised).toMatchObject({
      version: "prompt_pack.builtin_import.v1",
      operation: "create_only",
      packId: packKey,
      targetState: "absent",
    });
    const result = await fixture.service.importBuiltinPromptPack(packKey, {
      expectedDefinitionRevision: advertised.definitionRevision,
    });
    expect(result.importReceipt).toEqual({
      version: "prompt_pack.builtin_import_receipt.v1",
      operation: "created",
      packKey,
      definitionRevision: advertised.definitionRevision,
      contentSha256: advertised.contentSha256,
    });
    expect(result.pack).toEqual(fixture.repository.getPack(packKey));
    expect(result.tests).toEqual(fixture.repository.listTests(packKey));
    expect(result.tests).toHaveLength(1);
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect((await fixture.service.listSecurityEvalPacks()).items[0]!.importCapability?.targetState).toBe("present");
    expect(fixture.callbacks.createChatSession).not.toHaveBeenCalled();
    expect(fixture.callbacks.agentSendChatMessage).not.toHaveBeenCalled();
    expect(fixture.callbacks.createChatCompletion).not.toHaveBeenCalled();
  });

  it("recognizes a custom definition at the fixed key and preserves it on conflict", async () => {
    const fixture = setup();
    const first = fixture.repository.replacePackTests({
      packId: packKey,
      name: "My reviewed custom pack",
      tests: [{ code: "CUSTOM", title: "Mine", prompt: "Preserve this", orderIndex: 0 }],
    });
    const advertised = (await fixture.service.listSecurityEvalPacks()).items[0]!.importCapability!;
    expect(advertised.targetState).toBe("present");
    expect((await fixture.service.listSecurityEvalPacks()).items[0]!.importedPackId).toBeUndefined();
    await expect(
      fixture.service.importBuiltinPromptPack(packKey, { expectedDefinitionRevision: advertised.definitionRevision }),
    ).rejects.toMatchObject({
      code: "WRITE_CONFLICT",
      details: { reason: "PROMPT_PACK_ALREADY_EXISTS", mutationCommitted: false },
    });
    expect(fixture.repository.getPack(packKey)).toEqual(first.pack);
    expect(fixture.repository.listTests(packKey)).toEqual(first.tests);
    expect(fixture.replace).toHaveBeenCalledTimes(1);
    expect(fixture.refresh).not.toHaveBeenCalled();
  });

  it("rejects a changed bundled definition before storage and withholds invalid definitions", async () => {
    const fixture = setup();
    const advertised = (await fixture.service.listSecurityEvalPacks()).items[0]!.importCapability!;
    fs.appendFileSync(fixture.file, "\nDifferent definition bytes.\n");
    await expect(
      fixture.service.importBuiltinPromptPack(packKey, { expectedDefinitionRevision: advertised.definitionRevision }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(fixture.create).not.toHaveBeenCalled();
    fs.writeFileSync(fixture.file, "Invalid bundled definition");
    expect((await fixture.service.listSecurityEvalPacks()).items[0]!.importCapability).toBeUndefined();
    expect(() => fixture.repository.getPack(packKey)).toThrow(NotFoundError);
  });

  it("retains committed truth if a follow-up throws, so retry cannot replace the pack", async () => {
    const fixture = setup();
    const { definitionRevision } = (await fixture.service.listSecurityEvalPacks()).items[0]!.importCapability!;
    fixture.refresh.mockRejectedValueOnce(new Error("private export diagnostic") as never);
    await expect(
      fixture.service.importBuiltinPromptPack(packKey, { expectedDefinitionRevision: definitionRevision }),
    ).rejects.toMatchObject({
      mutationCommitted: true,
      details: { reason: "PROMPT_PACK_IMPORT_POST_COMMIT", mutationCommitted: true },
    });
    const first = fixture.repository.getPack(packKey);
    await expect(
      fixture.service.importBuiltinPromptPack(packKey, { expectedDefinitionRevision: definitionRevision }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(fixture.repository.getPack(packKey)).toEqual(first);
  });

  it("keeps explicit legacy replacement available without create-only receipt", async () => {
    const fixture = setup();
    const first = await fixture.service.importBuiltinPromptPack(packKey);
    fs.appendFileSync(fixture.file, "\nExplicit replacement.\n");
    const next = await fixture.service.importBuiltinPromptPack(packKey);
    expect(next.pack.contentSha256).not.toBe(first.pack.contentSha256);
    expect(next.importReceipt).toBeUndefined();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.replace).toHaveBeenCalledTimes(2);
  });

  it("binds prepared metadata and parsed tests as well as the source bytes", () => {
    const prepared = preparePromptPackImport({ content: markdown, packId: packKey }).write;
    const revision = builtinDefinitionRevision(packKey, prepared);
    expect(builtinDefinitionRevision(packKey, { ...prepared })).toBe(revision);
    expect(builtinDefinitionRevision(packKey, { ...prepared, name: "Changed" })).not.toBe(revision);
    expect(
      builtinDefinitionRevision(packKey, { ...prepared, tests: [{ ...prepared.tests[0]!, prompt: "Changed" }] }),
    ).not.toBe(revision);
    expect(builtinDefinitionRevision("another-key", prepared)).not.toBe(revision);
  });

  it("keeps typed-schema feature admission before the canonical write", async () => {
    const fixture = setup();
    const schema = renderPromptPackRunVariableSchema({
      version: RUN_VARIABLE_SCHEMA_VERSION,
      fields: [{ id: "topic", label: "Topic", type: "text", required: true }],
    }).join("\n");
    fs.writeFileSync(fixture.file, `${schema}\n${markdown}`);
    const advertised = (await fixture.service.listSecurityEvalPacks()).items[0]!.importCapability!;
    fixture.requireFeatureEnabled.mockRejectedValueOnce(new Error("Feature disabled"));
    await expect(
      fixture.service.importBuiltinPromptPack(packKey, { expectedDefinitionRevision: advertised.definitionRevision }),
    ).rejects.toThrow("Feature disabled");
    expect(fixture.requireFeatureEnabled).toHaveBeenCalledExactlyOnceWith("typedRunVariablesV1Enabled");
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("does not turn an unreadable occupancy owner into an absent-key advertisement", async () => {
    const fixture = setup();
    vi.spyOn(fixture.repository, "getPack").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    await expect(fixture.service.listSecurityEvalPacks()).rejects.toThrow("Storage unavailable");
    await expect(
      fixture.service.importBuiltinPromptPack("unknown-builtin", { expectedDefinitionRevision: "a".repeat(64) }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fixture.create).not.toHaveBeenCalled();
  });
});
