import fs from "node:fs/promises";
import path from "node:path";
import type { TranscriptEvent } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

export class TranscriptLog {
  private readonly writeQueues = new Map<string, Promise<number>>();

  public constructor(private readonly transcriptsDir: string) {}

  public async append(event: TranscriptEvent): Promise<number> {
    const prior = this.writeQueues.get(event.sessionId) ?? Promise.resolve(0);
    const next = prior
      .catch(() => 0)
      .then(async () => this.appendInternal(event));

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
    const filePath = path.join(this.transcriptsDir, `${event.sessionId}.jsonl`);
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
    const filePath = path.join(this.transcriptsDir, `${sessionId}.jsonl`);
    const raw = await fs.readFile(filePath, "utf8");
    const events: TranscriptEvent[] = [];
    for (const [index, line] of raw.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const event = safeJsonParse<TranscriptEvent | undefined>(trimmed, undefined);
      if (!event) {
        console.warn("[goatcitadel] transcript line is malformed; continuing with degraded transcript read", {
          sessionId,
          lineNumber: index + 1,
        });
        continue;
      }
      events.push(event);
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
    const filePath = path.join(this.transcriptsDir, `${sessionId}.jsonl`);
    await fs.rm(filePath, { force: true });
  }
}
