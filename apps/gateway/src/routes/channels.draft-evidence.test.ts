import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import { cleanupIntegrationTestApp, decorateIntegrationServices, integrationsRoutes } from "./integrations-test-fixtures.js";
const draftId = "11111111-1111-4111-8111-111111111111";
describe("draft setup evidence reads", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { if (app) await cleanupIntegrationTestApp(app); app = undefined; });
  it("reads exact revision with no-store headers and no mutation or live action", async () => {
    const response = { draftId, draftRevision: 7, items: [{ evidenceId: "receipt", draftRevision: 5, phase: "test" }], currentTest: { draftId, draftRevision: 7, evidenceId: "receipt", finalizationEligibility: { allowed: true, evidenceId: "receipt", blockingReasons: [] } } };
    const read = vi.fn(async () => response); const test = vi.fn(); const update = vi.fn();
    app = Fastify(); decorateIntegrationServices(app, { getChannelSetupDraftEvidence: read, testChannelSetupDraft: test, updateChannelSetupDraft: update }); await app.register(integrationsRoutes);
    const result = await app.inject({ method: "GET", url: "/api/v1/channels/drafts/" + draftId + "/evidence?expectedRevision=7" });
    expect(result.statusCode).toBe(200); expect(result.headers["cache-control"]).toBe("no-store"); expect(result.headers.pragma).toBe("no-cache");
    expect(read).toHaveBeenCalledExactlyOnceWith(draftId, 7); expect(result.json()).toEqual(response); expect(test).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });
  it.each(["", "?expectedRevision=0", "?expectedRevision=-1", "?expectedRevision=1.5", "?expectedRevision=no", "?expectedRevision=1&limit=1000", "?expectedRevision=1&expectedRevision=2"])("rejects invalid or unbound evidence query %s", async (query) => {
    const read = vi.fn(); app = Fastify(); decorateIntegrationServices(app, { getChannelSetupDraftEvidence: read }); await app.register(integrationsRoutes);
    const result = await app.inject({ method: "GET", url: "/api/v1/channels/drafts/" + draftId + "/evidence" + query });
    expect(result.statusCode).toBe(400); expect(read).not.toHaveBeenCalled();
  });
  it.each([new ConflictError({ code: "WRITE_CONFLICT", message: "Draft changed." }), new NotFoundError({ entity: "channel_setup_draft", id: draftId })])("preserves canonical read owner failures", async (failure) => {
    app = Fastify(); decorateIntegrationServices(app, { getChannelSetupDraftEvidence: vi.fn(async () => { throw failure; }) }); await app.register(integrationsRoutes);
    const result = await app.inject({ method: "GET", url: "/api/v1/channels/drafts/" + draftId + "/evidence?expectedRevision=7" });
    expect(result.statusCode).toBe(failure.httpStatus); expect(result.json().code).toBe(failure.code); expect(result.headers["cache-control"]).toBe("no-store");
  });
});
