import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseClient } from "./db.js";
import { createDatabase, type SqliteOptions } from "./sqlite.js";

interface Closable {
  close(): void;
}

/**
 * Owns the temp SQLite files one test file creates. Every database gets its own
 * `mkdtemp` directory under `os.tmpdir()`, so its -wal/-shm/-journal siblings and
 * any snapshots written beside it are removed together.
 *
 * `cleanup()` closes every tracked handle before deleting: on Windows an open
 * SQLite handle blocks deletion, and the old swallow-the-error cleanup left every
 * database (several MB each) behind in %TEMP%. A directory that still cannot be
 * removed after closing is a real leak, so cleanup reports it instead of hiding it.
 */
export class TempSqliteFiles {
  private readonly dirs: string[] = [];
  private readonly handles: Closable[] = [];

  /** Reserve a fresh database path inside a private temp directory. */
  public path(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    this.dirs.push(dir);
    return path.join(dir, "test.db");
  }

  /** Open a migrated SQLite database and close it during cleanup. */
  public open(options: SqliteOptions): DatabaseClient {
    return this.track(createDatabase(options));
  }

  /** Close this handle (a database client, `Storage`, ...) during cleanup. */
  public track<T extends Closable>(handle: T): T {
    this.handles.push(handle);
    return handle;
  }

  public cleanup(): void {
    for (const handle of this.handles.splice(0).reverse()) {
      try {
        handle.close();
      } catch {
        // Already closed by the test itself.
      }
    }
    const failures: string[] = [];
    for (const dir of this.dirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (error) {
        failures.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Temp SQLite cleanup failed (is a database handle still open?)\n${failures.join("\n")}`);
    }
  }
}
