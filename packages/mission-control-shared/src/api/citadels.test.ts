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
  it("getCitadel reads the citadel resource", async () => {
    await citadels.getCitadel("c1");
    expect(lastCall()[0]).toBe("/api/v1/citadels/c1");
  });

  it("encodes ids that contain path separators", async () => {
    await citadels.getMasonSession("a/b");
    expect(lastCall()[0]).toBe("/api/v1/mason/sessions/a%2Fb");
  });

  it("upsertCitadelCharter PUTs the charter body without an id field", async () => {
    await citadels.upsertCitadelCharter("c1", { mission: "Ship" } as never);
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/citadels/c1/charter");
    expect(init?.method).toBe("PUT");
    expect(body(init)).toEqual({ mission: "Ship" });
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
    await citadels.createCitadelFromTemplate("c1", "founder");
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/citadels/c1/from-template");
    expect(init?.method).toBe("POST");
    expect(body(init)).toEqual({ templateId: "founder" });
  });

  it("evaluateCitadelGatehouseAction POSTs the action", async () => {
    await citadels.evaluateCitadelGatehouseAction("c1", "vault.read");
    const [path, init] = lastCall();
    expect(path).toBe("/api/v1/citadels/c1/gatehouse/evaluate");
    expect(body(init)).toEqual({ action: "vault.read" });
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
});
