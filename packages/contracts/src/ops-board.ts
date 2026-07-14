export const OPS_SAVED_BOARD_SCHEMA_VERSION = "goatcitadel.ops-board.v1" as const;

export const OPS_SAVED_BOARD_WIDGET_KINDS = [
  "agentic_run_kanban",
  "approval_queue_summary",
  "runtime_truth_summary",
  "task_status_summary",
  "usage_cost_summary",
] as const;

export const OPS_SAVED_BOARD_LIMITS = Object.freeze({
  boardsPerWorkspace: 64,
  placementsPerBoard: 12,
  gridColumns: 12,
  maxGridRow: 255,
  maxWidgetSpan: 12,
  nameCharacters: 120,
  descriptionCharacters: 500,
  identifierCharacters: 256,
  widgetIdCharacters: 128,
  idempotencyKeyCharacters: 512,
  layoutJsonBytes: 16_384,
});

export type OpsSavedBoardWidgetKind = (typeof OPS_SAVED_BOARD_WIDGET_KINDS)[number];
export type OpsSavedBoardStatus = "active" | "archived";

export interface OpsSavedBoardPlacement {
  widgetId: string;
  kind: OpsSavedBoardWidgetKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OpsSavedBoardRecord {
  schemaVersion: typeof OPS_SAVED_BOARD_SCHEMA_VERSION;
  boardId: string;
  workspaceId: string;
  name: string;
  description?: string;
  status: OpsSavedBoardStatus;
  placements: OpsSavedBoardPlacement[];
  revision: number;
  createdByActorId: string;
  createdAt: string;
  updatedByActorId: string;
  updatedAt: string;
  archivedByActorId?: string;
  archivedAt?: string;
  idempotencyKey: string;
  requestSha256: string;
}

/** The authenticated actor is intentionally absent and must be supplied by the Gateway. */
export interface OpsSavedBoardCreateInput {
  workspaceId: string;
  name: string;
  description?: string;
  placements: OpsSavedBoardPlacement[];
  idempotencyKey: string;
}

/** The board ID remains a path identity and is intentionally absent from the body. */
export interface OpsSavedBoardUpdateInput {
  workspaceId: string;
  name?: string;
  description?: string | null;
  placements?: OpsSavedBoardPlacement[];
  expectedRevision: number;
}

export interface OpsSavedBoardStatusInput {
  workspaceId: string;
  expectedRevision: number;
}

export function isOpsSavedBoardWidgetKind(value: unknown): value is OpsSavedBoardWidgetKind {
  return OPS_SAVED_BOARD_WIDGET_KINDS.includes(value as OpsSavedBoardWidgetKind);
}

export function normalizeOpsSavedBoardCreateInput(value: unknown): OpsSavedBoardCreateInput {
  assertRecord(value, "create input");
  assertExactKeys(value, ["workspaceId", "name", "description", "placements", "idempotencyKey"], ["description"]);
  return {
    workspaceId: assertCanonicalIdentifier(
      value.workspaceId,
      "workspaceId",
      OPS_SAVED_BOARD_LIMITS.identifierCharacters,
    ),
    name: normalizeName(value.name),
    ...(Object.hasOwn(value, "description") ? { description: normalizeDescription(value.description) } : {}),
    placements: normalizeOpsSavedBoardPlacements(value.placements),
    idempotencyKey: assertCanonicalIdentifier(
      value.idempotencyKey,
      "idempotencyKey",
      OPS_SAVED_BOARD_LIMITS.idempotencyKeyCharacters,
    ),
  };
}

export function normalizeOpsSavedBoardUpdateInput(value: unknown): OpsSavedBoardUpdateInput {
  assertRecord(value, "update input");
  assertExactKeys(
    value,
    ["workspaceId", "name", "description", "placements", "expectedRevision"],
    ["name", "description", "placements"],
  );
  if (!["name", "description", "placements"].some((key) => Object.hasOwn(value, key))) {
    throw new TypeError("Ops saved board update input must contain a mutable field.");
  }
  return {
    workspaceId: assertCanonicalIdentifier(
      value.workspaceId,
      "workspaceId",
      OPS_SAVED_BOARD_LIMITS.identifierCharacters,
    ),
    ...(Object.hasOwn(value, "name") ? { name: normalizeName(value.name) } : {}),
    ...(Object.hasOwn(value, "description")
      ? { description: value.description === null ? null : normalizeDescription(value.description) }
      : {}),
    ...(Object.hasOwn(value, "placements") ? { placements: normalizeOpsSavedBoardPlacements(value.placements) } : {}),
    expectedRevision: assertPositiveInteger(value.expectedRevision, "expectedRevision"),
  };
}

export function normalizeOpsSavedBoardStatusInput(value: unknown): OpsSavedBoardStatusInput {
  assertRecord(value, "status input");
  assertExactKeys(value, ["workspaceId", "expectedRevision"]);
  return {
    workspaceId: assertCanonicalIdentifier(
      value.workspaceId,
      "workspaceId",
      OPS_SAVED_BOARD_LIMITS.identifierCharacters,
    ),
    expectedRevision: assertPositiveInteger(value.expectedRevision, "expectedRevision"),
  };
}

export function normalizeOpsSavedBoardPlacements(value: unknown): OpsSavedBoardPlacement[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > OPS_SAVED_BOARD_LIMITS.placementsPerBoard) {
    throw new TypeError("Ops saved board placements must contain between 1 and 12 entries.");
  }
  const widgetIds = new Set<string>();
  return value.map((placement, index) => {
    assertRecord(placement, `placement ${index}`);
    assertExactKeys(placement, ["widgetId", "kind", "x", "y", "width", "height"]);
    const widgetId = assertCanonicalIdentifier(
      placement.widgetId,
      `placements[${index}].widgetId`,
      OPS_SAVED_BOARD_LIMITS.widgetIdCharacters,
    );
    if (widgetIds.has(widgetId)) throw new TypeError(`Ops saved board widget ID '${widgetId}' is duplicated.`);
    widgetIds.add(widgetId);
    if (!isOpsSavedBoardWidgetKind(placement.kind)) {
      throw new TypeError(`Ops saved board placement ${index} has an unsupported widget kind.`);
    }
    const x = assertIntegerInRange(placement.x, `placements[${index}].x`, 0, 11);
    const y = assertIntegerInRange(placement.y, `placements[${index}].y`, 0, OPS_SAVED_BOARD_LIMITS.maxGridRow);
    const width = assertIntegerInRange(
      placement.width,
      `placements[${index}].width`,
      1,
      OPS_SAVED_BOARD_LIMITS.maxWidgetSpan,
    );
    const height = assertIntegerInRange(
      placement.height,
      `placements[${index}].height`,
      1,
      OPS_SAVED_BOARD_LIMITS.maxWidgetSpan,
    );
    if (x + width > OPS_SAVED_BOARD_LIMITS.gridColumns) {
      throw new TypeError(`Ops saved board placement ${index} exceeds the 12-column grid.`);
    }
    return { widgetId, kind: placement.kind, x, y, width, height };
  });
}

