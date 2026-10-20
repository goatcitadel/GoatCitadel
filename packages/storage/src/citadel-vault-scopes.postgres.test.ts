import { test } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { verifyCitadelVaultScopes } from "./citadel-vault-scopes.test-support.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test(
  "PostgreSQL Vault secrets are scoped to Chambers with active-key checks",
  { skip: !connectionString },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "citadel_vault_scopes");
    try {
      verifyCitadelVaultScopes(scope.db);
    } finally {
      await scope.teardown();
    }
  },
);
