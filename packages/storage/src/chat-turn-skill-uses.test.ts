import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChatTurnCapabilityProfileRepository } from "./chat-turn-capability-profile-repo.js";
import { allowDirectProfileInserts, insertSkillProfile } from "./chat-turn-skill-uses.test-support.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createStore() {
  const db = tempDbs.open({ dbPath: tempDbs.path("goatcitadel-chat-turn-skill-uses") });
  allowDirectProfileInserts(db);
  return { db, repo: new ChatTurnCapabilityProfileRepository(db) };
}

describe("ChatTurnCapabilityProfileRepository.countSkillUsesSince", () => {
  it("counts turns per skill with the latest use", () => {
    const { db, repo } = createStore();
    insertSkillProfile(db, {
      createdAt: "2026-10-01T00:00:00.000Z",
      activatedSkillIds: ["seo-audit", "copywriting"],
    });
    insertSkillProfile(db, { createdAt: "2026-10-03T00:00:00.000Z", activatedSkillIds: ["seo-audit"] });
    insertSkillProfile(db, { createdAt: "2026-10-02T00:00:00.000Z", activatedSkillIds: ["seo-audit"] });
    insertSkillProfile(db, { createdAt: "2026-10-05T00:00:00.000Z", activatedSkillIds: ["copywriting"] });

    assert.deepEqual(repo.countSkillUsesSince("2026-09-01T00:00:00.000Z"), [
      { skillId: "copywriting", uses: 2, lastUsedAt: "2026-10-05T00:00:00.000Z" },
      { skillId: "seo-audit", uses: 3, lastUsedAt: "2026-10-03T00:00:00.000Z" },
    ]);
  });

  it("counts a skill once per turn", () => {
    const { db, repo } = createStore();
    insertSkillProfile(db, {
      createdAt: "2026-10-01T00:00:00.000Z",
      activatedSkillIds: ["seo-audit", "seo-audit", "copywriting"],
    });

    assert.deepEqual(repo.countSkillUsesSince("2026-09-01T00:00:00.000Z"), [
      { skillId: "copywriting", uses: 1, lastUsedAt: "2026-10-01T00:00:00.000Z" },
      { skillId: "seo-audit", uses: 1, lastUsedAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });

  it("includes a turn exactly at the window start and leaves out older ones", () => {
    const { db, repo } = createStore();
    insertSkillProfile(db, { createdAt: "2025-10-27T00:00:00.000Z", activatedSkillIds: ["seo-audit"] });
    insertSkillProfile(db, { createdAt: "2025-10-26T23:59:59.999Z", activatedSkillIds: ["seo-audit"] });
    insertSkillProfile(db, { createdAt: "2025-10-20T00:00:00.000Z", activatedSkillIds: ["copywriting"] });

    assert.deepEqual(repo.countSkillUsesSince("2025-10-27T00:00:00.000Z"), [
      { skillId: "seo-audit", uses: 1, lastUsedAt: "2025-10-27T00:00:00.000Z" },
    ]);
  });

  it("ignores turns that loaded no skills", () => {
    const { db, repo } = createStore();
    assert.deepEqual(repo.countSkillUsesSince("2026-09-01T00:00:00.000Z"), []);

    insertSkillProfile(db, { createdAt: "2026-10-01T00:00:00.000Z" });
    // Skills a turn was allowed to use are not skills it loaded.
    insertSkillProfile(db, { createdAt: "2026-10-02T00:00:00.000Z", trustedSkillIds: ["seo-audit"] });
    insertSkillProfile(db, { createdAt: "2026-10-03T00:00:00.000Z", activatedSkillIds: [] });

    assert.deepEqual(repo.countSkillUsesSince("2026-09-01T00:00:00.000Z"), []);
  });
});