export function assertOpsSavedBoardRecord(value: unknown): asserts value is OpsSavedBoardRecord {
  assertRecord(value, "record");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "boardId",
      "workspaceId",
      "name",
      "description",
      "status",
      "placements",
      "revision",
      "createdByActorId",
      "createdAt",
      "updatedByActorId",
      "updatedAt",
      "archivedByActorId",
      "archivedAt",
      "idempotencyKey",
      "requestSha256",
    ],
    ["description", "archivedByActorId", "archivedAt"],
  );
  if (value.schemaVersion !== OPS_SAVED_BOARD_SCHEMA_VERSION) {
    throw new TypeError("Ops saved board schema version is unsupported.");
  }
  assertCanonicalIdentifier(value.boardId, "boardId", OPS_SAVED_BOARD_LIMITS.identifierCharacters);
  assertCanonicalIdentifier(value.workspaceId, "workspaceId", OPS_SAVED_BOARD_LIMITS.identifierCharacters);
  if (value.name !== normalizeName(value.name)) throw new TypeError("Ops saved board name is not canonical.");
  if (Object.hasOwn(value, "description") && value.description !== normalizeDescription(value.description)) {
    throw new TypeError("Ops saved board description is not canonical.");
  }
  if (value.status !== "active" && value.status !== "archived") {
    throw new TypeError("Ops saved board status is unsupported.");
  }
  normalizeOpsSavedBoardPlacements(value.placements);
  const revision = assertPositiveInteger(value.revision, "revision");
  assertCanonicalIdentifier(value.createdByActorId, "createdByActorId", OPS_SAVED_BOARD_LIMITS.identifierCharacters);
  assertCanonicalIdentifier(value.updatedByActorId, "updatedByActorId", OPS_SAVED_BOARD_LIMITS.identifierCharacters);
  assertCanonicalTimestamp(value.createdAt, "createdAt");
  assertCanonicalTimestamp(value.updatedAt, "updatedAt");
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw new TypeError("Ops saved board updatedAt precedes createdAt.");
  }
  assertCanonicalIdentifier(value.idempotencyKey, "idempotencyKey", OPS_SAVED_BOARD_LIMITS.idempotencyKeyCharacters);
  if (typeof value.requestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.requestSha256)) {
    throw new TypeError("Ops saved board requestSha256 must be a lowercase SHA-256 digest.");
  }
  if (revision === 1) {
    if (
      value.status !== "active" ||
      value.createdByActorId !== value.updatedByActorId ||
      value.createdAt !== value.updatedAt
    ) {
      throw new TypeError("A new ops saved board must have one canonical creation identity.");
    }
  }
  if (value.status === "active") {
    if (Object.hasOwn(value, "archivedByActorId") || Object.hasOwn(value, "archivedAt")) {
      throw new TypeError("An active ops saved board cannot retain archive metadata.");
    }
  } else {
    assertCanonicalIdentifier(
      value.archivedByActorId,
      "archivedByActorId",
      OPS_SAVED_BOARD_LIMITS.identifierCharacters,
    );
    assertCanonicalTimestamp(value.archivedAt, "archivedAt");
    if (value.archivedByActorId !== value.updatedByActorId || value.archivedAt !== value.updatedAt) {
      throw new TypeError("An archived ops saved board must expose its terminal archive identity.");
    }
  }
}

