import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadGatewayConfig } from "../apps/gateway/src/config.js";
import { estimateUsageCostUsd } from "../apps/gateway/src/services/llm-pricing.js";

interface AssistantCostRow {
  message_id: string;
  session_id: string;
  timestamp: string;
  token_input: number | null;
  token_output: number | null;
  token_cached_input: number | null;
  message_cost_usd: number | null;
  ledger_cost_usd: number | null;
  trace_model: string | null;
  routing_json: string | null;
}

interface BackfillCandidate {
  messageId: string;
  sessionId: string;
  timestamp: string;
  tokenInput: number;
  tokenOutput: number;
  providerId?: string;
  model?: string;
  estimatedCostUsd?: number;
  messageNeedsUpdate: boolean;
  ledgerNeedsUpdate: boolean;
}

interface UnpricedBucket {
  providerId: string;
  model: string;
  count: number;
  tokenInput: number;
  tokenOutput: number;
  tokenCachedInput: number;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(scriptDir, "..");

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const shouldWrite = args.has("--write");
  const rootArg = process.argv.slice(2).find((arg) => arg.startsWith("--root="));
  const rootDir = rootArg ? path.resolve(rootArg.slice("--root=".length)) : defaultRootDir;

  const config = await loadGatewayConfig(rootDir);
  const db = new DatabaseSync(config.dbPath);

