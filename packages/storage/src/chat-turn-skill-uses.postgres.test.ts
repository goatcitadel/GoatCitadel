import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatTurnCapabilityProfileRepository } from "./chat-turn-capability-profile-repo.js";
import { allowDirectProfileInserts, insertSkillProfile } from "./chat-turn-skill-uses.test-support.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "PostgreSQL counts the chat turns that loaded each skill as plain numbers",
  { skip: !connectionString },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "skill_use_counts");
    try {
      allowDirectProfileInserts(scope.db);
      const repo = new ChatTurnCapabilityProfileRepository(scope.db);
      insertSkillProfile(scope.db, {
        createdAt: "2026-10-01T00:00:00.000Z",
        activatedSkillIds: ["seo-audit", "seo-audit", "copywriting"],
      });
      insertSkillProfile(scope.db, { createdAt: "2026-10-03T00:00:00.000Z", activatedSkillIds: ["seo-audit"] });
      insertSkillProfile(scope.db, { createdAt: "2026-10-02T00:00:00.000Z", activatedSkillIds: ["seo-audit"] });
      insertSkillProfile(scope.db, { createdAt: "2026-10-05T00:00:00.000Z", activatedSkillIds: ["copywriting"] });
      insertSkillProfile(scope.db, { createdAt: "2026-10-06T00:00:00.000Z" });
      insertSkillProfile(scope.db, { createdAt: "2026-10-07T00:00:00.000Z", trustedSkillIds: ["seo-audit"] });
      insertSkillProfile(scope.db, { createdAt: "2026-08-01T00:00:00.000Z", activatedSkillIds: ["seo-audit"] });

      // COUNT(DISTINCT ...) comes back from PostgreSQL as a bigint string; the repository hands out numbers.
      assert.deepEqual(repo.countSkillUsesSince("2026-09-01T00:00:00.000Z"), [
        { skillId: "copywriting", uses: 2, lastUsedAt: "2026-10-05T00:00:00.000Z" },
        { skillId: "seo-audit", uses: 3, lastUsedAt: "2026-10-03T00:00:00.000Z" },
      ]);
    } finally {
      await scope.teardown();
    }
  },
);
