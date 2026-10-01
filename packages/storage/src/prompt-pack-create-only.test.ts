import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "./sqlite.js";
import { verifyConcurrentCreateOnly, verifyCreateOnlyPromptPack } from "./prompt-pack-create-only.test-support.js";

test(
  "SQLite create-only prompt packs preserve evidence, roll back failures, and admit one concurrent writer",
  { timeout: 60_000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-prompt-create-"));
    const dbPath = path.join(root, "test.db");
    const db = createDatabase({ dbPath });
    try {
      verifyCreateOnlyPromptPack(db);
      await verifyConcurrentCreateOnly(db, { dbPath });
    } finally {
      db.close();
      if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith("gc-prompt-create-"))
        fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
