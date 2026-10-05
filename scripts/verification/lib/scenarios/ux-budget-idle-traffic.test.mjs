import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EVENT_STREAM_PATH,
  IDLE_TRAFFIC_BUDGETS,
  countGatewayRequests,
  countRequestsByPath,
  evaluateRequestBudget,
  gatewayRequestPath,
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
    assert.ok(IDLE_TRAFFIC_BUDGETS.openChat >= 20);
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

describe("idle-traffic scenarios", () => {
  it("registers the three rule 17 scenarios", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./ux-budget-idle-traffic.mjs", import.meta.url), "utf8");
    for (const id of ["two-tabs", "chat-turn-elsewhere", "open-chat"])
      assert.ok(source.includes(`id: "ux-budgets.idle-traffic.${id}"`), id);
  });
});
