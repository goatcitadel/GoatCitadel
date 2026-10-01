import assert from "node:assert/strict";

export function assertCockpitObserverRequest(entry, expected = {}) {
  assert.equal(entry.method, "POST");
  if (entry.pathname === "/api/v1/auth/sse-token") {
    assert.deepEqual(entry.body, { scope: "events:stream" });
    return "event-bridge";
  }
  assert.ok(expected.sessionId && expected.prefsOverride, "No Chat inspection scope was supplied.");
  assert.equal(entry.pathname, `/api/v1/chat/sessions/${encodeURIComponent(expected.sessionId)}/route-preflight`);
  const basic = { action: "send", fullWebAccess: true };
  assert.deepEqual(
    entry.body,
    Object.hasOwn(entry.body, "prefsOverride") ? { ...basic, prefsOverride: expected.prefsOverride } : basic,
  );
  return "route-inspection";
}

/** Records the exact auth bridge/route inspection separately from owner mutations.
 * The ephemeral token is validated in memory and never retained in evidence. */
export function recordCockpitObserverRequest(request, entries, expected = {}) {
  const pathname = new URL(request.url()).pathname;
  if (
    pathname !== "/api/v1/auth/sse-token" &&
    (!expected.sessionId ||
      pathname !== `/api/v1/chat/sessions/${encodeURIComponent(expected.sessionId)}/route-preflight`)
  )
    return false;
  const entry = { method: request.method(), pathname, body: request.postDataJSON() };
  entry.completed = (async () => {
    entry.kind = assertCockpitObserverRequest(entry, expected);
    const response = await request.response();
    assert.ok(response && response.status() === 200, "Observer owner request failed.");
    const receipt = await response.json();
    if (entry.kind === "event-bridge") {
      assert.deepEqual(Object.keys(receipt).sort(), ["expiresAt", "scope", "token"]);
      assert.equal(receipt.scope, "events:stream");
      assert.ok(
        typeof receipt.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(receipt.token),
        "Malformed ephemeral event bridge token.",
      );
      const remainingMs = Date.parse(receipt.expiresAt) - Date.now();
      assert.ok(remainingMs > 0 && remainingMs <= 600_000, "Invalid event bridge lifetime.");
      entry.evidence = { scope: receipt.scope, expiresAt: receipt.expiresAt };
    } else {
      assert.equal(receipt.decision.effectiveProviderId, expected.prefsOverride.providerId);
      assert.equal(receipt.decision.effectiveModel, expected.prefsOverride.model);
      entry.evidence = { providerId: receipt.decision.effectiveProviderId, model: receipt.decision.effectiveModel };
    }
  })().catch((error) => {
    entry.error = error;
  });
  entries.push(entry);
  return true;
}

export async function assertCockpitObserverRequests(entries) {
  await Promise.all(entries.map((entry) => entry.completed));
  for (const entry of entries) if (entry.error) throw entry.error;
}
