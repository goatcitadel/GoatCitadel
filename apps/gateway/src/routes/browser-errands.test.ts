import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { BrowserErrandService } from "../services/browser-errands/browser-errand-service.js";
import {
  buildService,
  errandRequest,
  fakeGate,
  outcome,
} from "../services/browser-errands/browser-errand-test-fixtures.js";
import { browserErrandsRoutes } from "./browser-errands.js";

describe("browser errand routes", () => {
  let app: FastifyInstance | undefined;
  let service: BrowserErrandService | undefined;

  afterEach(async () => {
    await app?.close();
    await service?.dispose();
    app = undefined;
    service = undefined;
  });

  async function buildApp(errands: BrowserErrandService) {
    service = errands;
    app = Fastify();
    app.decorateRequest("authActorId", "operator-test");
    app.decorateRequest("authActorSource", "loopback");
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("gatewayRuntime", { browserErrandService: errands });
    await app.register(browserErrandsRoutes);
    return app;
  }

  it("stop route stops a running errand and withdraws its pending approval", async () => {
    let approvalAsked!: () => void;
    const asked = new Promise<void>((resolve) => (approvalAsked = resolve));
    // The gate waits on the operator until the errand's signal aborts, like the real one.
    const gate = fakeGate(vi.fn);
    const built = buildService(vi.fn, {
      createGate: (deps) => {
        gate.request = vi.fn(
          () =>
            new Promise<"stopped">((resolve) => {
              approvalAsked();
              deps.signal.addEventListener("abort", () => resolve("stopped"), { once: true });
            }),
        );
        return gate;
      },
      runLoop: async (deps) => {
        const answer = await deps.requestApproval({} as never);
        return outcome(answer === "stopped" ? "stopped" : "done");
      },
    });
    const fastify = await buildApp(built.service);
    const running = built.service.run(errandRequest());
    await asked;

    const status = await fastify.inject({ method: "GET", url: "/api/v1/browser-errands/by-tool-run/tool-run-1" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ toolRunId: "tool-run-1", state: "waiting_on_you" });
    const errandId = status.json().errandId as string;

    const stopped = await fastify.inject({ method: "POST", url: `/api/v1/browser-errands/${errandId}/stop` });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual({ stopped: true });
    expect(gate.withdrawPending).toHaveBeenCalledWith("operator-test");
    await expect(running).resolves.toMatchObject({ outcome: "stopped" });

    const again = await fastify.inject({ method: "POST", url: `/api/v1/browser-errands/${errandId}/stop` });
    expect(again.json()).toEqual({ stopped: false });
    const finished = await fastify.inject({ method: "GET", url: "/api/v1/browser-errands/by-tool-run/tool-run-1" });
    expect(finished.json()).toMatchObject({ state: "finished", outcome: "stopped" });
  });

  it("status route returns 404 for an unknown tool run", async () => {
    const fastify = await buildApp(buildService(vi.fn).service);
    const response = await fastify.inject({ method: "GET", url: "/api/v1/browser-errands/by-tool-run/nope" });
    expect(response.statusCode).toBe(404);
  });
});
