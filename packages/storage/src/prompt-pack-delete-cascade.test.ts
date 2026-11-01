import { afterEach, describe, it } from "node:test";
import { verifyDeletePackCascade } from "./prompt-pack-delete-cascade.test-support.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

describe("PromptPackRepository.deletePackCascade on SQLite", () => {
  it("deletes its prompt packs with every run and score", async () => {
    await verifyDeletePackCascade(tempDbs.open({ dbPath: tempDbs.path("goatcitadel-prompt-pack-delete") }));
  });
});
