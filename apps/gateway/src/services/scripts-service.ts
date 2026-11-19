import { createHash } from "node:crypto";
import path from "node:path";
import {
  ConflictError,
  NotFoundError,
  redactSecretText,
  type ScriptInventoryItem,
  type ScriptInventoryResponse,
  type ScriptRetentionUpdate,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

interface Retention {
  retention: ScriptInventoryItem["retention"];
  version: number;
}
const keyFor = (workspaceId: string, id: string) =>
  `script-retention-v1:${createHash("sha256")
    .update(JSON.stringify([workspaceId, id]))
    .digest("hex")}`;
export class ScriptsService {
  constructor(
    private readonly storage: Pick<
      AsyncStorage,
      "scriptInventory" | "systemSettings" | "audit" | "runImmediateTransaction" | "workspaces"
    >,
    private readonly sharedRoot: string,
  ) {}

  public async list(workspaceId: string): Promise<ScriptInventoryResponse> {
    await this.storage.workspaces.get(workspaceId);
    const records = await this.storage.scriptInventory.list(workspaceId);
    const savedRetention = new Map(
      (await this.storage.systemSettings.getMany(records.map((record) => keyFor(workspaceId, record.id)))).map(
        (record) => [record.key, record.value as Retention],
      ),
    );
    const items: ScriptInventoryItem[] = [];
    for (const record of records) {
      const saved = savedRetention.get(keyFor(workspaceId, record.id));
      // Workspace outputs outside the installation's shared root remain findable through their source.
      // Never turn an absolute tool-returned path into permission to read a host file.
      const relative =
        record.kind === "workspace" && record.path
          ? path.relative(this.sharedRoot, path.resolve(record.path))
          : undefined;
      items.push({
        ...record,
        title: redactSecretText(record.title).value,
        ...(relative !== undefined
          ? {
              path:
                relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
                  ? relative
                  : undefined,
            }
          : {}),
        retention: saved?.retention ?? "permanent",
        retentionVersion: saved?.version ?? 0,
        expiresAt: null,
      });
    }
    return {
      items: items.sort(
        (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.title.localeCompare(b.title),
      ),
      coverage:
        "Up to 1,000 records per creation path: saved Chat artifacts, managed project files, tool outputs, successful file writes and documents, and Code Mode source artifacts. Unrecorded files and shell-created files are not discovered. Temporary is a label only; no automatic cleanup or expiration is configured. Execution evidence and user files stay with their original owners.",
    };
  }

  public async update(input: ScriptRetentionUpdate, actorId: string): Promise<ScriptInventoryItem> {
    return this.storage.runImmediateTransaction(async () => {
      const item = (await this.list(input.workspaceId)).items.find((item) => item.id === input.id);
      if (!item) throw new NotFoundError({ entity: "Script" });
      const key = keyFor(input.workspaceId, input.id);
      const previous = await this.storage.systemSettings.get<Retention>(key);
      if ((previous?.value.version ?? 0) !== input.expectedVersion)
        throw new ConflictError({ message: "Retention changed. Refresh Scripts and try again." });
      const value = { retention: input.retention, version: input.expectedVersion + 1 };
      if (!(await this.storage.systemSettings.compareAndSet(key, previous, value)))
        throw new ConflictError({ message: "Retention changed. Refresh Scripts and try again." });
      await this.storage.audit.append("tool_invocations", {
        event: "script_retention_changed",
        actorId,
        workspaceId: input.workspaceId,
        itemId: item.id,
        retention: value.retention,
        version: value.version,
      });
      return { ...item, retention: value.retention, retentionVersion: value.version };
    });
  }
}
