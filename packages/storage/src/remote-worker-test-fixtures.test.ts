import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";

describe("remote worker PostgreSQL test fixtures", () => {
  it("releases every pre-return resource when scope setup cannot connect", { timeout: 5_000 }, async () => {
    const startedAt = Date.now();

    await assert.rejects(
      createRemoteWorkerPostgresTestScope("postgres://gcproof@127.0.0.1:1/postgres", "remote_worker_unreachable", {
        connectionTimeoutMs: 250,
      }),
      /connect|ECONNREFUSED/iu,
    );

    assert.ok(Date.now() - startedAt < 4_000, "unreachable setup must reject and retire resources promptly");
  });

  it("rejects unsafe schema prefixes before allocating resources", async () => {
    await assert.rejects(
      createRemoteWorkerPostgresTestScope("postgres://unused", "unsafe-prefix"),
      /Invalid remote-worker PostgreSQL test schema prefix/u,
    );
  });
});
