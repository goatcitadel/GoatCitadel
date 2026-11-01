import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  type McpServerRecord,
  type McpServerTemplateRecord,
  type PluginManifestParse,
} from "@goatcitadel/contracts";
import type { PluginPieceLabel } from "./capability-plugin-detail.js";
import type { StoredPlugin, StoredPluginPiece } from "./capability-plugin-store.js";
import { mcpServerLabelKey } from "./mcp-money-moving.js";

// What a plugin uninstall will act on beyond the pieces its record names: the connectors it added (and any saved server
// marked as its install's that no piece names), what each becomes, and the hooks holding a signing secret its install
// stored. Read once when the plan is made and again before it applies, so the plan does what its confirmation said.

/** A hook in the workspace that signs with a stored secret: what an uninstall reads to tell which secrets are in use. */
export interface HookSecretHolder {
  hookId: string;
  /** Its name, as the Hooks list shows it. */
  label: string;
  secretRef: string;
  url: string;
}

/**
 * What one connector becomes. `remove`: it is disconnected and deleted. `keep`: another plugin kept it (`sure` when its
 * template matches; otherwise that plugin kept a connector whose template is gone, which could be this one), so it is
 * handed to the operator. `unknown`: another plugin's connectors can't be read, so nothing is decided. `gone`: the
 * server is gone already. `handed_over`: the server no longer carries this install's mark, so it is the operator's.
 */
export type ConnectorDecision = { serverId: string; pieceId?: string; label: string } & (
  | { action: "remove" | "gone" | "handed_over" }
  | { action: "keep"; keeper: string; sure: boolean }
  | { action: "unknown"; plugin: string }
);

/**
 * A hook holding one of the install's stored secrets that no piece names. `remove`: the install made it before its
 * record named it, so it goes with its secret. `keep`: anything else (another hook sharing the secret, or one now
 * sending elsewhere), so both are kept and the uninstall stops there.
 */
export interface HolderDecision {
  hookId: string;
  label: string;
  host?: string;
  pieceId: string;
  action: "remove" | "keep";
}

/** The hooks couldn't be read in full: the references the install stored, and why. */
export interface UnreadHolders {
  unread: true;
  secretRefs: readonly string[];
  error: unknown;
}

export interface UninstallScope {
  /** Undefined when the saved connectors or the other plugins couldn't be read. */
  connectors?: readonly ConnectorDecision[];
  holders: readonly HolderDecision[] | UnreadHolders;
}

/** The readers a scope comes from: the uninstall's own sources. */
export interface UninstallScopeReaders {
  listPlugins(): Promise<readonly StoredPlugin[]>;
  readManifest(treeSha256: string): Promise<PluginManifestParse>;
  listSavedConnectors(): Promise<readonly McpServerRecord[]>;
  connectorTemplates(): readonly McpServerTemplateRecord[];
  readInstallSecretRefs(
    workspaceId: string,
    installPlanId: string,
    actorId: string,
  ): Promise<Readonly<Record<string, string>>>;
  listHookSecrets(workspaceId: string): Promise<readonly HookSecretHolder[] | undefined>;
}

/** The scope's evidence reference: the plan carries it, and apply refuses one whose scope moved since. */
export function scopeEvidenceRef(scope: UninstallScope): string {
  const holders = "unread" in scope.holders ? "unread" : scope.holders;
  const digest = createHash("sha256")
    .update(canonicalJsonString({ connectors: scope.connectors ?? "unread", holders }))
    .digest("hex");
  return `plugin_uninstall_scope:${digest}`;
}

export async function readUninstallScope(
  readers: UninstallScopeReaders,
  record: StoredPlugin,
  actorId: string,
  labels: ReadonlyMap<string, PluginPieceLabel>,
): Promise<UninstallScope> {
  const [connectors, holders] = await Promise.all([
    readConnectorScope(readers, record, labels).catch(() => undefined),
    readHolderScope(readers, record, actorId, labels),
  ]);
  return { ...(connectors ? { connectors } : {}), holders };
}

/** Whether a saved server carries this install's mark. */
export function markedByInstall(server: McpServerRecord, record: StoredPlugin): boolean {
  return server.pluginOwner?.pluginId === record.pluginId && server.pluginOwner.installPlanId === record.installPlanId;
}

