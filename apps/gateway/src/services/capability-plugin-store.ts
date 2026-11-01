import {
  ConflictError,
  redactStructuredSecrets,
  type CapabilityPluginInspection,
  type PluginPieceKind,
  type PluginPin,
  type PluginSource,
  type PluginTrust,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";

// The plugin store: one `system_settings` row (`capability_plugins_v1`) holding a record for every installed plugin and
// the newest inspections. The Gateway alone reads and writes it, always whole and always by compare-and-set, so two
// writers never lose each other's change.

export const CAPABILITY_PLUGINS_SETTING_KEY = "capability_plugins_v1";
/** The most inspections kept. Older ones, and any that ran out of time, are dropped on the next save. */
export const MAX_KEPT_INSPECTIONS = 50;
/** The most uninstalled plugins remembered, newest first, so their skills read "Removed with <plugin>". */
export const MAX_REMOVED_PLUGINS = 100;
/** How many times a write reads again after another writer got there first. */
const MAX_WRITE_ATTEMPTS = 8;
const CHANGED_WHILE_SAVING_MESSAGE = "Plugins changed while this was being saved. Try again.";
const UNREADABLE_MESSAGE = "The saved plugin records can't be read.";
const log = logger.child("capability-plugin-store");

export interface StoredPluginPiece {
  pieceId: string;
  kind: PluginPieceKind;
  /** False for a piece that was already there: uninstalling leaves it. */
  owned: boolean;
  /** What the piece became: a server, group, hook or prompt pack id. Uninstalling clears it once the piece is gone. */
  ref?: string;
  skillSnapshotId?: string;
  /**
   * While uninstalling: the uninstall is done with this piece. Its owner removed it, or, for a skill, it was revoked
   * or left switched off for good, with its skill's id when it had one.
   */
  removed?: { skillId?: string };
  /** While uninstalling: the approval this skill's removal waits for, its revoke or its own step. */
  waiting?: { approvalId: string; operation: "revoke" | "install_inactive" | "activate" };
  /**
   * While uninstalling: a connector the plugin added that was left to the operator, as another plugin kept it. It reads
   * as kept (`owned` is then false), and nothing removes it.
   */
  handedOver?: true;
}

export interface StoredPlugin {
  pluginId: string;
  name: string;
  description: string;
  version: string;
  trust: PluginTrust;
  sourceKind: PluginSource["kind"];
  sourceDisplay: string;
  pin: PluginPin;
  manifestSha256: string;
  snapshotTreeSha256: string;
  workspaceId: string;
  installPlanId: string;
  state: "installing" | "installed" | "uninstalling";
  installedAt: string;
  /** The plan removing it, from the moment its uninstall starts applying. */
  uninstallPlanId?: string;
  pieces: StoredPluginPiece[];
}

/** An uninstalled plugin, remembered so the skills it left behind read as removed with it. */
export interface RemovedPlugin {
  pluginId: string;
  name: string;
  /** Its skills' ids, revoked or left switched off by the uninstall. */
  skillIds: string[];
  removedAt: string;
}

/** The row as system settings hands it back. */
export interface CapabilityPluginSettingRecord {
  key: string;
  value: unknown;
  updatedAt: string;
}

/** The two system settings calls the store makes: a read, and a write that lands only on the row it read. */
export interface CapabilityPluginSettingRows {
  get(key: string): Promise<CapabilityPluginSettingRecord | undefined>;
  compareAndSet(
    key: string,
    expected: CapabilityPluginSettingRecord | undefined,
    value: unknown,
  ): Promise<CapabilityPluginSettingRecord | undefined>;
}

/** The request an inspection answered, so the same key in the same scope gets the same answer again. */
export interface CapabilityPluginInspectionRequestKey {
  /** The scope the Gateway's idempotency plugin holds the key under: the signed-in actor, or "" without sign-in. */
  actorScope: string;
  idempotencyKey: string;
  /** The SHA-256 of the request's workspace and source, so a key reused for another check is told apart. */
  payloadSha256: string;
}

interface KeptInspection {
  inspection: CapabilityPluginInspection;
  snapshotTreeSha256: string;
  request?: CapabilityPluginInspectionRequestKey;
}

interface PluginStoreValue {
  version: 1;
  plugins: StoredPlugin[];
  inspections: KeptInspection[];
  /** Absent in a row written before any plugin was uninstalled: read as none. */
  removed?: RemovedPlugin[];
}

export class CapabilityPluginStore {
  private readonly changeListeners = new Set<() => void>();

  public constructor(
    private readonly rows: CapabilityPluginSettingRows,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Calls `listener` after every write through this store lands, so a reader that keeps what the records say (the
   * tool-group holds) reads them again. A listener's own failure never fails the write. Answers a function that stops it.
   */
  public onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  public async list(): Promise<StoredPlugin[]> {
    return (await this.read()).value.plugins;
  }

  public async get(pluginId: string): Promise<StoredPlugin | undefined> {
    return (await this.read()).value.plugins.find((plugin) => plugin.pluginId === pluginId);
  }

  /**
   * Replaces one plugin's record with what `change` answers, or removes it when `change` answers nothing. `change` may
   * run more than once, each time on the newest record, when another writer saves in between.
   */
  public async update(
    pluginId: string,
    change: (current: StoredPlugin | undefined) => StoredPlugin | undefined,
  ): Promise<void> {
    await this.write((value) => {
      const current = value.plugins.find((plugin) => plugin.pluginId === pluginId);
      const next = change(current);
      if (next !== undefined && next.pluginId !== pluginId) throw new TypeError("A plugin record can't change its id.");
      const others = value.plugins.filter((plugin) => plugin.pluginId !== pluginId);
      if (!next) return { ...value, plugins: others };
      // A record keeps its place; a new one goes last.
      const plugins = current
        ? value.plugins.map((plugin) => (plugin.pluginId === pluginId ? next : plugin))
        : [...others, next];
      return { ...value, plugins };
    });
  }

  /**
   * Deletes one plugin's record and keeps the tombstone `remember` answers for it, in the same write, with the newest
   * 100 tombstones. The plugin's kept inspections go too: each was checked before the uninstall, so none can install it
   * past the checks a fresh inspection now makes. `remember` may run more than once, each time on the newest record,
   * and may throw to refuse.
   */
  public async remove(pluginId: string, remember: (current: StoredPlugin | undefined) => RemovedPlugin): Promise<void> {
    await this.write((value) => {
      const tombstone = remember(value.plugins.find((plugin) => plugin.pluginId === pluginId));
      return {
        ...value,
        plugins: value.plugins.filter((plugin) => plugin.pluginId !== pluginId),
        inspections: value.inspections.filter((kept) => kept.inspection.pluginId !== pluginId),
        removed: [tombstone, ...(value.removed ?? [])].slice(0, MAX_REMOVED_PLUGINS),
      };
    });
  }

  /** The uninstalled plugins remembered, newest first. */
  public async listRemoved(): Promise<RemovedPlugin[]> {
    return (await this.read()).value.removed ?? [];
  }

  /**
   * Keeps an inspection with the snapshot it read, and the request it answered, with the newest 50 that haven't run
   * out of time.
   */
  public async saveInspection(
    inspection: CapabilityPluginInspection,
    snapshotTreeSha256: string,
    request?: CapabilityPluginInspectionRequestKey,
  ): Promise<void> {
    await this.write((value) => {
      const nowMs = this.now().getTime();
      const others = value.inspections.filter(
        (kept) => kept.inspection.inspectionId !== inspection.inspectionId && !hasExpired(kept, nowMs),
      );
      const inspections = [{ inspection, snapshotTreeSha256, ...(request ? { request } : {}) }, ...others]
        .sort((left, right) => Date.parse(right.inspection.inspectedAt) - Date.parse(left.inspection.inspectedAt))
        .slice(0, MAX_KEPT_INSPECTIONS);
      return { ...value, inspections };
    });
  }

  /** An inspection and the snapshot it read, unless it isn't kept or has run out of time. */
  public async getInspection(inspectionId: string): Promise<KeptInspection | undefined> {
    const kept = (await this.read()).value.inspections.find((item) => item.inspection.inspectionId === inspectionId);
    if (!kept || hasExpired(kept, this.now().getTime())) return undefined;
    return { inspection: kept.inspection, snapshotTreeSha256: kept.snapshotTreeSha256 };
  }

  /** The kept inspection that answered this key in this scope, unless it has run out of time or been dropped. */
  public async findInspectionByRequest(
    actorScope: string,
    idempotencyKey: string,
  ): Promise<{ inspection: CapabilityPluginInspection; payloadSha256: string } | undefined> {
    const nowMs = this.now().getTime();
    const kept = (await this.read()).value.inspections.find(
      (item) =>
        item.request?.actorScope === actorScope &&
        item.request.idempotencyKey === idempotencyKey &&
        !hasExpired(item, nowMs),
    );
    return kept?.request ? { inspection: kept.inspection, payloadSha256: kept.request.payloadSha256 } : undefined;
  }

  private async read(): Promise<{ record: CapabilityPluginSettingRecord | undefined; value: PluginStoreValue }> {
    const record = await this.rows.get(CAPABILITY_PLUGINS_SETTING_KEY);
    return { record, value: record ? parseStoreValue(record.value) : { version: 1, plugins: [], inspections: [] } };
  }

  private async write(transform: (value: PluginStoreValue) => PluginStoreValue): Promise<void> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const { record, value } = await this.read();
      const saved = await this.rows.compareAndSet(CAPABILITY_PLUGINS_SETTING_KEY, record, transform(value));
      if (saved) {
        this.announceChange();
        return;
      }
    }
    throw new ConflictError({ code: "WRITE_CONFLICT", message: CHANGED_WHILE_SAVING_MESSAGE });
  }

  private announceChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        // The write has landed, so a listener's failure is logged and never fails it.
        const diagnostic = error instanceof Error ? { name: error.name, message: error.message } : { value: error };
        log.error("a plugin store change listener failed", { err: redactStructuredSecrets(diagnostic).value });
      }
    }
  }
}