function normalizeName(value: unknown): string {
  return normalizePlainText(value, "name", 1, OPS_SAVED_BOARD_LIMITS.nameCharacters);
}

function normalizeDescription(value: unknown): string {
  return normalizePlainText(value, "description", 1, OPS_SAVED_BOARD_LIMITS.descriptionCharacters);
}

function normalizePlainText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new TypeError(`Ops saved board ${field} must be plain text.`);
  const normalized = value.normalize("NFKC").trim();
  const length = [...normalized].length;
  if (length < min || length > max) throw new TypeError(`Ops saved board ${field} is missing or oversized.`);
  if (/\p{Cc}/u.test(normalized)) throw new TypeError(`Ops saved board ${field} contains control characters.`);
  return normalized;
}

function assertCanonicalIdentifier(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new TypeError(`Ops saved board ${field} must be a string.`);
  const normalized = value.normalize("NFKC").trim();
  if (value !== normalized || [...value].length < 1 || [...value].length > max || /\p{Cc}/u.test(value)) {
    throw new TypeError(`Ops saved board ${field} is not a canonical identifier.`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`Ops saved board ${field} must be a positive safe integer.`);
  }
  return Number(value);
}

function assertIntegerInRange(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new TypeError(`Ops saved board ${field} is outside its frozen bounds.`);
  }
  return Number(value);
}

function assertCanonicalTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`Ops saved board ${field} must be a canonical ISO timestamp.`);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Ops saved board ${label} must be an object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): void {
  const expected = new Set(expectedKeys);
  const optional = new Set(optionalKeys);
  const keys = Object.keys(value);
  if (
    keys.some((key) => !expected.has(key)) ||
    expectedKeys.some((key) => !optional.has(key) && !Object.hasOwn(value, key))
  ) {
    throw new TypeError("Ops saved board value contains unknown or missing keys.");
  }
}
