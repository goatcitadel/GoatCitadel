import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExternalSourceRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ExternalSourceConfigRepository, sealExternalSourceRecord } from "./external-source-config-repo.js";
import {
  ExternalSourceScanRepository,
  sealExternalSourceCatalogItem,
  sealExternalSourceScanRecord,
} from "./external-source-scan-repo.js";
import { seedExternalSourceCatalog } from "./external-source-test-fixtures.js";
import { createDatabase } from "./sqlite.js";

const databases: DatabaseClient[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function createStore(): DatabaseClient {
  const db = createDatabase({ dbPath: ":memory:" });
  databases.push(db);
  return db;
}

describe("HX-407 external source config and sealed catalog repositories", () => {
  it("binds config to verified path identity, exact replay, immutable identity, CAS, and terminal revoke", () => {
    const db = createStore();
    const fixture = seedExternalSourceCatalog(db);
    const configs = new ExternalSourceConfigRepository(db);

    assert.deepEqual(configs.create(fixture.config), fixture.config);
    assert.deepEqual(configs.create(fixture.config), fixture.config);

    const { configSha256: _configSha256, ...draft } = fixture.config;
    const revisionTwo = sealExternalSourceRecord({
      ...draft,
      label: "Synthetic source revision two",
      revision: 2,
      updatedAt: "2026-07-14T08:00:01.000Z",
    });
    assert.deepEqual(configs.updateCas(revisionTwo, 1, 16), revisionTwo);
    assert.throws(() => configs.updateCas(revisionTwo, 1, 16), /revision changed|invalid expected revision/u);

    const { configSha256: _revisionTwoHash, ...revisionTwoDraft } = revisionTwo;
    const rootDrift = sealExternalSourceRecord({
      ...revisionTwoDraft,
      canonicalRootPath: "F:\\synthetic\\codex\\drifted",
      revision: 3,
      updatedAt: "2026-07-14T08:00:02.000Z",
    });
    assert.throws(() => configs.updateCas(rootDrift, 2, 16), /immutable identity|path identity/u);

    const revoked = sealExternalSourceRecord({
      ...revisionTwoDraft,
      status: "revoked",
      revision: 3,
      updatedAt: "2026-07-14T08:00:03.000Z",
    });
    assert.equal(configs.updateCas(revoked, 2, 16).status, "revoked");
    const { configSha256: _revokedHash, ...revokedDraft } = revoked;
    const attemptedRestore = sealExternalSourceRecord({
      ...revokedDraft,
      status: "disabled",
      revision: 4,
      updatedAt: "2026-07-14T08:00:04.000Z",
    });
    assert.throws(() => configs.updateCas(attemptedRestore, 3, 16), /revoked/u);
    assert.throws(
      () =>
        db
          .prepare("DELETE FROM external_source_configs WHERE workspace_id = ? AND source_id = ?")
          .run("default", fixture.config.sourceId),
      /cannot be deleted/u,
    );
  });

  it("enforces the frozen 16-active-root hard cap in storage", () => {
    const db = createStore();
    const configs = new ExternalSourceConfigRepository(db);
    const activeConfigs = [];
    for (let index = 0; index < 16; index += 1) {
      const fixture = seedExternalSourceCatalog(db, {
        sourceId: `cap-source-${index}`,
        scanId: `cap-scan-${index}`,
        rootSuffix: `cap-${index}`,
        itemCount: 0,
      });
      configs.create(fixture.config);
      activeConfigs.push(fixture.config);
    }
    const first = activeConfigs[0]!;
    assert.deepEqual(configs.create(first), first);
    const { configSha256: _configSha256, ...firstDraft } = first;
    const conflictingReplay = sealExternalSourceRecord({
      ...firstDraft,
      label: "Same source ID with different canonical material",
    });
    assert.throws(() => configs.create(conflictingReplay), /conflicts with an existing canonical record/u);
    const overflow = seedExternalSourceCatalog(db, {
      sourceId: "cap-source-overflow",
      scanId: "cap-scan-overflow",
      rootSuffix: "cap-overflow",
      itemCount: 0,
    });
    assert.throws(() => configs.create(overflow.config), /active root|storage invariant/u);
  });

  it("atomically binds registration to an active expected workspace revision", () => {
    const db = createStore();
    const configs = new ExternalSourceConfigRepository(db);
    const first = seedExternalSourceCatalog(db, {
      sourceId: "workspace-cas-source-1",
      scanId: "workspace-cas-scan-1",
      itemCount: 0,
    });
    assert.deepEqual(configs.createForActiveWorkspace(first.config, 1, 16), first.config);

    db.prepare("UPDATE workspaces SET revision = revision + 1 WHERE workspace_id = ?").run("default");
    const stale = seedExternalSourceCatalog(db, {
      sourceId: "workspace-cas-source-2",
      scanId: "workspace-cas-scan-2",
      itemCount: 0,
    });
    assert.throws(() => configs.createForActiveWorkspace(stale.config, 1, 16), /workspace state changed/u);
    assert.equal(configs.find("default", stale.config.sourceId), undefined);

    db.prepare("UPDATE workspaces SET lifecycle_status = 'archived' WHERE workspace_id = ?").run("default");
    assert.throws(() => configs.createForActiveWorkspace(stale.config, 2, 16), /workspace state changed/u);
    assert.equal(configs.find("default", stale.config.sourceId), undefined);
  });

  it("persists the route-supported loopback actor without weakening exact actor binding", () => {
    const db = createStore();
    const configs = new ExternalSourceConfigRepository(db);
    const fixture = seedExternalSourceCatalog(db, {
      sourceId: "loopback-source",
      scanId: "loopback-scan",
      itemCount: 0,
    });
    const { configSha256: _hash, ...draft } = fixture.config;
    const loopback = sealExternalSourceRecord({
      ...draft,
      ownerActorId: "loopback:operator",
      authActorId: "loopback:operator",
      authActorSource: "loopback",
    });

    assert.deepEqual(configs.createForActiveWorkspace(loopback, 1, 16), loopback);
    assert.deepEqual(
      configs.listByWorkspaceActor("default", "loopback:operator", "loopback:operator", "loopback", 100),
      [loopback],
    );
    assert.deepEqual(
      configs.listByWorkspaceActor("default", "loopback:operator", "loopback:operator", "token", 100),
      [],
    );
  });

  it("uses PostgreSQL row locks for registration, config mutation, and the final scan seal rebind", () => {
    const preparedSql: string[] = [];
    const db: DatabaseClient = {
      dialect: "postgres",
      prepare(sql) {
        preparedSql.push(sql);
        return {
          run: () => ({ changes: 0 }),
          get: () => undefined,
          all: () => [],
        };
      },
      exec: () => undefined,
      close: () => undefined,
      transaction: (_mode, callback) => callback(),
    };

    new ExternalSourceConfigRepository(db);
    new ExternalSourceScanRepository(db);

    const workspaceStateSql = preparedSql.find((sql) => sql.includes("SELECT revision, lifecycle_status"));
    assert.ok(workspaceStateSql);
    assert.match(workspaceStateSql, /FOR UPDATE/u);
    const scanConfigLockSql = preparedSql.find(
      (sql) => sql.includes("SELECT source_id") && sql.includes("FROM external_source_configs"),
    );
    assert.ok(scanConfigLockSql);
    assert.match(scanConfigLockSql, /FOR UPDATE/u);
  });

  it("rejects every config update after the workspace leaves active lifecycle", () => {
    const db = createStore();
    const configs = new ExternalSourceConfigRepository(db);
    const fixture = seedExternalSourceCatalog(db, {
      sourceId: "archived-workspace-update",
      scanId: "archived-workspace-update-scan",
      itemCount: 0,
    });
    configs.create(fixture.config);
    const { configSha256: _hash, ...draft } = fixture.config;
    const renamed = sealExternalSourceRecord({
      ...draft,
      label: "must not commit",
      revision: 2,
      updatedAt: "2026-07-14T08:09:00.000Z",
    });

    db.prepare("UPDATE workspaces SET lifecycle_status = 'archived' WHERE workspace_id = ?").run("default");

    assert.throws(() => configs.updateCas(renamed, 1, 16), /outside an active workspace/u);
    assert.deepEqual(configs.get("default", fixture.config.sourceId), fixture.config);
  });

  it("filters exact actor ownership before the bounded list limit", () => {
    const db = createStore();
    const configs = new ExternalSourceConfigRepository(db);
    const targetFixture = seedExternalSourceCatalog(db, {
      sourceId: "actor-hidden-target",
      scanId: "actor-hidden-scan",
      itemCount: 0,
    });
    const { configSha256: _targetHash, ...targetDraft } = targetFixture.config;
    const target = sealExternalSourceRecord({
      ...targetDraft,
      ownerActorId: "operator-target",
      authActorId: "operator-target",
      status: "disabled",
    });
    configs.create(target);

    for (let index = 0; index < 100; index += 1) {
      const sourceId = `zz-foreign-${index.toString().padStart(3, "0")}`;
      const fixture = seedExternalSourceCatalog(db, {
        sourceId,
        scanId: `scan-${sourceId}`,
        itemCount: 0,
      });
      const { configSha256: _hash, ...draft } = fixture.config;
      configs.create(sealExternalSourceRecord({ ...draft, status: "disabled" }));
    }

    assert.equal(
      configs.listByWorkspace("default", 100).some((item) => item.sourceId === target.sourceId),
      false,
    );
    assert.deepEqual(configs.listByWorkspaceActor("default", "operator-target", "operator-target", "token", 100), [
      target,
    ]);
  });

  it("enforces reactivation capacity atomically despite newer disabled history", () => {
    const db = createStore();
    const configs = new ExternalSourceConfigRepository(db);
    const targetFixture = seedExternalSourceCatalog(db, {
      sourceId: "reactivation-target",
      scanId: "reactivation-target-scan",
      itemCount: 0,
    });
    const { configSha256: _targetHash, ...targetDraft } = targetFixture.config;
    const target = sealExternalSourceRecord({ ...targetDraft, status: "disabled" });
    configs.create(target);

    const active: ExternalSourceRecord[] = [];
    for (let index = 0; index < 16; index += 1) {
      const fixture = seedExternalSourceCatalog(db, {
        sourceId: `reactivation-active-${index}`,
        scanId: `reactivation-active-scan-${index}`,
        itemCount: 0,
      });
      configs.create(fixture.config);
      active.push(fixture.config);
    }
    for (let index = 0; index < 17; index += 1) {
      const fixture = seedExternalSourceCatalog(db, {
        sourceId: `zz-reactivation-disabled-${index}`,
        scanId: `zz-reactivation-disabled-scan-${index}`,
        itemCount: 0,
      });
      const { configSha256: _hash, ...draft } = fixture.config;
      configs.create(sealExternalSourceRecord({ ...draft, status: "disabled" }));
    }

    const { configSha256: _disabledHash, ...disabledDraft } = target;
    const activated = sealExternalSourceRecord({
      ...disabledDraft,
      status: "active",
      revision: 2,
      updatedAt: "2026-07-14T08:10:00.000Z",
    });
    assert.throws(() => configs.updateCas(activated, 1, 16), /active-root limit/u);

    const firstActive = active[0]!;
    const { configSha256: _activeHash, ...activeDraft } = firstActive;
    configs.updateCas(
      sealExternalSourceRecord({
        ...activeDraft,
        status: "disabled",
        revision: 2,
        updatedAt: "2026-07-14T08:10:01.000Z",
      }),
      1,
      16,
    );
    assert.equal(configs.updateCas(activated, 1, 16).status, "active");
  });

  it("seals immutable content-free catalog rows and pages only the fixed manifest", () => {
    const db = createStore();
    const fixture = seedExternalSourceCatalog(db);
    new ExternalSourceConfigRepository(db).create(fixture.config);
    const scans = new ExternalSourceScanRepository(db);

    assert.deepEqual(scans.seal(fixture.scan, fixture.items), fixture.scan);
    assert.deepEqual(scans.seal(fixture.scan, [...fixture.items].reverse()), fixture.scan);

    const { catalogItemSha256: _itemHash, ...itemDraft } = fixture.items[0]!;
    const unknownProducer = sealExternalSourceCatalogItem({
      ...itemDraft,
      producerVersion: "codex-unreviewed-v2",
    });
    const unknownItems = [unknownProducer, ...fixture.items.slice(1)];
    const {
      manifestSha256: _manifest,
      highWater: _highWater,
      itemCount: _itemCount,
      supportedItemCount: _supportedItemCount,
      quarantinedItemCount: _quarantinedItemCount,
      ...scanDraft
    } = fixture.scan;
    const unknownScan = sealExternalSourceScanRecord(scanDraft, unknownItems);
    assert.throws(() => scans.seal(unknownScan, unknownItems), /unaccepted producer variant/u);

    const first = scans.listPage({
      workspaceId: fixture.config.workspaceId,
      sourceId: fixture.config.sourceId,
      scanId: fixture.scan.scanId,
      limit: 2,
    });
    assert.deepEqual(
      first.items.map((item) => item.itemId),
      ["item-3", "item-2"],
    );
    assert.ok(first.nextCursor);
    const second = scans.listPage({
      workspaceId: fixture.config.workspaceId,
      sourceId: fixture.config.sourceId,
      scanId: fixture.scan.scanId,
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.items.map((item) => item.itemId),
      ["item-1"],
    );
    assert.equal(second.nextCursor, undefined);
    const emptyFilterReplay = scans.listPage({
      workspaceId: fixture.config.workspaceId,
      sourceId: fixture.config.sourceId,
      scanId: fixture.scan.scanId,
      dispositions: [],
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.deepEqual(emptyFilterReplay, second);
    assert.throws(
      () =>
        scans.listPage({
          workspaceId: fixture.config.workspaceId,
          sourceId: fixture.config.sourceId,
          scanId: fixture.scan.scanId,
          dispositions: ["supported"],
          cursor: first.nextCursor,
        }),
      /cursor does not match/u,
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE external_source_catalog_items SET raw_byte_count = 1 WHERE scan_id = ?")
          .run(fixture.scan.scanId),
      /immutable/u,
    );
    assert.throws(
      () => db.prepare("DELETE FROM external_source_scans WHERE scan_id = ?").run(fixture.scan.scanId),
      /immutable/u,
    );
  });

  it("rebinds the current active config inside the final seal transaction", () => {
    const db = createStore();
    const fixture = seedExternalSourceCatalog(db, {
      sourceId: "scan-rebind-source",
      scanId: "scan-rebind-scan",
    });
    const configs = new ExternalSourceConfigRepository(db);
    configs.create(fixture.config);
    const { configSha256: _hash, ...draft } = fixture.config;
    configs.updateCas(
      sealExternalSourceRecord({
        ...draft,
        status: "disabled",
        revision: 2,
        updatedAt: "2026-07-14T08:20:00.000Z",
      }),
      1,
      16,
    );

    assert.throws(
      () => new ExternalSourceScanRepository(db).seal(fixture.scan, fixture.items),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === "object" &&
          "details" in error &&
          (error as { details?: { reason?: unknown } }).details?.reason === "source_revision_conflict",
        ),
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM external_source_scans WHERE workspace_id = ?")
        .get<{ count: number }>("default")?.count,
      0,
    );
  });

  it("detects indexed-column tampering even when a defensive trigger is removed", () => {
    const db = createStore();
    const fixture = seedExternalSourceCatalog(db);
    const configs = new ExternalSourceConfigRepository(db);
    configs.create(fixture.config);
    db.exec("DROP TRIGGER trg_external_source_configs_cas");
    db.prepare("UPDATE external_source_configs SET label = 'tampered' WHERE workspace_id = ? AND source_id = ?").run(
      fixture.config.workspaceId,
      fixture.config.sourceId,
    );
    assert.throws(
      () => configs.get(fixture.config.workspaceId, fixture.config.sourceId),
      /indexed-column verification/u,
    );
  });
});