/** The plugin whose own piece of this kind became `ref`. A piece a plugin only kept belongs to the operator. */
export function findPluginOwning(
  plugins: readonly StoredPlugin[],
  kind: PluginPieceKind,
  ref: string,
): StoredPlugin | undefined {
  return plugins.find((plugin) =>
    plugin.pieces.some((piece) => piece.kind === kind && piece.owned && piece.ref === ref),
  );
}

/** The plugin whose own piece of this kind became `ref`, read from the saved records: what a refusal names. */
export async function readPluginPieceOwner(
  rows: CapabilityPluginSettingRows,
  kind: PluginPieceKind,
  ref: string,
): Promise<{ pluginId: string; name: string; installPlanId: string } | undefined> {
  const plugin = findPluginOwning(await new CapabilityPluginStore(rows).list(), kind, ref);
  return plugin ? { pluginId: plugin.pluginId, name: plugin.name, installPlanId: plugin.installPlanId } : undefined;
}

/**
 * The tool groups plugins hold off: every owned `tool_group_off` piece that names its group, of a plugin in any state.
 * A record leaves only when its plugin is gone, so a hold lasts through an install and an uninstall until then. A group
 * a plugin only kept off is the operator's switch, not a hold.
 */
export function pluginToolGroupHolds(
  plugins: readonly StoredPlugin[],
): Array<{ groupId: string; pluginId: string; pluginName: string }> {
  return plugins.flatMap((plugin) =>
    plugin.pieces
      .filter((piece) => piece.kind === "tool_group_off" && piece.owned && piece.ref !== undefined)
      .map((piece) => ({ groupId: piece.ref!, pluginId: plugin.pluginId, pluginName: plugin.name })),
  );
}

