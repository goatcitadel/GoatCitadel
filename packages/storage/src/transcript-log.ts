import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import type { TranscriptEvent } from "@goatcitadel/contracts";
import { loadAndSanitize, type QuarantineEntry } from "./load-and-sanitize.js";
import { parseJsonObject } from "./state-validators.js";

const SAFE_SESSION_FILENAME_RE = /^[A-Za-z0-9._-]+$/u;

export interface TranscriptLogOptions {
  quarantine?: { record: (entry: QuarantineEntry) => unknown };
  logger?: { warn: (data: unknown, msg: string) => void };
}

export interface TranscriptRetentionPruneResult {
  removedFiles: number;
  removedEvents: number;
  reclaimedBytes: number;
}

export class TranscriptLog {
  private readonly writeQueues = new Map<string, Promise<number>>();

  public constructor(
    private readonly transcriptsDir: string,
    private readonly options: TranscriptLogOptions = {},
  ) {}

  public async append(event: TranscriptEvent): Promise<number> {
    const prior = this.writeQueues.get(event.sessionId) ?? Promise.resolve(0);
    const next = prior.catch(() => 0).then(async () => this.appendInternal(event));

    this.writeQueues.set(event.sessionId, next);
    try {
      return await next;
    } finally {
      if (this.writeQueues.get(event.sessionId) === next) {
        this.writeQueues.delete(event.sessionId);
      }
    }
  }

  private async appendInternal(event: TranscriptEvent): Promise<number> {
    const filePath = this.filePathForSession(event.sessionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const handle = await fs.open(filePath, "a+");
    try {
      const stat = await handle.stat();
      const offset = stat.size;
      const line = JSON.stringify(event) + "\n";
      await handle.write(line, null, "utf8");
      return offset;
    } finally {
      await handle.close();
    }
  }

  public async read(sessionId: string): Promise<TranscriptEvent[]> {
    const filePath = this.filePathForSession(sessionId);
    const raw = await fs.readFile(filePath, "utf8");
    const events: TranscriptEvent[] = [];
    for (const [index, line] of raw.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const lineNumber = index + 1;
      const parsed = loadAndSanitize(
        trimmed,
        {
          store: "transcript.jsonl",
          rowId: `${sessionId}:line-${lineNumber}`,
          parse: parseJsonObject,
          onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
          log: this.options.logger,
        },
        undefined,
      );
      if (!parsed) {
        continue;
      }
      events.push(parsed as unknown as TranscriptEvent);
    }
    return events;
  }

  public async delete(sessionId: string): Promise<void> {
    const pending = this.writeQueues.get(sessionId);
    if (pending) {
      try {
        await pending;
      } catch {
        // Ignore write failures and continue cleanup.
      }
    }
    const filePath = this.filePathForSession(sessionId);
    await fs.rm(filePath, { force: true });
  }

  public async pruneOlderThan(
    cutoffEpochMs: number,
    options: { dryRun?: boolean } = {},
  ): Promise<TranscriptRetentionPruneResult> {
    await Promise.allSettled([...this.writeQueues.values()]);
    return pruneTranscriptFilesOlderThan(this.transcriptsDir, cutoffEpochMs, options.dryRun ?? false);
  }

  private filePathForSession(sessionId: string): string {
    const fileName = transcriptFileName(sessionId);
    const root = path.resolve(this.transcriptsDir);
    const filePath = path.resolve(root, fileName);
    const relative = path.relative(root, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
      throw new Error("Transcript session path escapes transcript root");
    }
    return filePath;
  }
}

async function pruneTranscriptFilesOlderThan(
  rootDir: string,
  cutoffEpochMs: number,
  dryRun: boolean,
): Promise<TranscriptRetentionPruneResult> {
  let removedFiles = 0;
  let reclaimedBytes = 0;

  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(entryPath);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= cutoffEpochMs) {
        continue;
      }
      removedFiles += 1;
      reclaimedBytes += stat.size;
      if (!dryRun) {
        await fs.rm(entryPath, { force: true });
      }
    }
  }

  await visit(rootDir);
  return { removedFiles, removedEvents: 0, reclaimedBytes };
}

function transcriptFileName(sessionId: string): string {
  if (sessionId !== "." && sessionId !== ".." && SAFE_SESSION_FILENAME_RE.test(sessionId)) {
    return `${sessionId}.jsonl`;
  }
  const encodedSessionId = Buffer.from(sessionId, "utf8").toString("base64url") || "empty";
  return `session-${encodedSessionId}.jsonl`;
}
