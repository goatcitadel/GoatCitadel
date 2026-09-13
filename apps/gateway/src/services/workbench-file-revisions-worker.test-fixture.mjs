import path from "node:path";
import os from "node:os";
import { withWorkbenchWriteLock, writeWorkbenchFileSnapshot } from "./workbench-file-revisions.ts";

const root = path.resolve(process.argv[2] ?? ".");
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("gc-workbench-revision-")) {
  throw new Error("A task-owned Workbench test directory is required.");
}
process.once("message", async (message) => {
  try {
    const saved = await withWorkbenchWriteLock(root, () => writeWorkbenchFileSnapshot({
      sessionId: "session", projectId: "project", projectRoot: root, relativePath: "file.txt", assertAllowed: () => {},
    }, { content: message.content, expectedRevision: message.revision }, () => {}));
    process.send?.({ status: "saved", content: saved.content.toString("utf8"), revision: saved.revision });
  } catch (error) {
    process.send?.({ status: "rejected", code: error.code });
  } finally { process.disconnect(); }
});
process.send?.({ status: "ready" });