  try {
    const duplicateMatches = db.prepare(`
      SELECT cm.message_id, COUNT(*) AS count
      FROM chat_messages cm
      JOIN chat_turn_traces tt
        ON tt.assistant_message_id = cm.message_id
      JOIN cost_ledger cl
        ON cl.session_id = cm.session_id
       AND cl.created_at = cm.timestamp
       AND cl.token_input = COALESCE(cm.token_input, 0)
       AND cl.token_output = COALESCE(cm.token_output, 0)
      WHERE cm.role = 'assistant'
      GROUP BY cm.message_id
      HAVING COUNT(*) > 1
    `).all() as Array<{ message_id: string; count: number }>;

    if (duplicateMatches.length > 0) {
      throw new Error(`Refusing to backfill with ambiguous ledger joins (${duplicateMatches.length} duplicate assistant matches)`);
    }

    const rows = db.prepare(`
      SELECT
        cm.message_id,
        cm.session_id,
        cm.timestamp,
        cm.token_input,
        cm.token_output,
        cl.token_cached_input,
        cm.cost_usd AS message_cost_usd,
        cl.cost_usd AS ledger_cost_usd,
        tt.model AS trace_model,
        tt.routing_json
      FROM chat_messages cm
      JOIN chat_turn_traces tt
        ON tt.assistant_message_id = cm.message_id
      LEFT JOIN cost_ledger cl
        ON cl.session_id = cm.session_id
       AND cl.created_at = cm.timestamp
       AND cl.token_input = COALESCE(cm.token_input, 0)
       AND cl.token_output = COALESCE(cm.token_output, 0)
      WHERE cm.role = 'assistant'
      ORDER BY cm.timestamp ASC
    `).all() as AssistantCostRow[];

    const candidates: BackfillCandidate[] = [];
    const unpriced = new Map<string, UnpricedBucket>();
    let matchedLedgerRows = 0;
    let alreadyPricedMessages = 0;
    let alreadyPricedLedgerRows = 0;

    for (const row of rows) {
      const routing = parseRecord(row.routing_json);
      const providerId = readString(routing?.effectiveProviderId)
        ?? readString(routing?.primaryProviderId);
      const model = readString(routing?.effectiveModel)
        ?? readString(routing?.primaryModel)
        ?? readString(row.trace_model);
      const estimatedCostUsd = estimateUsageCostUsd({
        providerId,
        model,
        usage: {
          prompt_tokens: row.token_input ?? 0,
          completion_tokens: row.token_output ?? 0,
          cached_prompt_tokens: row.token_cached_input ?? 0,
        },
      });

      const messageNeedsUpdate = !hasRecordedCost(row.message_cost_usd);
      const ledgerNeedsUpdate = row.ledger_cost_usd !== null && !hasRecordedCost(row.ledger_cost_usd);
      if (row.ledger_cost_usd !== null) {
        matchedLedgerRows += 1;
      }
      if (hasRecordedCost(row.message_cost_usd)) {
        alreadyPricedMessages += 1;
      }
      if (hasRecordedCost(row.ledger_cost_usd)) {
        alreadyPricedLedgerRows += 1;
      }

      candidates.push({
        messageId: row.message_id,
        sessionId: row.session_id,
        timestamp: row.timestamp,
        tokenInput: row.token_input ?? 0,
        tokenOutput: row.token_output ?? 0,
        providerId,
        model,
        estimatedCostUsd,
        messageNeedsUpdate,
        ledgerNeedsUpdate,
      });

      if (estimatedCostUsd === undefined && ((row.token_input ?? 0) > 0 || (row.token_output ?? 0) > 0)) {
        const key = `${providerId ?? "unknown"}|${model ?? "unknown"}`;
        const bucket = unpriced.get(key) ?? {
          providerId: providerId ?? "unknown",
          model: model ?? "unknown",
          count: 0,
          tokenInput: 0,
          tokenOutput: 0,
          tokenCachedInput: 0,
        };
        bucket.count += 1;
        bucket.tokenInput += row.token_input ?? 0;
        bucket.tokenOutput += row.token_output ?? 0;
        bucket.tokenCachedInput += row.token_cached_input ?? 0;
        unpriced.set(key, bucket);
      }
    }

    const candidatesWithEstimate = candidates.filter((candidate) => candidate.estimatedCostUsd !== undefined);
    const messageUpdates = candidatesWithEstimate.filter((candidate) => candidate.messageNeedsUpdate);
    const ledgerUpdates = candidatesWithEstimate.filter((candidate) => candidate.ledgerNeedsUpdate);
    const sessionIdsToRecompute = new Set(messageUpdates.map((candidate) => candidate.sessionId));

    let updatedMessageRows = 0;
    let updatedLedgerRows = 0;
    let recomputedSessions = 0;

    if (shouldWrite) {
      const updateMessageStmt = db.prepare(`
        UPDATE chat_messages
        SET cost_usd = @costUsd
        WHERE message_id = @messageId
          AND (cost_usd IS NULL OR cost_usd = 0)
      `);
      const updateLedgerStmt = db.prepare(`
        UPDATE cost_ledger
        SET cost_usd = @costUsd
        WHERE session_id = @sessionId
          AND created_at = @timestamp
          AND token_input = @tokenInput
          AND token_output = @tokenOutput
          AND (cost_usd IS NULL OR cost_usd = 0)
      `);
      const recomputeSessionStmt = db.prepare(`
        UPDATE sessions
        SET cost_usd_total = COALESCE((
          SELECT SUM(COALESCE(chat_messages.cost_usd, 0))
          FROM chat_messages
          WHERE chat_messages.session_id = sessions.session_id
        ), 0)
        WHERE session_id = ?
      `);

      db.exec("BEGIN IMMEDIATE");
      try {
        for (const candidate of messageUpdates) {
          const result = updateMessageStmt.run({
            messageId: candidate.messageId,
            costUsd: candidate.estimatedCostUsd,
          });
          updatedMessageRows += Number(result.changes ?? 0);
        }

        for (const candidate of ledgerUpdates) {
          const result = updateLedgerStmt.run({
            sessionId: candidate.sessionId,
            timestamp: candidate.timestamp,
            tokenInput: candidate.tokenInput,
            tokenOutput: candidate.tokenOutput,
            costUsd: candidate.estimatedCostUsd,
          });
          updatedLedgerRows += Number(result.changes ?? 0);
        }

        for (const sessionId of sessionIdsToRecompute) {
          const result = recomputeSessionStmt.run(sessionId);
          recomputedSessions += Number(result.changes ?? 0);
        }

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    const unpricedRows = Array.from(unpriced.values())
      .sort((left, right) => right.count - left.count || left.providerId.localeCompare(right.providerId));

    console.log(JSON.stringify({
      mode: shouldWrite ? "write" : "dry-run",
      dbPath: config.dbPath,
      assistantMessagesScanned: rows.length,
      matchedLedgerRows,
      candidatesWithEstimate: candidatesWithEstimate.length,
      messageRowsMissingCost: messageUpdates.length,
      ledgerRowsMissingCost: ledgerUpdates.length,
      alreadyPricedMessages,
      alreadyPricedLedgerRows,
      updatedMessageRows,
      updatedLedgerRows,
      recomputedSessions,
      unpricedModels: unpricedRows,
    }, null, 2));
  } finally {
    db.close();
  }
}

function hasRecordedCost(value: number | null): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseRecord(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
