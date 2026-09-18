import { beforeEach, describe, expect, it, vi } from "vitest";

import * as citadels from "./citadels";

const apiMocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./client-core.js", () => ({
  request: apiMocks.request,
}));

beforeEach(() => {
  apiMocks.request.mockReset();
  apiMocks.request.mockResolvedValue({});
});

function lastCall(): [string, RequestInit | undefined] {
  const [path, init] = apiMocks.request.mock.calls.at(-1) ?? [];
  return [path as string, init as RequestInit | undefined];
}

function body(init: RequestInit | undefined): unknown {
  return init?.body ? JSON.parse(String(init.body)) : undefined;
}

describe("citadel api client", () => {
  it("listCitadels reads the Citadel identity directory with clamped limits", async () => {
    await citadels.listCitadels("all", 999);
    expect(lastCall()[0]).toBe("/api/v1/citadels?view=all&limit=500");
  });

  it("creates, updates, archives, and restores Citadel identity records", async () => {
    const expectedRevision = "a".repeat(64);
    await citadels.createCitadel({ citadelId: "client", name: "Client", kind: "client" } as never);
    expect(lastCall()[0]).toBe("/api/v1/citadels");
    expect(lastCall()[1]?.method).toBe("POST");
    expect(body(lastCall()[1])).toEqual({ citadelId: "client", name: "Client", kind: "client" });

    await citadels.updateCitadel("client/one", { name: "Client One", expectedRevision });
    expect(lastCall()[0]).toBe("/api/v1/citadels/client%2Fone");
    expect(lastCall()[1]?.method).toBe("PATCH");
    expect(body(lastCall()[1])).toEqual({ name: "Client One", expectedRevision });

    await citadels.archiveCitadel("client/one", expectedRevision);
    expect(lastCall()[0]).toBe("/api/v1/citadels/client%2Fone/archive");
    expect(lastCall()[1]?.method).toBe("POST");
    expect(body(lastCall()[1])).toEqual({ expectedRevision });

    await citadels.restoreCitadel("client/one", expectedRevision);
    expect(lastCall()[0]).toBe("/api/v1/citadels/client%2Fone/restore");
    expect(lastCall()[1]?.method).toBe("POST");
    expect(body(lastCall()[1])).toEqual({ expectedRevision });
  });

  it("getCitadel reads the citadel resource", async () => {
    await citadels.getCitadel("c1");
    expect(lastCall()[0]).toBe("/api/v1/citadels/c1");
  });

  it("encodes ids that contain path separators", async () => {
    await citadels.getMasonSession("a/b");
    expect(lastCall()[0]).toBe("/api/v1/mason/sessions/a%2Fb");
  });

  it("upsertCitadelCharter PUTs the charter body without an id field", async () => {
    await citadels.upsertCitadelCharter("c1", { purpose: "Ship", kind: "custom", expectedRevision: "reviewed" });
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/citadels/c1/charter");
    expect(init?.method).toBe("PUT");
    expect(body(init)).toEqual({ purpose: "Ship", kind: "custom", expectedRevision: "reviewed" });
  });

  it("listCitadelChambers unwraps the items envelope", async () => {
    apiMocks.request.mockResolvedValueOnce({ items: [{ chamberId: "ch1" }] });
    const result = await citadels.listCitadelChambers("c1");
    expect(result).toEqual([{ chamberId: "ch1" }]);
    expect(lastCall()[0]).toBe("/api/v1/citadels/c1/chambers");
  });

  it("listCitadelTemplates unwraps the items envelope", async () => {
    apiMocks.request.mockResolvedValueOnce({ items: [{ id: "founder" }] });
    expect(await citadels.listCitadelTemplates()).toEqual([{ id: "founder" }]);
    expect(lastCall()[0]).toBe("/api/v1/citadel-templates");
  });

  it("createCitadelFromTemplate POSTs the templateId", async () => {
    await citadels.createCitadelFromTemplate("c1", "founder", "target-review", "template-review");
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/citadels/c1/from-template");
    expect(init?.method).toBe("POST");
    expect(body(init)).toEqual({ templateId: "founder", expectedRevision: "target-review", expectedTemplateRevision: "template-review" });
  });

  it("reads empty structures and binds Chamber and Blueprint writes to their reviewed target", async () => {
    await citadels.getCitadelStructureSnapshot("c/1");
    expect(lastCall()[0]).toBe("/api/v1/citadels/c%2F1/structure");
    await citadels.createCitadelChamber("c/1", { name: "Reviewed", expectedRevision: "chamber-review" });
    expect(body(lastCall()[1])).toEqual({ name: "Reviewed", expectedRevision: "chamber-review" });
    await citadels.importCitadelBlueprint("c/1", { schemaVersion: "blueprint" } as never, "import-review");
    expect(lastCall()[0]).toBe("/api/v1/citadels/c%2F1/from-blueprint");
    expect(body(lastCall()[1])).toEqual({ blueprint: { schemaVersion: "blueprint" }, expectedRevision: "import-review" });
  });

  it("evaluateCitadelGatehouseAction POSTs the action", async () => {
    await citadels.evaluateCitadelGatehouseAction("c1", "vault.read");
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/citadels/c1/gatehouse/evaluate");
    expect(body(init)).toEqual({ action: "vault.read" });
  });

  it("removeCitadelWard DELETEs the encoded Ward resource", async () => {
    await citadels.removeCitadelWard("c/1", "ward/9", "review");
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/citadels/c%2F1/wards/ward%2F9");
    expect(body(init)).toEqual({ expectedRevision: "review" });
    expect(init?.method).toBe("DELETE");
  });

  it("binds Council and Ward writes to a review and returns the complete owner acknowledgement", async () => {
    const saved = { citadelId: "c/1", revision: "saved", wards: [], council: [] };
    apiMocks.request.mockResolvedValue(saved);
    expect(await citadels.getCitadelAccessSnapshot("c/1")).toEqual(saved);
    expect(lastCall()[0]).toBe("/api/v1/citadels/c%2F1/access");
    expect(await citadels.assignCitadelCouncilAgent("c/1", "agent/1", "review")).toEqual(saved);
    expect(body(lastCall()[1])).toEqual({ agentId: "agent/1", expectedRevision: "review" });
    expect(await citadels.unassignCitadelCouncilAgent("c/1", "agent/1", "review")).toEqual(saved);
    expect(lastCall()[0]).toBe("/api/v1/citadels/c%2F1/council/agent%2F1");
    expect(body(lastCall()[1])).toEqual({ expectedRevision: "review" });
    expect(await citadels.addCitadelWard("c/1", { name: "Deny", actionPattern: "*", effect: "deny", expectedRevision: "review" })).toEqual(saved);
    expect(body(lastCall()[1])).toEqual({ name: "Deny", actionPattern: "*", effect: "deny", expectedRevision: "review" });
  });

  it("validateCitadelBlueprint posts to the shared validate endpoint", async () => {
    await citadels.validateCitadelBlueprint({ anything: true });
    expect(lastCall()[0]).toBe("/api/v1/blueprints/validate");
    expect(lastCall()[1]?.method).toBe("POST");
  });

  it("sendMasonMessage POSTs the freeform message", async () => {
    await citadels.sendMasonMessage("s1", "I run a startup");
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/mason/sessions/s1/message");
    expect(init?.method).toBe("POST");
    expect(body(init)).toEqual({ message: "I run a startup" });
  });

  it("draftBlueprintFromMasonSession POSTs to the session draft endpoint", async () => {
    await citadels.draftBlueprintFromMasonSession("s1");
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/mason/sessions/s1/draft");
    expect(init?.method).toBe("POST");
  });

  it("listCitadelVaultSecrets unwraps the items envelope", async () => {
    apiMocks.request.mockResolvedValueOnce({ items: [{ secretId: "s1", secretName: "stripe" }] });
    expect(await citadels.listCitadelVaultSecrets("c1")).toEqual([{ secretId: "s1", secretName: "stripe" }]);
    expect(lastCall()[0]).toBe("/api/v1/citadels/c1/vault-secrets");
  });

  it("storeCitadelVaultSecret POSTs the name and value", async () => {
    await citadels.storeCitadelVaultSecret("c1", "stripe", "sk-live-123", "a".repeat(64));
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/citadels/c1/vault-secrets");
    expect(init?.method).toBe("POST");
    expect(body(init)).toEqual({ name: "stripe", value: "sk-live-123", expectedRevision: "a".repeat(64) });
  });

  it("revealCitadelVaultSecret GETs the reveal endpoint and returns the value", async () => {
    apiMocks.request.mockResolvedValueOnce({ value: "sk-live-123" });
    expect(await citadels.revealCitadelVaultSecret("c1", "s1")).toBe("sk-live-123");
    expect(lastCall()[0]).toBe("/api/v1/citadels/c1/vault-secrets/s1/reveal");
  });

  it("deleteCitadelVaultSecret DELETEs the secret", async () => {
    await citadels.deleteCitadelVaultSecret("c1", "s1", "a".repeat(64));
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/citadels/c1/vault-secrets/s1");
    expect(init?.method).toBe("DELETE");
    expect(body(init)).toEqual({ expectedRevision: "a".repeat(64) });
  });
});