async function readConnectorScope(
  readers: UninstallScopeReaders,
  record: StoredPlugin,
  labels: ReadonlyMap<string, PluginPieceLabel>,
): Promise<readonly ConnectorDecision[]> {
  const pieces = record.pieces.filter((piece) => piece.kind === "connector" && piece.owned);
  // A plugin that added no connector never reads the saved ones, nor another plugin's.
  if (pieces.length === 0) return [];
  const saved = await readers.listSavedConnectors();
  const decisions: ConnectorDecision[] = [];
  const open: Array<{ server: McpServerRecord; piece?: StoredPluginPiece; label: string }> = [];
  for (const piece of pieces) {
    if (piece.ref === undefined) continue;
    const label = labels.get(piece.pieceId)?.label ?? piece.pieceId;
    const server = saved.find((item) => item.serverId === piece.ref);
    if (!server) decisions.push({ serverId: piece.ref, pieceId: piece.pieceId, label, action: "gone" });
    else if (!markedByInstall(server, record)) {
      decisions.push({ serverId: piece.ref, pieceId: piece.pieceId, label, action: "handed_over" });
    } else open.push({ server, piece, label });
  }
  // Saved and marked by this install, which stopped before its record named it.
  const named = new Set(pieces.flatMap((piece) => (piece.ref === undefined ? [] : [piece.ref])));
  for (const server of saved) {
    if (markedByInstall(server, record) && !named.has(server.serverId)) open.push({ server, label: server.label });
  }
  if (open.length === 0) return decisions;
  const keepers = await readKeepers(readers, record);
  for (const { server, piece, label } of open) {
    decisions.push({
      serverId: server.serverId,
      ...(piece ? { pieceId: piece.pieceId } : {}),
      label,
      ...decide(server, keepers),
    });
  }
  return decisions;
}

interface Keepers {
  /** By the label key the inspection matches a saved connector on: the plugin that kept it. */
  exact: ReadonlyMap<string, string>;
  /** Plugins that kept a connector whose template is gone from the catalog: it could be any of them. */
  possible: readonly string[];
  /** Plugins whose manifest can't be read, so what they kept can't be told. */
  unreadable: readonly string[];
}

function decide(
  server: McpServerRecord,
  keepers: Keepers,
): { action: "remove" } | { action: "keep"; keeper: string; sure: boolean } | { action: "unknown"; plugin: string } {
  const exact = keepers.exact.get(mcpServerLabelKey(server.label));
  if (exact) return { action: "keep", keeper: exact, sure: true };
  const possible = keepers.possible[0];
  if (possible) return { action: "keep", keeper: possible, sure: false };
  const unreadable = keepers.unreadable[0];
  if (unreadable) return { action: "unknown", plugin: unreadable };
  return { action: "remove" };
}

/** The other installed plugins that kept a connector, read from their manifests and the shipped catalog. */
async function readKeepers(readers: UninstallScopeReaders, record: StoredPlugin): Promise<Keepers> {
  const exact = new Map<string, string>();
  const possible: string[] = [];
  const unreadable: string[] = [];
  const templates = readers.connectorTemplates();
  for (const other of await readers.listPlugins()) {
    if (other.pluginId === record.pluginId) continue;
    const kept = other.pieces.filter((piece) => piece.kind === "connector" && !piece.owned && !piece.handedOver);
    if (kept.length === 0) continue;
    const parsed = await readers.readManifest(other.snapshotTreeSha256).catch(() => undefined);
    if (!parsed?.ok || parsed.manifestSha256 !== other.manifestSha256) {
      unreadable.push(other.name);
      continue;
    }
    for (const piece of kept) {
      const manifestPiece = parsed.manifest.pieces.find((item) => item.id === piece.pieceId);
      const template =
        manifestPiece?.kind === "connector"
          ? templates.find((item) => item.templateId === manifestPiece.templateId)
          : undefined;
      if (template) exact.set(mcpServerLabelKey(template.label), other.name);
      else if (!possible.includes(other.name)) possible.push(other.name);
    }
  }
  return { exact, possible, unreadable };
}

async function readHolderScope(
  readers: UninstallScopeReaders,
  record: StoredPlugin,
  actorId: string,
  labels: ReadonlyMap<string, PluginPieceLabel>,
): Promise<readonly HolderDecision[] | UnreadHolders> {
  const hookPieces = record.pieces.filter((piece) => piece.kind === "hook" && piece.owned);
  // A plugin with no hooks stored no secret.
  if (hookPieces.length === 0) return [];
  let stored: Readonly<Record<string, string>> = {};
  let listed: readonly HookSecretHolder[] | undefined;
  try {
    stored = await readers.readInstallSecretRefs(record.workspaceId, record.installPlanId, actorId);
    listed = await readers.listHookSecrets(record.workspaceId);
    if (!listed) throw new Error("The workspace has too many hooks to read them all at once.");
  } catch (error) {
    return { unread: true, secretRefs: Object.values(stored), error };
  }
  const named = new Set(hookPieces.flatMap((piece) => (piece.ref === undefined ? [] : [piece.ref])));
  const holders: HolderDecision[] = [];
  for (const [pieceId, secretRef] of Object.entries(stored)) {
    const piece = hookPieces.find((item) => item.pieceId === pieceId);
    const expectedHost = labels.get(pieceId)?.hosts?.[0];
    for (const hook of listed.filter((item) => item.secretRef === secretRef && !named.has(item.hookId))) {
      const host = hostOf(hook.url);
      // Only a hook its piece never named (no hook recorded, nothing removed yet), sending where that piece does.
      const madeByInstall = piece?.ref === undefined && piece?.removed === undefined;
      const sendsThere = expectedHost === undefined || host === expectedHost;
      holders.push({
        hookId: hook.hookId,
        label: hook.label,
        ...(host ? { host } : {}),
        pieceId,
        action: piece && madeByInstall && sendsThere ? "remove" : "keep",
      });
    }
  }
  return holders;
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}