/**
 * The plugin each Skill Hub check belongs to, by check id: every skill piece a record lists, of a plugin in any state.
 * What marks a skill switched on from one of them as the plugin's.
 */
export function pluginsBySkillCheck(
  plugins: readonly Pick<StoredPlugin, "pluginId" | "name" | "pieces">[],
): Map<string, { pluginId: string; name: string }> {
  return new Map(
    plugins.flatMap((plugin) =>
      plugin.pieces.flatMap((piece) =>
        piece.kind === "skill" && piece.skillSnapshotId !== undefined
          ? [[piece.skillSnapshotId, { pluginId: plugin.pluginId, name: plugin.name }] as const]
          : [],
      ),
    ),
  );
}

/**
 * The plugin each skill an uninstall removed was removed with, by skill id: the newest uninstall that names the skill.
 * What reads a skill as "Removed with <plugin>" once the plugin's record is gone.
 */
export function removedPluginSkills(removed: readonly RemovedPlugin[]): Map<string, { name: string }> {
  const skills = new Map<string, { name: string }>();
  for (const tombstone of removed) {
    for (const skillId of tombstone.skillIds) if (!skills.has(skillId)) skills.set(skillId, { name: tombstone.name });
  }
  return skills;
}

function hasExpired(kept: KeptInspection, nowMs: number): boolean {
  const expiresAt = Date.parse(kept.inspection.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
}

/**
 * The saved value, when it has the shape this store writes. Anything else (an older or newer version, a hand edit) is
 * refused rather than read as empty, so a write never replaces records it couldn't read.
 */
function parseStoreValue(value: unknown): PluginStoreValue {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.plugins) || !Array.isArray(value.inspections)) {
    throw new Error(UNREADABLE_MESSAGE);
  }
  const plugins = value.plugins.every(
    (plugin) => isObject(plugin) && typeof plugin.pluginId === "string" && Array.isArray(plugin.pieces),
  );
  const inspections = value.inspections.every(
    (kept) =>
      isObject(kept) &&
      typeof kept.snapshotTreeSha256 === "string" &&
      isObject(kept.inspection) &&
      typeof kept.inspection.inspectionId === "string",
  );
  const removed =
    value.removed === undefined ||
    (Array.isArray(value.removed) &&
      value.removed.every(
        (tombstone) =>
          isObject(tombstone) &&
          typeof tombstone.pluginId === "string" &&
          typeof tombstone.name === "string" &&
          Array.isArray(tombstone.skillIds) &&
          tombstone.skillIds.every((skillId) => typeof skillId === "string"),
      ));
  if (!plugins || !inspections || !removed) throw new Error(UNREADABLE_MESSAGE);
  return value as unknown as PluginStoreValue;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
