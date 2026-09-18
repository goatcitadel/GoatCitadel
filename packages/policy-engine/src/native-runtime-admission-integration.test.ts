import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { normalizeWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { seedProtectedFenceHarness } from "../../storage/src/remote-worker-protected-fence-fixture.js";
import { verifyRetainedNativeChatResult } from "../../storage/src/remote-worker-native-chat-result-fixture.js";
import { createRemoteWorkerPostgresTestScope } from "../../storage/src/remote-worker-test-fixtures.js";
import { createPostgresRemoteStorage } from "../../storage/src/postgres/remote-storage.js";
import { ToolPolicyEngine } from "./engine.js";

const postgresUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
for (const dialect of ["SQLite", "PostgreSQL"] as const) {
it.skipIf(dialect === "PostgreSQL" && !postgresUrl)(`combines native Chat approval, policy admission and retained grant authorization on ${dialect}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "gc-native-policy-integration-"));
  const pg = dialect === "PostgreSQL" ? await createRemoteWorkerPostgresTestScope(postgresUrl!, "native_policy_combined") : undefined;
  const sync = pg ? undefined : new Storage({ dbPath: ":memory:", transcriptsDir: join(root, "transcripts"), auditDir: join(root, "audit") });
  const connection = pg ? new URL(postgresUrl!) : undefined;
  connection?.searchParams.set("options", `-csearch_path=${pg!.schemaName}`);
  const storage = pg ? createPostgresRemoteStorage({ connection: { connectionString: connection!.toString(),
    database: connection!.pathname.slice(1) || "postgres", pool: { max: 1, connectionTimeoutMs: 10_000 } },
    migrationsTable: "schema_migrations", transcriptsDir: join(root, "transcripts"), auditDir: join(root, "audit") }) : createSqliteAsyncStorage(sync!);
  const db = pg?.db ?? sync!.db;
  try {
    await storage.waitUntilReady();
    const seed = "native-policy-combined", h = seedProtectedFenceHarness(db, seed, true);
    const config: ConstructorParameters<typeof ToolPolicyEngine>[0] = { profiles: { danger: [] }, tools: { profile: "danger", approvalMode: "approve_risky", allow: [], deny: [] },
      agents: {}, sandbox: { writeJailRoots: ["C:\\controlled-mounted-volume"], readOnlyRoots: [], networkAllowlist: [],
        riskyShellPatterns: [], requireApprovalForRiskyShell: true } };
    const engine = new ToolPolicyEngine(config, storage);
    await verifyRetainedNativeChatResult(db, seed, { workerId: h.finalized.generation.workerId,
      workerGeneration: h.finalized.generation.workerGeneration, nodeId: h.finalized.generation.nodeId,
      nodeAdmissionGeneration: h.admitted.admission.admissionGeneration }, h.fence, undefined, async input => {
      const native = normalizeWindowsRuntimeDispatch(input.request);
      const { manifest } = (await storage.remoteWorkerAssignments.resolveActiveChatExecution(input, input.protectedAuthority)).authority.assignment;
      const request = { toolName: "shell.exec", agentId: "assistant", surface: "chat" as const, sessionId: manifest.sessionId!,
        workspaceId: manifest.executionWorkspaceId, taskId: manifest.taskId, runId: manifest.durableRunId,
        args: { command: native.launch.commandLine, cwd: native.launch.directory } };
      const grant = await storage.toolGrants.create({ toolPattern: "shell.exec", decision: "allow", scope: "session", scopeRef: request.sessionId,
        grantType: "one_time", createdBy: "operator", constraints: { maxCallsPerHour: 1, maxWritesPerHour: 1 } });
      const before = await engine.inspectAccess(request);
      expect(before.allowed, JSON.stringify(before)).toBe(true);
      const lookup = { ...input, nonce: input.expectation.nonce, requestSha256: input.expectation.requestSha256 };
      const originalCell = await storage.remoteWorkerCells.getCell(input);
      // Inject only the accounting failure, after the real native repository
      // mutates admission. Every authority check and rollback uses real storage.
      const failedDecisions = new Proxy(storage.toolAccessDecisions, { get(target, property, receiver) {
        return property === "record" ? async () => { throw new Error("controlled accounting failure"); }
          : Reflect.get(target, property, receiver);
      } });
      const failedStorage = new Proxy(storage, { get(target, property, receiver) {
        return property === "toolAccessDecisions" ? failedDecisions : Reflect.get(target, property, receiver);
      } });
      await expect(new ToolPolicyEngine(config, failedStorage).admitNativeRuntime(request, input)).rejects.toThrow("controlled accounting failure");
      expect(await storage.remoteWorkerCells.getCell(input)).toEqual(originalCell);
      expect((await storage.toolGrants.get(grant.grantId)).usesRemaining).toBe(1);
      expect(await storage.toolAccessDecisions.countToolCallsInLastHour("shell.exec", "assistant", request.sessionId)).toBe(0);
      await expect(storage.remoteWorkerNativePolicyReservations.readForAssignment(lookup)).rejects.toThrow();
      const admitted = await engine.admitNativeRuntime(request, input);
      expect(admitted.decision).toBe("accept");
      expect((await storage.toolGrants.get(grant.grantId)).usesRemaining).toBe(0);
      const saved = await storage.remoteWorkerNativePolicyReservations.readForAssignment(lookup);
      expect(saved.decision.matchedGrantId).toBe(grant.grantId);
      expect(saved.decision.countsTowardLimits).toBe(true);
      for (let attempt = 0; attempt < 2; attempt++) expect((await engine.inspectNativeRuntime(request, lookup)).allowed).toBe(true);
      expect(await storage.toolAccessDecisions.countToolCallsInLastHour("shell.exec", "assistant", request.sessionId)).toBe(1);
      await expect(engine.admitNativeRuntime(request, input)).rejects.toThrow();
      expect(await storage.toolAccessDecisions.countToolCallsInLastHour("shell.exec", "assistant", request.sessionId)).toBe(1);
      const deny = await storage.toolGrants.create({ toolPattern: "shell.exec", decision: "deny", scope: "session", scopeRef: request.sessionId,
        grantType: "persistent", createdBy: "operator" });
      expect((await engine.inspectNativeRuntime(request, lookup)).allowed).toBe(false);
      await storage.toolGrants.revoke(deny.grantId, undefined, "operator");
      expect((await engine.inspectNativeRuntime(request, lookup)).allowed).toBe(true);
      return admitted;
    });
  } finally { await storage.close(); await pg?.teardown(); await rm(root, { recursive: true, force: true }); }
}, 120_000);
}
