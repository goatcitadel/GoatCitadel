import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { RemoteWorkerCellPlatformIdentity } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerCellRepository, type RemoteWorkerCellKey } from "./remote-worker-cell-repo.js";

/** Exercise actual database time and mutation guards on an isolated, profiled cell. */
export async function assertProvisioningLeaseAuthority(
  db: DatabaseClient,
  key: RemoteWorkerCellKey,
  platformIdentity: RemoteWorkerCellPlatformIdentity,
): Promise<void> {
  const repo = new RemoteWorkerCellRepository(db);
  const clock = new DurableRunRepository(db);
  const original = repo.getCell(key);
  const backdated = "2000-01-01T00:00:00.000Z";
  const future = "2099-01-01T00:00:00.000Z";
  const claim = {
    ...key,
    provisioningOwner: "restarted-controller",
    detailSha256: "c".repeat(64),
    now: backdated,
  };
  const publish = { ...claim, platformIdentity };
  const expired = new Date(Date.parse(clock.readDatabaseNow()) - 1_000).toISOString();
  assert.throws(() => repo.claimProvisioning({ ...claim, leaseExpiresAt: expired }), /expire in the future/u);
  assert.deepEqual(repo.getCell(key), original, "an expired initial claim cannot change cell authority");
  assert.deepEqual(repo.listEvidenceAfter(key, 0), []);

  const lease = new Date(Date.parse(clock.readDatabaseNow()) + 5_000).toISOString();
  const claimed = repo.claimProvisioning({ ...claim, leaseExpiresAt: lease });
  assert.ok(claimed);
  assert.equal(claimed.provisioningLeaseExpiresAt, lease);
  assert.ok(claimed.updatedAt > backdated, "the caller clock cannot backdate the committed claim");
  assert.equal(
    repo.claimProvisioning({ ...claim, provisioningOwner: "competing-controller", leaseExpiresAt: future, now: future }),
    undefined,
    "a future caller clock cannot steal an active lease",
  );
  assert.throws(
    () => repo.persistPlatformIdentity({ ...publish, provisioningLeaseExpiresAt: future }),
    /stale or expired/u,
  );
  assert.deepEqual(repo.getCell(key), claimed);
  const claimEvidence = repo.listEvidenceAfter(key, 0);
  assert.equal(claimEvidence.length, 1);

  const waitForExpiry = async (expiresAt: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (clock.readDatabaseNow() < expiresAt) {
      assert.ok(Date.now() < deadline, "database lease must expire within the bounded fixture wait");
      await delay(25);
    }
  };
  await waitForExpiry(lease);
  assert.throws(
    () => repo.persistPlatformIdentity({ ...publish, provisioningLeaseExpiresAt: lease }),
    /stale or expired/u,
    "an expired controller cannot publish by backdating its observation",
  );
  assert.deepEqual(repo.getCell(key), claimed);
  assert.deepEqual(repo.listEvidenceAfter(key, 0), claimEvidence);

  const nextLease = new Date(Date.parse(clock.readDatabaseNow()) + 5_000).toISOString();
  const reclaimed = repo.claimProvisioning({ ...claim, leaseExpiresAt: nextLease });
  assert.ok(reclaimed, "the database clock permits an expired lease to be reclaimed");
  assert.equal(reclaimed.provisioningOwner, claimed.provisioningOwner);
  assert.equal(reclaimed.provisioningLeaseExpiresAt, nextLease);
  assert.throws(
    () => repo.persistPlatformIdentity({ ...publish, provisioningLeaseExpiresAt: lease }),
    /stale or expired/u,
    "reusing a controller name cannot make its previous lease current",
  );
  assert.deepEqual(repo.getCell(key), reclaimed);

  // Pause only the final SQL mutation after the repository has observed a live
  // lease. The real database clock expires while that transaction stays open.
  const prepare = db.prepare.bind(db);
  let mutationPaused = false;
  db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!mutationPaused && /^\s*UPDATE remote_worker_cells/u.test(sql)) {
      mutationPaused = true;
      const remainingMs = Date.parse(nextLease) - Date.parse(clock.readDatabaseNow());
      assert.ok(remainingMs > 0, "the lease must still be live before delaying its SQL mutation");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remainingMs + 25);
      assert.ok(clock.readDatabaseNow() >= nextLease);
    }
    return statement;
  };
  try {
    assert.throws(
      () => repo.persistPlatformIdentity({ ...publish, provisioningLeaseExpiresAt: nextLease }),
      /lost the CAS race/u,
      "the SQL mutation must recheck lease expiry after the earlier JavaScript guard",
    );
  } finally {
    db.prepare = prepare;
  }
  assert.ok(mutationPaused);
  assert.deepEqual(repo.getCell(key), reclaimed);
  assert.deepEqual(repo.listEvidenceAfter(key, 0), claimEvidence);

  const finalClaim = repo.claimProvisioning({ ...claim, leaseExpiresAt: future });
  assert.ok(finalClaim);
  const before = clock.readDatabaseNow();
  const ready = repo.persistPlatformIdentity({ ...publish, provisioningLeaseExpiresAt: future });
  assert.equal(ready.executionState, "ready");
  assert.ok(ready.updatedAt >= before && ready.updatedAt <= clock.readDatabaseNow());
  const evidence = repo.listEvidenceAfter(key, 0);
  assert.equal(evidence.length, 2, "refused claims and publications cannot append successful execution evidence");
  assert.deepEqual(evidence.slice(0, 1), claimEvidence);
}
