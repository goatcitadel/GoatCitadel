import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ConflictError, ServiceUnavailableError, ValidationError, canonicalJsonString,
  type MemoryItemListPage, type MemoryItemListQuery, type MemoryItemRecord } from "@goatcitadel/contracts";
import type { MemoryItemEnumerationContinuation, MemoryItemEnumerationInput, MemoryItemEnumerationPage,
  MemoryItemEnumerationRow } from "@goatcitadel/storage";

export interface MemoryItemPaginationDependencies {
  readonly repository?: { listPage(input: MemoryItemEnumerationInput): Promise<MemoryItemEnumerationPage> };
  readonly mapRow: (row: MemoryItemEnumerationRow) => MemoryItemRecord;
  readonly requireEnabled: () => void | Promise<void>;
}

/** Read collaborator behind MemoryLifecycleService. Tokens carry no item content
 * or query text. A fresh process key deliberately invalidates pre-restart cursors. */
export class MemoryItemPaginationService {
  private readonly cursorKey = randomBytes(32);

  public constructor(private readonly deps: MemoryItemPaginationDependencies) {}

  public async list(input: MemoryItemListQuery = {}): Promise<MemoryItemListPage> {
    await this.deps.requireEnabled();
    if (!this.deps.repository) throw new ServiceUnavailableError("The memory enumeration owner is unavailable.");
    const { cursor, ...filters } = normalizeInput(input);
    const { workspaceId, namespace, status, query } = filters;
    const scope = { workspaceId, namespace, status, query };
    const scopeHash = createHash("sha256").update(canonicalJsonString(scope)).digest("hex");
    const continuation = cursor ? this.readCursor(cursor, scopeHash) : undefined;
    const page = await this.deps.repository.listPage({ ...filters, ...(continuation ? { continuation } : {}) });
    return { items: page.rows.map(this.deps.mapRow), total: page.total, snapshotAt: page.snapshotAt,
      ...(page.continuation ? { nextCursor: this.writeCursor(page.continuation, scopeHash) } : {}),
    };
  }

  private readCursor(cursor: string, scopeHash: string): MemoryItemEnumerationContinuation {
    const parts = cursor.split(".");
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw invalidCursor();
    const body = Buffer.from(parts[0]!, "base64url"), signature = Buffer.from(parts[1]!, "base64url");
    const expected = createHmac("sha256", this.cursorKey).update(body).digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw invalidCursor();
    let value: { version?: unknown; scopeHash?: unknown; continuation?: MemoryItemEnumerationContinuation };
    try { value = JSON.parse(body.toString("utf8")); } catch { throw invalidCursor(); }
    if (!value || value.version !== 1 || !value.continuation) throw invalidCursor();
    if (value.scopeHash !== scopeHash) throw new ConflictError({
      message: "Memory filters or workspace changed. Reload the list before continuing.",
      details: { reason: "MEMORY_CURSOR_SCOPE_MISMATCH" },
    });
    return value.continuation;
  }

  private writeCursor(continuation: MemoryItemEnumerationContinuation, scopeHash: string): string {
    const body = Buffer.from(JSON.stringify({ version: 1, scopeHash, continuation }));
    return `${body.toString("base64url")}.${createHmac("sha256", this.cursorKey).update(body).digest("base64url")}`;
  }
}

function normalizeInput(input: MemoryItemListQuery): MemoryItemEnumerationInput & { cursor?: string } {
  for (const value of [input.namespace, input.workspaceId, input.query]) {
    if (value !== undefined && (typeof value !== "string" || value.length > 2_000)) throw new ValidationError({ message: "Memory filter is invalid." });
  }
  const status = input.status ?? "active", limit = input.limit ?? 200;
  if (!["active", "forgotten", "all"].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ValidationError({ message: "Memory status or page size is invalid." });
  }
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || !input.cursor || input.cursor.length > 2_048)) throw invalidCursor();
  const namespace = input.namespace?.trim(), workspaceId = input.workspaceId?.trim(), query = input.query?.trim().toLowerCase();
  return { status, limit, ...(namespace ? { namespace } : {}), ...(workspaceId ? { workspaceId } : {}),
    ...(query ? { query } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) };
}

function invalidCursor(): ValidationError {
  return new ValidationError({ field: "cursor", message: "Memory continuation is invalid or belongs to an earlier Gateway. Reload the list." });
}
