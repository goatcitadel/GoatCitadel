import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftBlueprintFromAnswers } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { CitadelsRouteService } from "./citadels-route-service.js";

let root: string;
let storage: Storage | undefined;
let service: CitadelsRouteService;
const citadelId = "blueprint-validation";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-blueprint-validation-"));
  storage = new Storage({ dbPath: ":memory:", transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") });
  storage.citadels.createRecord({ name: "Blueprint Validation" });
  storage.citadels.upsertCharter({ citadelId, purpose: "Preserve this Charter", kind: "company" });
  storage.citadels.createChamber({ citadelId, name: "Existing chamber", sensitivity: "restricted", sealed: true });
  service = new CitadelsRouteService(createSqliteAsyncStorage(storage).citadels);
}, 60_000);

afterEach(() => {
  storage?.close();
  storage = undefined;
  if (root) {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gc-blueprint-validation-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Citadel blueprint validation at the persistence boundary", () => {
  it.each(["createFromBlueprint", "stageBlueprint"] as const)("%s rejects a malformed later Chamber before any write", async (method) => {
    const before = storage!.citadels.getCitadel(citadelId);
    const writes = vi.spyOn(storage!.citadels, "mutateStructure");
    const blueprint = draftBlueprintFromAnswers({ kind: "company", purpose: "Replace the Charter" });
    const result = await service[method](citadelId, { ...blueprint, chambers: [
      { name: "Valid new chamber", sensitivity: "private", sealed: false },
      { name: "Malformed chamber", sensitivity: "restricted", sealed: "false" },
    ] }, storage!.citadels.getStructureSnapshot(citadelId).revision);

    expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining("chambers.1.sealed")] });
    expect(writes).not.toHaveBeenCalled();
    expect(storage!.citadels.getCitadel(citadelId)).toEqual(before);
  });

  it("continues to stage a complete Mason draft and preserves pre-existing Chambers", async () => {
    const blueprint = draftBlueprintFromAnswers({ kind: "company", purpose: "Stage a valid Charter" });
    const result = await service.stageBlueprint(citadelId, blueprint, storage!.citadels.getStructureSnapshot(citadelId).revision);

    expect(result.ok).toBe(true);
    const persisted = storage!.citadels.getCitadel(citadelId)!;
    expect(persisted.charter.purpose).toBe(blueprint.charter.purpose);
    expect(persisted.chambers).toHaveLength(blueprint.chambers.length + 1);
    expect(persisted.chambers.find((chamber) => chamber.name === "Existing chamber")).toMatchObject({ sensitivity: "restricted", sealed: true });
    expect(storage!.citadels.listIntegrationGrants(citadelId)).toEqual([]);
  });

  it("binds template content and target separately and rejects both stale reviews", async () => {
    const template = service.listTemplates()[0]!;
    expect(template).toMatchObject({ riskPosture: "balanced", modelPolicyDefault: "hybrid_guarded" });
    expect(template.chambers[0]).toMatchObject({ sensitivity: "private", sealed: false });
    const before = await service.getStructureSnapshot(citadelId);
    const writes = vi.spyOn(storage!.citadels, "mutateStructure");
    await expect(service.createFromTemplate(citadelId, template.id, before.revision, "0".repeat(64)))
      .rejects.toMatchObject({ code: "WRITE_CONFLICT", details: { reason: "CITADEL_TEMPLATE_REVISION_CONFLICT" } });
    expect(writes).not.toHaveBeenCalled();
    expect(await service.getStructureSnapshot(citadelId)).toEqual(before);
    const saved = await service.createFromTemplate(citadelId, template.id, before.revision, template.revision);
    expect(saved).toEqual(await service.getStructureSnapshot(citadelId));
    expect(saved!.chambers).toHaveLength(before.chambers.length + template.chambers.length);
    expect(saved!.charter).toMatchObject({ riskPosture: template.riskPosture, modelPolicyDefault: template.modelPolicyDefault });
    await expect(service.createFromTemplate(citadelId, template.id, before.revision, template.revision))
      .rejects.toMatchObject({ code: "WRITE_CONFLICT", details: { reason: "CITADEL_STRUCTURE_REVISION_CONFLICT" } });
    expect(await service.getStructureSnapshot(citadelId)).toEqual(saved);
  });

  it.each(["createFromBlueprint", "stageBlueprint"] as const)("%s rejects a reviewed target after another writer adds a Chamber", async (method) => {
    const reviewed = await service.getStructureSnapshot(citadelId);
    const blueprint = draftBlueprintFromAnswers({ kind: "company", purpose: "Reviewed import" });
    storage!.citadels.createChamber({ citadelId, name: "Peer addition" });
    const winner = await service.getStructureSnapshot(citadelId);
    await expect(service[method](citadelId, blueprint, reviewed.revision))
      .rejects.toMatchObject({ code: "WRITE_CONFLICT", details: { reason: "CITADEL_STRUCTURE_REVISION_CONFLICT" } });
    expect(await service.getStructureSnapshot(citadelId)).toEqual(winner);
  });
});
