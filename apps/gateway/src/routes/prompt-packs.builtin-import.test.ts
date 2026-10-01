import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { BuiltinPromptPackPostCommitError } from "../services/prompt-pack/builtin-import-errors.js";
import { promptPackRoutes } from "./prompt-packs.js";

const payload = { expectedDefinitionRevision: "a".repeat(64) };
const url = "/api/v1/prompt-packs/builtins/security-red-team-v6/import-if-absent";
const receipt = {
  pack: { packId: "security-red-team-v6" },
  tests: [],
  importReceipt: {
    version: "prompt_pack.builtin_import_receipt.v1",
    operation: "created",
    packKey: "security-red-team-v6",
    definitionRevision: payload.expectedDefinitionRevision,
    contentSha256: "b".repeat(64),
  },
};
let app: FastifyInstance | undefined;
let storage: Storage | undefined;
let root: string | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  storage?.close();
  storage = undefined;
  if (root) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("gc-builtin-route-"))
      throw new Error("Unexpected fixture path");
    fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

async function setup(idempotency = false) {
  const owner = vi.fn(async () => receipt);
  app = Fastify();
  app.decorate("services", { promptPacks: { importBuiltinPromptPack: owner } } as never);
  if (idempotency) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-builtin-route-"));
    storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    app.decorateRequest("authActorId", "operator:test");
    await app.register(idempotencyHeaderPlugin, { mutationStore: storage.mutationIdempotency });
  }
  await app.register(promptPackRoutes);
  return owner;
}

describe("create-only built-in import route", () => {
  it("strictly validates the review condition and forwards it through the existing owner", async () => {
    const owner = await setup();
    for (const invalid of [
      {},
      { expectedDefinitionRevision: "short" },
      { ...payload, replace: true },
      { ...payload, packId: "other" },
    ]) {
      expect((await app!.inject({ method: "POST", url, payload: invalid })).statusCode).toBe(400);
    }
    expect(owner).not.toHaveBeenCalled();
    const response = await app!.inject({ method: "POST", url, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(receipt);
    expect(owner).toHaveBeenCalledExactlyOnceWith("security-red-team-v6", payload);
  });

  it("preserves structured conflicts and keeps a rejected precommit claim retryable", async () => {
    const owner = await setup(true);
    owner.mockRejectedValueOnce(
      new ConflictError({
        code: "WRITE_CONFLICT",
        message: "Review changed definition",
        details: { reason: "PROMPT_PACK_DEFINITION_CONFLICT", mutationCommitted: false },
      }),
    );
    const request = { method: "POST" as const, url, payload, headers: { "Idempotency-Key": "precommit" } };
    const first = await app!.inject(request);
    expect(first.statusCode).toBe(409);
    expect(first.json()).toMatchObject({
      code: "WRITE_CONFLICT",
      details: { reason: "PROMPT_PACK_DEFINITION_CONFLICT", mutationCommitted: false },
    });
    expect((await app!.inject(request)).statusCode).toBe(200);
    expect(owner).toHaveBeenCalledTimes(2);
  });

  it("retains a committed claim when follow-up fails instead of replaying the mutation", async () => {
    const owner = await setup(true);
    owner.mockRejectedValueOnce(new BuiltinPromptPackPostCommitError("security-red-team-v6"));
    const request = { method: "POST" as const, url, payload, headers: { "Idempotency-Key": "committed" } };
    const first = await app!.inject(request);
    expect(first.statusCode).toBe(503);
    expect(first.json()).toMatchObject({
      details: { mutationCommitted: true, reason: "PROMPT_PACK_IMPORT_POST_COMMIT" },
    });
    expect((await app!.inject(request)).statusCode).toBe(409);
    expect(owner).toHaveBeenCalledTimes(1);
    expect(
      storage!.mutationIdempotency.get({
        method: "POST",
        routePath: "/api/v1/prompt-packs/builtins/:packKey/import-if-absent",
        idempotencyKey: "committed",
        actorScope: "operator:test",
      })?.status,
    ).toBe("completed");
  });

  it("marks a successful canonical write before response serialization can fail", async () => {
    const owner = await setup(true);
    app!.addHook("preSerialization", (_request, _reply, result, done) => {
      if ((result as typeof receipt).importReceipt) done(new Error("private serializer failure"));
      else done(null, result);
    });
    const request = { method: "POST" as const, url, payload, headers: { "Idempotency-Key": "serialization" } };
    expect((await app!.inject(request)).statusCode).toBe(500);
    expect((await app!.inject(request)).statusCode).toBe(409);
    expect(owner).toHaveBeenCalledTimes(1);
  });
});
