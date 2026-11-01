import type { PluginManifestRefusalCode, PluginPieceKind, PluginPin, PluginSource, PluginTrust } from "./plugins.js";

// ---------------------------------------------------------------------------
// Capabilities › Plugins: what the Gateway answers about a plugin before and after it is installed.
//
// The Gateway fetches the source, reads the manifest and checks every piece with that piece's own owner. Mission
// Control only renders these answers; it never decides whether a piece passes or a plugin can be installed.
// ---------------------------------------------------------------------------

/** One piece's check: it passes, it is already there (and stays when the plugin is uninstalled), or it is blocked. */
export type CapabilityPluginPieceCheck =
  | { status: "ready" }
  | { status: "already_there" }
  | { status: "blocked"; code: string; message: string };

export interface CapabilityPluginPieceView {
  pieceId: string;
  kind: PluginPieceKind;
  /** The skill's name, the connector's label, the tool group's label, the hook's trigger label or the prompt pack's name. */
  label: string;
  /** A plain line written by the Gateway: what the piece does, or asks, once installed. */
  asksFirst: string;
  check: CapabilityPluginPieceCheck;
  /** Hosts that installing allows: a connector's hosts, or a hook's. */
  hosts?: string[];
  /** The Skill Hub check of a skill piece, which installing that skill goes on from. */
  skillSnapshotId?: string;
  /** A hook piece needs a signing secret before it can be installed. */
  needsSecret?: boolean;
}

export interface CapabilityPluginInspection {
  inspectionId: string;
  workspaceId: string;
  /** Empty when the manifest was refused before it could be read. */
  pluginId: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  trust: PluginTrust;
  sourceKind: PluginSource["kind"];
  /** "Ships with GoatCitadel", `<host>/<owner>/<repo>`, or the folder's name. */
  sourceDisplay: string;
  pin: PluginPin;
  /** Lowercase hex SHA-256 of the manifest's bytes; empty when the manifest was refused. */
  manifestSha256: string;
  pieces: CapabilityPluginPieceView[];
  /** Parts of a foreign plugin format that were left out. Always empty for a GoatCitadel manifest. */
  ignored: { path: string; reason: string }[];
  /** Why the manifest was refused; `field` names where, such as `pieces[2].mode`. */
  refusal?: { code: PluginManifestRefusalCode | string; message: string; field?: string };
  /** No refusal, and every piece is ready or already there. */
  installable: boolean;
  inspectedAt: string;
  /** 24 hours after `inspectedAt`. An expired inspection can't be installed or read back. */
  expiresAt: string;
}

/**
 * `available`: not installed. `install_not_finished`: the install plan hasn't finished, or a skill piece isn't switched on
 * yet. `uninstalling`: removal is under way.
 */
export type CapabilityPluginState = "available" | "installed" | "install_not_finished" | "uninstalling";

export interface CapabilityPluginListItem {
  pluginId: string;
  name: string;
  description: string;
  version: string;
  trust: PluginTrust;
  sourceDisplay: string;
  state: CapabilityPluginState;
  pieceCounts: Partial<Record<PluginPieceKind, number>>;
}

/**
 * Where one installed plugin's piece is.
 * - `added`: the plugin added it, and a skill is switched on. `kept`: it was already there, so uninstalling leaves it.
 * - A skill's own steps: `check_passed` (not installed yet), `waiting_for_approval` (`pendingApprovalId`), `installing`
 *   (a step was approved and is being applied, or the install plan is still applying), `installed_off` (installed, not
 *   switched on, so the AI can't use it yet).
 * - `removed`: removed while the plugin is uninstalled. `failed`: its step stopped, or the install stopped before it.
 * - `unknown`: its state can't be read right now. It is never read as added.
 */
export type CapabilityPluginPieceState =
  | "added"
  | "kept"
  | "check_passed"
  | "installing"
  | "installed_off"
  | "waiting_for_approval"
  | "removed"
  | "failed"
  | "unknown";

/** One installed plugin's piece: what it is, where it is, and a link to its own item, all written by the Gateway. */
export type CapabilityPluginDetailPiece = CapabilityPluginPieceView & {
  state: CapabilityPluginPieceState;
  /** The approval it waits for, while `waiting_for_approval`. */
  pendingApprovalId?: string;
  /** The piece's own item in its tab, when it has one. */
  href?: string;
};

/**
 * `GET /api/v1/capabilities/plugins/detail?pluginId=&workspaceId=`: one installed plugin and each of its pieces. Its
 * `state` follows the same rule as the list's: `installed` only once every piece is added or kept.
 */
export interface CapabilityPluginDetail extends CapabilityPluginListItem {
  author?: string;
  pin: PluginPin;
  installPlanId: string;
  installedAt: string;
  pieces: CapabilityPluginDetailPiece[];
}

/**
 * `GET /api/v1/capabilities/plugins`. `installed` lists the plugins GoatCitadel has a record of, install-wide.
 * `builtIn` lists the plugins that ship with GoatCitadel and aren't installed; listing them fetches and checks nothing.
 */
export interface CapabilityPluginListResponse {
  installed: CapabilityPluginListItem[];
  builtIn: CapabilityPluginListItem[];
}

/** `POST /api/v1/capabilities/plugins/inspections`. It installs nothing. */
export interface CapabilityPluginInspectionRequest {
  workspaceId: string;
  source: PluginSource;
}

/**
 * `POST /api/v1/capabilities/plugins/install`: install the pieces an inspection checked, from one confirmation.
 * `hookSecrets` holds one signing secret per hook piece, by piece id, and nothing else: GoatCitadel keeps each one in
 * the key store and the install plan holds only a reference to it.
 */
export interface CapabilityPluginInstallRequest {
  workspaceId: string;
  inspectionId: string;
  hookSecrets?: Record<string, string>;
}

/**
 * The answer to a plugin install or uninstall (202). `applied`: the plan finished. `waiting`: it waits, for its approval
 * in the Inbox (`approvalId`) or for a step still under way. `failed`: it stopped, and `summary` says what was added
 * and what to do next. `summary` is the plan's plain summary.
 */
export interface PluginActionOutcome {
  planId: string;
  outcome: "applied" | "waiting" | "failed";
  approvalId?: string;
  summary: string;
}

export const CAPABILITY_PLUGIN_REFUSED_CODE = "PLUGIN_REFUSED" as const;

/**
 * The inspections route's answer when a source can't be fetched or its manifest is refused. `error` is a plain
 * sentence and `details.code` says why: a source refusal (such as `UNTRUSTED_GIT_HOST`, `HOST_NOT_PUBLIC`,
 * `FOLDER_INSTALL_NOT_ALLOWED` or `GIT_FETCH_FAILED`) or a manifest refusal code. A refused manifest's inspection is
 * kept, and `details.inspectionId` reads it back.
 */
export interface CapabilityPluginRefusal {
  error: string;
  code: typeof CAPABILITY_PLUGIN_REFUSED_CODE;
  details: { code: string; inspectionId?: string; field?: string };
}
