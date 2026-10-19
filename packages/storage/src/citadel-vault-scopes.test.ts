import { after, test } from "node:test";
import { verifyCitadelVaultScopes } from "./citadel-vault-scopes.test-support.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();
after(() => tempDbs.cleanup());

test("SQLite Vault secrets are scoped to Chambers with active-key checks", () => {
  verifyCitadelVaultScopes(tempDbs.open({ dbPath: tempDbs.path("gc-citadel-vault-scopes") }));
});
