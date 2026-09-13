import { it } from "node:test";
import { createDatabase } from "./sqlite.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { seedRemoteWorkerInferenceAuthority } from "./remote-worker-inference-fixture.js";
import { verifyWorkerChatParentRecovery } from "./remote-worker-chat-parent-recovery-fixture.js";

it("retains repeated Chat parent recovery without approval or unprotected lease revival (SQLite)", async () => {
  const db = createDatabase({ dbPath: ":memory:" });
  try {
    const seed = seedRemoteWorkerInferenceAuthority(db, "parent-recovery-worker");
    const generation = new RemoteWorkerAssignmentRepository(db).findAssignmentAggregate("default", seed.assignmentId)!.generation!;
    await verifyWorkerChatParentRecovery(db, "sqlite", generation);
  } finally { db.close(); }
});
