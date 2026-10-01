import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMcpOAuthStartAgreement } from "./cockpit-mcp-oauth-proof.mjs";
function example() {
  const before = { serverId: "fixture", label: "Fixture", status: "disconnected", revision: "a".repeat(64),
    oauth: { authorizationUrl: "https://example.invalid/authorize", tokenUrl: "https://example.invalid/token", redirectUri: "http://127.0.0.1/manual", scopes: ["inspect"] } };
  const request = { expectedRevision: before.revision, expectedConnectionRevision: null };
  const owner = { ...before, connectionRevision: "c".repeat(64), authState: { readiness: "needs_auth" } };
  const state = "11111111-1111-4111-8111-111111111111", url = new URL(before.oauth.authorizationUrl);
  url.searchParams.set("state", state); url.searchParams.set("response_type", "code"); url.searchParams.set("redirect_uri", before.oauth.redirectUri); url.searchParams.set("scope", "inspect");
  return { before, request, owner, receipt: { state, authorizeUrl: url.toString(), review: { version: 1, reviewed: request, server: structuredClone(owner) } } };
}
test("binds synthetic handshake to exact configured owner and URL without claiming authentication", () => assertMcpOAuthStartAgreement(example()));
test("rejects stale guards, foreign URL/state, execution claims and different owner evidence", () => {
  for (const change of [value => { value.request.expectedRevision = "d".repeat(64); }, value => { value.receipt.authorizeUrl = value.receipt.authorizeUrl.replace("example.invalid", "foreign.invalid"); },
    value => { value.receipt.state = "22222222-2222-4222-8222-222222222222"; }, value => { value.owner.status = "connected"; },
    value => { value.owner.authState.readiness = "ready"; }, value => { value.owner.serverId = "foreign"; },
    value => { value.receipt.authorizeUrl += "&state=other"; }]) { const value = example(); change(value); assert.throws(() => assertMcpOAuthStartAgreement(value)); }
});
