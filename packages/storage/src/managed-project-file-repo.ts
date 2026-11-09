import { createHash, randomUUID } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ManagedProjectFileReceipt,
  type ManagedProjectFileRevision,
  type ManagedProjectFileScope,
  type ManagedProjectFileTarget,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export type {
  ManagedProjectFileReceipt,
  ManagedProjectFileRevision,
  ManagedProjectFileScope,
  ManagedProjectFileTarget,
} from "@goatcitadel/contracts";

export interface ManagedProjectFileSnapshot extends ManagedProjectFileRevision {
  contentBase64: string | null;
}

interface MutationInput extends ManagedProjectFileTarget {
  effectId: string;
}

export interface ManagedProjectFileSaveInput extends MutationInput {
  expectedRevision: string | null;
  contentBase64: string;
}

export interface ManagedProjectFileChangeInput extends MutationInput {
  expectedRevision: string;
}

interface RevisionRow {
  workspace_id: string;
  project_id: string;
  path_key: string;
  path: string;
  revision_id: string;
  previous_revision_id: string | null;
  request_sha256: string;
  content_sha256: string | null;
  byte_length: number;
  content_base64: string | null;
  content_revision_id: string | null;
}

type Content = Pick<RevisionRow, "content_sha256" | "byte_length" | "content_base64" | "content_revision_id">;
const tombstone: Content = { content_sha256: null, byte_length: 0, content_base64: null, content_revision_id: null };
export const MANAGED_PROJECT_FILE_MAX_BYTES = 1024 * 1024;
const maxStoredBytes = 64 * 1024 * 1024;
const maxStoredVersions = 2048;
const maxListLimit = 200;
const reservedName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const revisionFields =
  "r.workspace_id, r.project_id, r.path_key, r.path, r.revision_id, r.previous_revision_id, r.content_sha256, r.byte_length, r.content_revision_id";

