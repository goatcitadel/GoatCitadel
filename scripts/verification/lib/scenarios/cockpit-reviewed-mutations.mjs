import assert from "node:assert/strict";
import { assertCitadelPresenceHeartbeat } from "./cockpit-citadel-directory-proof.mjs";
import { recordCockpitObserverRequest, assertCockpitObserverRequests } from "./cockpit-observer-requests.mjs";

/** Classify background leases separately, without hiding arbitrary owner writes or shrinking totals. */
export function createReviewedMutationRecorder() {
  const writes = [], presence = [], observers = [];
  let total = 0;
  return {
    writes, presence, observers,
    get total() { return total; },
    record(request) {
      const pathname = new URL(request.url()).pathname, method = request.method();
      if (!pathname.startsWith("/api/") || !["POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
      total += 1;
      if (recordCockpitObserverRequest(request, observers)) return;
      const entry = { method, pathname, body: request.postDataJSON() };
      if (pathname !== "/api/v1/notifications/presence") { writes.push(entry); return; }
      entry.completed = request.response().then(async response => {
        assert.ok(response, "Presence lease has no owner response");
        entry.status = response.status(); entry.receipt = await response.json();
      }).catch(error => { entry.error = error; });
      presence.push(entry);
    },
    async assertBackground(expected) {
      await assertCockpitObserverRequests(observers);
      await Promise.all(presence.map(entry => entry.completed));
      for (const entry of presence) { if (entry.error) throw entry.error; assertCitadelPresenceHeartbeat(entry, expected); }
    },
    async assertPageBackground(page, workspaceId) {
      const clientId = await page.evaluate(() => window.sessionStorage.getItem("goatcitadel.notification-client-id"));
      // The mounted notification owner creates its lease in memory (not sessionStorage).
      // These fixed-workspace settings/Inbox pages retain that same mounted lease throughout.
      const leaseId = presence[0]?.body.leaseId;
      assert.ok(typeof leaseId === "string" && leaseId.length > 0, "Expected the mounted notification presence lease");
      await this.assertBackground({ clientId, leaseId, workspaceId });
    },
  };
}
