import assert from "node:assert/strict";
import test from "node:test";
import { seedMissionControlNextFixture } from "./fixture-seeding.mjs";

test("fails when the seeded thread has no artifact turn", async () => {
  const requests = [];
  const requestJson = async (_gatewayUrl, path) => {
    requests.push(path);
    if (path === "/api/v1/dev/verification/seed") {
      return { ok: true, body: { workspaceId: "workspace-1", sessionId: "session-1" } };
    }
    return { ok: true, body: { turns: [] } };
  };

  await assert.rejects(
    seedMissionControlNextFixture("http://gateway.test", {}, {
      assertOk(response) {
        assert.equal(response.ok, true);
      },
      randomUUID: () => "00000000-0000-0000-0000-000000000000",
      requestJson,
      stabilizeMissionControlNextFileFixtureMtime: async () => {},
    }),
    /did not return an artifact turn/,
  );
  assert.deepEqual(requests, [
    "/api/v1/dev/verification/seed",
    "/api/v1/chat/sessions/session-1/thread",
  ]);
});