/** Logical project files. This repository never resolves or writes a host path. */
export class ManagedProjectFileRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public read(target: ManagedProjectFileTarget): ManagedProjectFileSnapshot | undefined {
    validateScope(target);
    const row = this.head(target, managedProjectFilePathKey(target.path));
    if (!row) return undefined;
    return { ...revision(row), contentBase64: row.content_sha256 === null ? null : this.verifiedBytes(target, row) };
  }

  public list(
    scope: ManagedProjectFileScope,
    options: { prefix?: string; limit?: number } = {},
  ): ManagedProjectFileRevision[] {
    validateScope(scope);
    const prefix = options.prefix === undefined ? "" : managedProjectFilePathKey(options.prefix);
    const limit = options.limit ?? maxListLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxListLimit) throw new ValidationError({ field: "limit" });
    return this.db
      .prepare(
        `
      SELECT ${revisionFields}
      FROM managed_project_file_heads h
      JOIN managed_project_file_revisions r USING (workspace_id, project_id, path_key, revision_id)
      JOIN chat_projects p ON p.project_id = r.project_id AND p.workspace_id = r.workspace_id
      WHERE r.workspace_id = ? AND r.project_id = ? AND p.lifecycle_status = 'active'
        AND r.content_sha256 IS NOT NULL
        AND (? = '' OR r.path_key = ? OR substr(r.path_key, 1, length(?) + 1) = ? || '/')
      ORDER BY r.path_key
      LIMIT ?
    `,
      )
      .all<RevisionRow>(scope.workspaceId, scope.projectId, prefix, prefix, prefix, prefix, limit)
      .map(revision);
  }

  public save(input: ManagedProjectFileSaveInput): ManagedProjectFileReceipt {
    const bytes = decode(input.contentBase64);
    return this.mutate("save", input, {
      content_sha256: sha256(bytes),
      byte_length: bytes.length,
      content_base64: input.contentBase64,
      content_revision_id: null,
    });
  }

  public restore(input: ManagedProjectFileChangeInput): ManagedProjectFileReceipt {
    return this.mutate("restore", input);
  }

  public delete(input: ManagedProjectFileChangeInput): ManagedProjectFileReceipt {
    return this.mutate("delete", input);
  }

  private mutate(
    operation: "save" | "restore" | "delete",
    input: ManagedProjectFileSaveInput | ManagedProjectFileChangeInput,
    savedContent?: Content,
  ): ManagedProjectFileReceipt {
    validateScope(input);
    validateIdentifier(input.effectId, "effectId");
    if (operation !== "save" || input.expectedRevision !== null)
      validateIdentifier(input.expectedRevision, "expectedRevision");
    const key = managedProjectFilePathKey(input.path);
    const { workspaceId, projectId, effectId, expectedRevision } = input;
    const digest = sha256(
      JSON.stringify([operation, workspaceId, projectId, key, expectedRevision, savedContent?.content_sha256 ?? null]),
    );
    return this.db.transaction("immediate", () => {
      // A project row serializes both head changes and shared quota in PostgreSQL.
      const lock = this.db.dialect === "postgres" ? " FOR UPDATE" : "";
      const project = this.db
        .prepare(
          `
        SELECT project_id FROM chat_projects
        WHERE workspace_id = ? AND project_id = ? AND lifecycle_status = 'active'${lock}
      `,
        )
        .get(workspaceId, projectId);
      if (!project) throw new NotFoundError({ entity: "Active managed project", id: projectId });
      const replay = this.db
        .prepare(
          `
        SELECT ${revisionFields}, r.request_sha256 FROM managed_project_file_revisions r WHERE r.effect_id = ?
      `,
        )
        .get<RevisionRow>(effectId);
      if (replay) {
        if (
          replay.workspace_id !== workspaceId ||
          replay.project_id !== projectId ||
          replay.request_sha256 !== digest
        ) {
          throw effectConflict();
        }
        return { ...revision(replay), replayed: true };
      }
      const head = this.head(input, key);
      const live = head && head.content_sha256 !== null ? head : undefined;
      if ((live?.revision_id ?? null) !== expectedRevision) throw fileChanged();
      let content = tombstone;
      if (savedContent) {
        if (live) this.verifiedBytes(input, live);
        else this.assertPathAvailable(input, key);
        this.assertSaveQuota(input, savedContent.byte_length);
        content = savedContent;
      } else if (operation === "restore") {
        const previous = live?.previous_revision_id && this.findRevision(input, key, live.previous_revision_id);
        if (!live || !canRestore(live) || !previous || previous.content_sha256 === null) {
          throw new ConflictError({ message: "The current managed file has no prior file version to restore." });
        }
        this.verifiedBytes(input, live);
        this.verifiedBytes(input, previous);
        content = {
          content_sha256: previous.content_sha256,
          byte_length: previous.byte_length,
          content_base64: null,
          content_revision_id: previous.content_revision_id ?? previous.revision_id,
        };
      }
      const row: RevisionRow = {
        workspace_id: workspaceId,
        project_id: projectId,
        path_key: key,
        path: live?.path ?? input.path,
        revision_id: randomUUID(),
        previous_revision_id: live?.revision_id ?? null,
        request_sha256: digest,
        ...content,
      };
      const inserted = this.db
        .prepare(
          `
        INSERT INTO managed_project_file_revisions (
          workspace_id, project_id, path_key, path, revision_id, previous_revision_id, effect_id, request_sha256,
          content_sha256, byte_length, content_base64, content_revision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (effect_id) DO NOTHING
      `,
        )
        .run(
          workspaceId,
          projectId,
          key,
          row.path,
          row.revision_id,
          row.previous_revision_id,
          effectId,
          digest,
          row.content_sha256,
          row.byte_length,
          row.content_base64,
          row.content_revision_id,
        );
      if (inserted.changes !== 1) throw effectConflict();
      const written = head
        ? this.db
            .prepare(
              `
            UPDATE managed_project_file_heads SET revision_id = ?
            WHERE workspace_id = ? AND project_id = ? AND path_key = ? AND revision_id = ?
          `,
            )
            .run(row.revision_id, workspaceId, projectId, key, head.revision_id)
        : this.db
            .prepare(
              `
            INSERT INTO managed_project_file_heads (workspace_id, project_id, path_key, revision_id)
            VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, project_id, path_key) DO NOTHING
          `,
            )
            .run(workspaceId, projectId, key, row.revision_id);
      if (written.changes !== 1) throw fileChanged();
      return { ...revision(row), replayed: false };
    });
  }

  private head(scope: ManagedProjectFileScope, key: string): RevisionRow | undefined {
    return this.db
      .prepare(
        `
      SELECT r.* FROM managed_project_file_heads h
      JOIN managed_project_file_revisions r USING (workspace_id, project_id, path_key, revision_id)
      JOIN chat_projects p ON p.project_id = r.project_id AND p.workspace_id = r.workspace_id
      WHERE r.workspace_id = ? AND r.project_id = ? AND r.path_key = ? AND p.lifecycle_status = 'active'
    `,
      )
      .get<RevisionRow>(scope.workspaceId, scope.projectId, key);
  }

  private findRevision(scope: ManagedProjectFileScope, key: string, revisionId: string): RevisionRow | undefined {
    return this.db
      .prepare(
        `
      SELECT * FROM managed_project_file_revisions
      WHERE workspace_id = ? AND project_id = ? AND path_key = ? AND revision_id = ?
    `,
      )
      .get<RevisionRow>(scope.workspaceId, scope.projectId, key, revisionId);
  }

  private verifiedBytes(scope: ManagedProjectFileScope, row: RevisionRow): string {
    const source =
      row.content_revision_id === null ? row : this.findRevision(scope, row.path_key, row.content_revision_id);
    if (source?.content_base64 == null)
      throw new ConflictError({ message: "Managed file recovery bytes are unavailable." });
    const bytes = decode(source.content_base64);
    if (bytes.length !== row.byte_length || sha256(bytes) !== row.content_sha256) {
      throw new ConflictError({ message: "Managed file recovery bytes could not be verified." });
    }
    return source.content_base64;
  }

  private assertPathAvailable(scope: ManagedProjectFileScope, key: string): void {
    const conflict = this.db
      .prepare(
        `
      SELECT 1 FROM managed_project_file_heads h
      JOIN managed_project_file_revisions r USING (workspace_id, project_id, path_key, revision_id)
      WHERE r.workspace_id = ? AND r.project_id = ? AND r.content_sha256 IS NOT NULL
        AND (substr(?, 1, length(r.path_key) + 1) = r.path_key || '/'
          OR substr(r.path_key, 1, length(?) + 1) = ? || '/')
      LIMIT 1
    `,
      )
      .get(scope.workspaceId, scope.projectId, key, key, key);
    if (conflict)
      throw new ConflictError({ message: "The managed file path conflicts with an existing file or folder." });
  }

  private assertSaveQuota(scope: ManagedProjectFileScope, nextBytes: number): void {
    const usage = this.db
      .prepare(
        `
      SELECT COUNT(*) AS versions, COALESCE(SUM(byte_length), 0) AS bytes
      FROM managed_project_file_revisions
      WHERE workspace_id = ? AND project_id = ? AND content_base64 IS NOT NULL
    `,
      )
      .get<{ versions: number; bytes: number }>(scope.workspaceId, scope.projectId);
    const versions = Number(usage?.versions);
    const bytes = Number(usage?.bytes);
    if (
      !Number.isSafeInteger(versions) ||
      versions < 0 ||
      versions >= maxStoredVersions ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes + nextBytes > maxStoredBytes
    ) {
      throw new ConflictError({ message: "Managed project file history has reached its storage limit." });
    }
  }
}

