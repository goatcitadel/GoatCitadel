import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EVENT_STREAM_PATH,
  IDLE_TRAFFIC_BUDGETS,
  countGatewayRequests,
  countRequestsByPath,
  createIdleTrafficConversation,
  evaluateRequestBudget,
  gatewayRequestPath,
  waitUntil,
} from "./ux-budget-idle-traffic.mjs";

const gateway = "http://127.0.0.1:18787";
const ui = "http://127.0.0.1:18788";

describe("idle-traffic budgets", () => {
  it("passes at the budget and fails one over it", () => {
    assert.deepEqual(evaluateRequestBudget({ count: 12, budget: 12 }), { count: 12, budget: 12, pass: true });
    assert.deepEqual(evaluateRequestBudget({ count: 13, budget: 12 }), { count: 13, budget: 12, pass: false });
    assert.deepEqual(evaluateRequestBudget({ count: 0, budget: 10 }), { count: 0, budget: 10, pass: true });
  });

  it("keeps the idle target of 6 requests a minute", () => {
    assert.equal(IDLE_TRAFFIC_BUDGETS.idlePerTwoMinutes, 12);
    assert.equal(IDLE_TRAFFIC_BUDGETS.chatTurnElsewhere, 10);
    // Measured 46 on GitHub run 37358779646; the bootstrap reductions belong to W4/W8.
    assert.equal(IDLE_TRAFFIC_BUDGETS.openChat, 56);
  });
});

describe("Gateway request filter", () => {
  it("counts Gateway requests by path and strips query strings", () => {
    assert.equal(
      gatewayRequestPath(`${gateway}/api/v1/chat/sessions?token=secret&limit=100`, gateway),
      "/api/v1/chat/sessions",
    );
    assert.equal(gatewayRequestPath(`${gateway}/health`, gateway), "/health");
  });

  it("drops the event stream and other origins", () => {
    assert.equal(gatewayRequestPath(`${gateway}${EVENT_STREAM_PATH}?replay=1`, gateway), null);
    assert.equal(gatewayRequestPath("https://fonts.example.test/css", gateway), null);
    assert.equal(gatewayRequestPath(`${ui}/assets/index.js`, gateway, ui), null);
    assert.equal(gatewayRequestPath("not a url", gateway), null);
  });

  it("counts same-origin API requests when the UI proxies the Gateway", () => {
    assert.equal(
      gatewayRequestPath(`${ui}/api/v1/operator-inbox?workspaceId=w`, gateway, ui),
      "/api/v1/operator-inbox",
    );
    assert.equal(gatewayRequestPath(`${ui}${EVENT_STREAM_PATH}`, gateway, ui), null);
  });

  it("records requests until stopped and groups them by path", () => {
    const listeners = new Set();
    const page = {
      on: (_event, listener) => listeners.add(listener),
      off: (_event, listener) => listeners.delete(listener),
    };
    const counter = countGatewayRequests(page, gateway, { uiOrigin: ui });
    const fire = (url) => {
      for (const listener of listeners) listener({ url: () => url });
    };
    fire(`${gateway}/api/v1/chat/sessions?limit=1`);
    fire(`${gateway}${EVENT_STREAM_PATH}`);
    fire(`${gateway}/api/v1/chat/sessions`);
    fire(`${ui}/assets/app.js`);
    const paths = counter.stop();
    fire(`${gateway}/api/v1/late`);
    assert.deepEqual(paths, ["/api/v1/chat/sessions", "/api/v1/chat/sessions"]);
    assert.equal(listeners.size, 0);
    assert.deepEqual(countRequestsByPath(["/b", "/a", "/b"]), { "/a": 1, "/b": 2 });
  });
});

describe("idle-traffic helpers", () => {
  it("creates a dedicated conversation in the fixture workspace", async () => {
    const calls = [];
    const requestJson = async (base, route, init) => {
      calls.push({ base, route, init });
      return { ok: true, status: 200, body: { sessionId: "s-idle" } };
    };
    const assertOk = (result) => assert.ok(result.ok);
    const sessionId = await createIdleTrafficConversation({ requestJson, assertOk }, gateway, "w-1");
    assert.equal(sessionId, "s-idle");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].route, "/api/v1/chat/sessions");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body.workspaceId, "w-1");
  });

  it("fails when the Gateway returns no conversation", async () => {
    const requestJson = async () => ({ ok: true, status: 200, body: {} });
    await assert.rejects(
      createIdleTrafficConversation({ requestJson, assertOk: () => undefined }, gateway, "w-1"),
      /no conversation/u,
    );
  });

  it("waits until a condition holds and reports a timeout", async () => {
    const page = { waitForTimeout: async () => undefined };
    let polls = 0;
    await waitUntil(page, async () => ++polls >= 3, "never");
    assert.equal(polls, 3);
    await assert.rejects(
      waitUntil(page, async () => false, "Send never became available", 2),
      /Send never/u,
    );
  });
});

describe("idle-traffic scenarios", () => {
  it("registers the three rule 17 scenarios", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./ux-budget-idle-traffic.mjs", import.meta.url), "utf8");
    for (const id of ["two-tabs", "chat-turn-elsewhere", "open-chat"])
      assert.ok(source.includes(`id: "ux-budgets.idle-traffic.${id}"`), id);
    // The turn runs in its own conversation, and Send is clicked only once it is available.
    assert.ok(source.includes("createIdleTrafficConversation(deps, stack.gatewayUrl, fixture.workspaceId)"));
    assert.ok(source.includes("waitUntil(chatPage, () => send.isEnabled()"));
  });
});
