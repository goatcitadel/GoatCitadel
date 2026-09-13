import { it } from "node:test";
import { createDatabase } from "./sqlite.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { seedRemoteWorkerInferenceAuthority } from "./remote-worker-inference-fixture.js";
import { verifyWorkerChatApprovalResume } from "./remote-worker-chat-resume-fixture.js";

for (const decision of ["approve", "reject", "edit"] as const) it(`retains exact ${decision} Chat wake/binding evidence without unprotected lease revival (SQLite)`, async () => {
  const db = createDatabase({ dbPath: ":memory:" });
  try {
    const seeded = seedRemoteWorkerInferenceAuthority(db, "resume-worker");
    const generation = new RemoteWorkerAssignmentRepository(db).findAssignmentAggregate("default", seeded.assignmentId)!.generation!;
    await verifyWorkerChatApprovalResume(db, `sqlite-${decision}`, generation, undefined, decision);
  } finally { db.close(); }
});