export function managedProjectFilePathKey(path: string): string {
  if (
    typeof path !== "string" ||
    path.length > 512 ||
    path
      .split("/")
      .some(
        (part) =>
          !/^[A-Za-z0-9._ -]{1,128}$/.test(part) ||
          part.startsWith(" ") ||
          /[. ]$/.test(part) ||
          reservedName.test(part.split(".", 1)[0]!.trimEnd()) ||
          part.toLowerCase() === ".git",
      )
  ) {
    throw new ValidationError({ message: "Use a portable relative path for the managed project file." });
  }
  return path.toLowerCase();
}

function revision(row: RevisionRow): ManagedProjectFileRevision {
  return {
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    path: row.path,
    revisionId: row.revision_id,
    previousRevisionId: row.previous_revision_id,
    contentSha256: row.content_sha256,
    byteLength: Number(row.byte_length),
    deleted: row.content_sha256 === null,
    canRestore: canRestore(row),
  };
}

function canRestore(row: RevisionRow): boolean {
  return row.content_sha256 !== null && row.previous_revision_id !== null && row.content_revision_id === null;
}

function decode(value: string): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(MANAGED_PROJECT_FILE_MAX_BYTES / 3) * 4) {
    throw new ValidationError({ message: "Managed file content is too large or malformed." });
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MANAGED_PROJECT_FILE_MAX_BYTES || bytes.toString("base64") !== value) {
    throw new ValidationError({ message: "Managed file content must be canonical base64 within the file size limit." });
  }
  return bytes;
}

function validateIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 256 ||
    value.trim() !== value ||
    value.includes("\0")
  ) {
    throw new ValidationError({ field });
  }
}

function validateScope(scope: ManagedProjectFileScope): void {
  validateIdentifier(scope.workspaceId, "workspaceId");
  validateIdentifier(scope.projectId, "projectId");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileChanged(): ConflictError {
  return new ConflictError({ message: "The managed file changed. Read its current revision and try again." });
}

function effectConflict(): ConflictError {
  return new ConflictError({ message: "The managed file effect was used for a different change." });
}
