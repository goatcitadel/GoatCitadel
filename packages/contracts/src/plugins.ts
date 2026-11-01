import { z } from "zod";
import { HOOK_TRIGGER_VALUES, type HookTrigger } from "./hooks.js";
import { sha256BytesHex } from "./sha256.js";

// ---------------------------------------------------------------------------
// Plugin manifest: `goatcitadel-plugin.json`
//
// A plugin is a bundle of pieces that runs no code. The manifest lists the
// pieces; GoatCitadel checks every one with its owner's normal check before it
// installs anything. A manifest can add pieces and tighten what is already
// there. It cannot loosen a rule, carry a feature flag, change how a hook is
// delivered or steer a chat outside a skill, and `parsePluginManifest` refuses
// each of those by name before the strict schema runs.
// ---------------------------------------------------------------------------

/** The manifest's file name, at the top of a plugin folder. */
export const PLUGIN_MANIFEST_FILENAME = "goatcitadel-plugin.json";

/** What a plugin folder and its manifest may hold. The Gateway enforces the folder limits when it fetches a source. */
export const PLUGIN_LIMITS = {
  maxManifestBytes: 64 * 1024,
  maxPieces: 32,
  maxFiles: 256,
  maxTotalBytes: 8 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
} as const;

/** `built_in` ships with GoatCitadel. Every other source is `unverified`: GoatCitadel checks pieces, not authors. */
export type PluginTrust = "built_in" | "unverified";

export type PluginPieceKind = "skill" | "connector" | "tool_group_off" | "hook" | "prompt_pack";

export type PluginPiece =
  /** `path` is the folder that holds `SKILL.md`, relative to the plugin folder. */
  | { kind: "skill"; id: string; path: string }
  /** A shipped connector template. `asksFirst` defaults to `"changes"`; a connector can never ask for less. */
  | { kind: "connector"; id: string; templateId: string; asksFirst?: "everything" | "changes" }
  /** Holds a tool group off while the plugin is installed. No piece turns a group on. */
  | { kind: "tool_group_off"; id: string; groupId: string }
  /** A webhook that watches one event. It never changes what happens. */
  | { kind: "hook"; id: string; trigger: HookTrigger; url: string; mode?: "observe" }
  /** `path` is a `.md` file, relative to the plugin folder. */
  | { kind: "prompt_pack"; id: string; path: string };

export interface PluginManifest {
  schemaVersion: 1;
  /** Lowercase letters, digits and hyphens, 2 to 48 characters. */
  pluginId: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  /** An `https` address. */
  homepage?: string;
  pieces: readonly PluginPiece[];
}

export type PluginManifestRefusalCode =
  | "MANIFEST_MISSING"
  | "MANIFEST_TOO_LARGE"
  | "MANIFEST_INVALID"
  | "DUPLICATE_PIECE_ID"
  | "PIECE_PATH_INVALID"
  | "UNKNOWN_PIECE_KIND"
  | "FEATURE_FLAGS_NOT_ALLOWED"
  | "CHAT_INSTRUCTIONS_NOT_ALLOWED"
  | "HOOK_MUST_ONLY_OBSERVE"
  | "HOOK_CODE_NOT_ALLOWED"
  | "PRESET_MUST_TIGHTEN";

/**
 * The answer to parsing a manifest. `manifestSha256` is the lowercase hex SHA-256 of the manifest's bytes, exactly as
 * given: nothing, line endings included, is normalized first. `field` names where the problem is, such as
 * `pieces[2].mode`, or the key for a top-level one.
 */
export type PluginManifestParse =
  | { ok: true; manifest: PluginManifest; manifestSha256: string }
  | { ok: false; code: PluginManifestRefusalCode; message: string; field?: string };

/** Where a plugin comes from. A `ref` is a 40-hex commit, or a branch or tag. A folder path is absolute. */
export type PluginSource =
  | { kind: "built_in"; pluginId: string }
  | { kind: "git"; url: string; ref?: string }
  | { kind: "folder"; path: string };

/** What an install is pinned to: a Git commit, or the SHA-256 of the folder's contents. */
export type PluginPin = { kind: "commit"; commit: string } | { kind: "content"; treeSha256: string };

// ---------------------------------------------------------------------------
// The strict schema (rule 8, after the named refusals)
// ---------------------------------------------------------------------------

/** A plugin id in a manifest: 2 to 48 lowercase letters, digits or hyphens, starting with a letter or digit. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/u;
/** A piece id in a plugin manifest. The Skill Hub review checks a plugin skill's id against the same rule. */
export const PLUGIN_PIECE_ID_PATTERN = /^[a-z0-9-]{1,48}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]+$/u;
/** Connector template ids and tool group ids. Dots are allowed so the Gateway can name a group it will not switch off. */
const REFERENCE_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const MAX_PATH_LENGTH = 512;
const MAX_URL_LENGTH = 2048;

/*
 * The characters a manifest's text may not hold (R77), as text holding one could read otherwise than it is. A name or
 * an author holds none of the C0 or C1 controls, the line and paragraph separators (U+2028, U+2029) or the bidi controls
 * (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069). A description may keep tabs and line breaks. Every
 * other format character, such as an emoji's zero-width joiner or a soft hyphen, passes.
 */
const NAME_FORBIDDEN = /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const DESCRIPTION_FORBIDDEN = /(?![\t\n\r])\p{Cc}|[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const CONTROL_CHARACTERS_MESSAGE = "must not hold control characters";
const withoutForbidden = (forbidden: RegExp) => (value: string) => !forbidden.test(value);

const pieceId = z.string().regex(PLUGIN_PIECE_ID_PATTERN, "must be 1 to 48 lowercase letters, digits or hyphens");
const referenceId = z.string().regex(REFERENCE_ID_PATTERN, "must be a plain lowercase id");
const piecePath = z.string().min(1).max(MAX_PATH_LENGTH);
const httpsUrl = z.string().min(1).max(MAX_URL_LENGTH).refine(isHttpsUrl, "must be an https address");

const skillPieceSchema = z.object({ kind: z.literal("skill"), id: pieceId, path: piecePath }).strict();
const connectorPieceSchema = z
  .object({
    kind: z.literal("connector"),
    id: pieceId,
    templateId: referenceId,
    asksFirst: z.enum(["everything", "changes"]).optional(),
  })
  .strict();
const toolGroupOffPieceSchema = z
  .object({ kind: z.literal("tool_group_off"), id: pieceId, groupId: referenceId })
  .strict();
const hookPieceSchema = z
  .object({
    kind: z.literal("hook"),
    id: pieceId,
    // One list of triggers: the hooks contract owns it.
    trigger: z.enum(HOOK_TRIGGER_VALUES, "is not a hook trigger GoatCitadel has"),
    url: httpsUrl,
    mode: z.literal("observe").optional(),
  })
  .strict();
const promptPackPieceSchema = z.object({ kind: z.literal("prompt_pack"), id: pieceId, path: piecePath }).strict();

const pluginPieceSchema = z.discriminatedUnion("kind", [
  skillPieceSchema,
  connectorPieceSchema,
  toolGroupOffPieceSchema,
  hookPieceSchema,
  promptPackPieceSchema,
]);

export const pluginManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    pluginId: z.string().regex(PLUGIN_ID_PATTERN, "must be 2 to 48 lowercase letters, digits or hyphens"),
    // A name only of spaces would leave every "From <name>" refusal and hold reason with nothing to say. The name, the
    // description and the author reach approval text, where a control or bidi character could hide what is approved.
    name: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => value.trim().length > 0, "must not be blank")
      .refine(withoutForbidden(NAME_FORBIDDEN), CONTROL_CHARACTERS_MESSAGE),
    description: z.string().min(1).max(500).refine(withoutForbidden(DESCRIPTION_FORBIDDEN), CONTROL_CHARACTERS_MESSAGE),
    version: z.string().min(1).max(32).regex(VERSION_PATTERN, "may hold only letters, digits and . + -"),
    author: z.string().max(120).refine(withoutForbidden(NAME_FORBIDDEN), CONTROL_CHARACTERS_MESSAGE).optional(),
    homepage: httpsUrl.optional(),
    pieces: z.array(pluginPieceSchema).min(1).max(PLUGIN_LIMITS.maxPieces),
  })
  .strict();

// ---------------------------------------------------------------------------
// Named refusals (rules 1 to 7), checked on the parsed JSON before the schema
// ---------------------------------------------------------------------------

type Refusal = Extract<PluginManifestParse, { ok: false }>;
type JsonObject = Record<string, unknown>;
interface PieceEntry {
  readonly index: number;
  readonly piece: JsonObject;
}
type RefusalRule = (document: JsonObject, pieces: readonly PieceEntry[]) => Refusal | undefined;

const FEATURE_FLAG_KEYS = ["featureFlags", "flags", "runtimePresets"] as const;
const CHAT_INSTRUCTION_KEYS = ["instructions", "systemPrompt", "prompt", "chatInstructions"] as const;
const HOOK_CHANGE_KEYS = ["patch", "intercept", "requiresApproval", "riskLevel"] as const;
const HOOK_CODE_KEYS = ["action", "package", "command", "script"] as const;
const KNOWN_PIECE_KINDS: Readonly<Record<PluginPieceKind, true>> = {
  skill: true,
  connector: true,
  tool_group_off: true,
  hook: true,
  prompt_pack: true,
};

const REFUSAL_RULES: readonly RefusalRule[] = [
  refuseFeatureFlags,
  refuseChatInstructions,
  refuseHookThatChanges,
  refuseHookCode,
  refuseLooseningPreset,
  refuseUnknownKind,
  refuseBadPath,
];

/**
 * Parse the text of a `goatcitadel-plugin.json`. Never throws.
 *
 * Order: size, JSON, the seven named refusals (rule by rule over the whole manifest, so the earlier rule wins when a
 * manifest breaks two), the strict schema, then duplicate piece ids.
 */
export function parsePluginManifest(raw: string): PluginManifestParse {
  if (typeof raw !== "string") {
    return refuse("MANIFEST_INVALID", "The manifest must be text.");
  }
  // Every UTF-16 unit takes at least one byte, so a longer string is too large without encoding it.
  if (raw.length > PLUGIN_LIMITS.maxManifestBytes) return pluginManifestTooLarge();
  const bytes = new TextEncoder().encode(raw);
  if (bytes.byteLength > PLUGIN_LIMITS.maxManifestBytes) return pluginManifestTooLarge();

  let document: unknown;
  try {
    // Editors on Windows can save a leading byte-order mark; JSON.parse refuses it. The hash below still covers it.
    document = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return refuse("MANIFEST_INVALID", "The manifest isn't valid JSON.");
  }
  if (!isJsonObject(document)) {
    return refuse("MANIFEST_INVALID", "The manifest must be a JSON object.");
  }

  const pieces = pieceEntries(document);
  for (const rule of REFUSAL_RULES) {
    const refusal = rule(document, pieces);
    if (refusal) return refusal;
  }

  const parsed = pluginManifestSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue ? issueField(issue) : undefined;
    const detail = issue?.message ?? "Invalid input";
    return refuse(
      "MANIFEST_INVALID",
      field ? `The manifest isn't valid at ${field}: ${detail}.` : `The manifest isn't valid: ${detail}.`,
      field,
    );
  }
  const manifest: PluginManifest = parsed.data;

  const seen = new Set<string>();
  for (const [index, piece] of manifest.pieces.entries()) {
    if (seen.has(piece.id)) {
      return refuse("DUPLICATE_PIECE_ID", `Two pieces share the id "${piece.id}".`, `pieces[${index}].id`);
    }
    seen.add(piece.id);
  }

  return { ok: true, manifest, manifestSha256: sha256BytesHex(bytes) };
}

function refuseFeatureFlags(document: JsonObject, pieces: readonly PieceEntry[]): Refusal | undefined {
  const message = "Plugins can't carry feature flags or runtime presets.";
  const topLevel = FEATURE_FLAG_KEYS.find((key) => has(document, key));
  if (topLevel) return refuse("FEATURE_FLAGS_NOT_ALLOWED", message, topLevel);
  for (const { index, piece } of pieces) {
    const key = FEATURE_FLAG_KEYS.find((candidate) => has(piece, candidate));
    if (key) return refuse("FEATURE_FLAGS_NOT_ALLOWED", message, `pieces[${index}].${key}`);
    if (piece.kind === "runtime_preset") return refuse("FEATURE_FLAGS_NOT_ALLOWED", message, `pieces[${index}].kind`);
  }
  return undefined;
}

function refuseChatInstructions(document: JsonObject, pieces: readonly PieceEntry[]): Refusal | undefined {
  const message = "Plugins can't steer chats outside a skill.";
  const topLevel = CHAT_INSTRUCTION_KEYS.find((key) => has(document, key));
  if (topLevel) return refuse("CHAT_INSTRUCTIONS_NOT_ALLOWED", message, topLevel);
  for (const { index, piece } of pieces) {
    const key = CHAT_INSTRUCTION_KEYS.find((candidate) => has(piece, candidate));
    if (key) return refuse("CHAT_INSTRUCTIONS_NOT_ALLOWED", message, `pieces[${index}].${key}`);
  }
  return undefined;
}

function refuseHookThatChanges(_document: JsonObject, pieces: readonly PieceEntry[]): Refusal | undefined {
  const message = "A plugin's hooks can only watch. They can't change what happens.";
  for (const { index, piece } of pieces) {
    if (piece.kind !== "hook") continue;
    if (has(piece, "mode") && piece.mode !== "observe") {
      return refuse("HOOK_MUST_ONLY_OBSERVE", message, `pieces[${index}].mode`);
    }
    const key = HOOK_CHANGE_KEYS.find((candidate) => has(piece, candidate));
    if (key) return refuse("HOOK_MUST_ONLY_OBSERVE", message, `pieces[${index}].${key}`);
  }
  return undefined;
}

function refuseHookCode(_document: JsonObject, pieces: readonly PieceEntry[]): Refusal | undefined {
  for (const { index, piece } of pieces) {
    if (piece.kind !== "hook") continue;
    const key = HOOK_CODE_KEYS.find((candidate) => has(piece, candidate));
    if (key) return refuse("HOOK_CODE_NOT_ALLOWED", "A plugin's hooks can't run code.", `pieces[${index}].${key}`);
  }
  return undefined;
}

function refuseLooseningPreset(_document: JsonObject, pieces: readonly PieceEntry[]): Refusal | undefined {
  const message = "A plugin can only add pieces and tighten rules. It can't turn a tool group on or ask for less.";
  for (const { index, piece } of pieces) {
    if (piece.kind === "connector" && piece.asksFirst === "nothing") {
      return refuse("PRESET_MUST_TIGHTEN", message, `pieces[${index}].asksFirst`);
    }
    if (piece.kind === "tool_group_on") return refuse("PRESET_MUST_TIGHTEN", message, `pieces[${index}].kind`);
  }
  return undefined;
}

function refuseUnknownKind(_document: JsonObject, pieces: readonly PieceEntry[]): Refusal | undefined {
  for (const { index, piece } of pieces) {
    if (typeof piece.kind === "string" && !has(KNOWN_PIECE_KINDS, piece.kind)) {
      return refuse(
        "UNKNOWN_PIECE_KIND",
        "A plugin can hold skills, connectors, tool group holds, hooks and prompt packs.",
        `pieces[${index}].kind`,
      );
    }
  }
  return undefined;
}

function refuseBadPath(_document: JsonObject, pieces: readonly PieceEntry[]): Refusal | undefined {
  for (const { index, piece } of pieces) {
    if ((piece.kind !== "skill" && piece.kind !== "prompt_pack") || typeof piece.path !== "string") continue;
    const problem = pathProblem(piece.kind, piece.path);
    if (problem) return refuse("PIECE_PATH_INVALID", `A piece's path ${problem}.`, `pieces[${index}].path`);
  }
  return undefined;
}

/** Why a piece path can't be used, in words that finish "A piece's path ...", or nothing when it can. */
function pathProblem(kind: "skill" | "prompt_pack", value: string): string | undefined {
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return "must be relative to the plugin folder";
  if (value.includes("\\")) return "must use forward slashes";
  if (value.includes("..")) return "must not contain '..'";
  if (value.includes("\u0000")) return "must not contain a NUL character";
  if (value.normalize("NFC") !== value) return "must be NFC-normalized";
  if (!isPortablePluginPath(value)) return PATH_NOT_PORTABLE;
  if (kind === "prompt_pack" && !value.endsWith(".md")) return "must name a .md file";
  return undefined;
}

const PATH_NOT_PORTABLE =
  'must be a plain path every computer can hold: no empty or "." parts, no colon, no name that ends in a dot or a ' +
  "space, no .git folder and no device name such as CON";
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAX_PORTABLE_PATH_LENGTH = 4_096;
const MAX_PORTABLE_SEGMENT_LENGTH = 255;

/**
 * Whether a path inside a plugin, relative and with `/` separators, is written the same on every disk GoatCitadel runs
 * on. The manifest's piece paths and every file GoatCitadel copies from a plugin are held to it. It refuses a path that
 * is empty, absolute or over 4,096 characters, isn't NFKC, holds a `\`, a control character or a replacement character,
 * or has a part that is empty, `.` or `..`, over 255 characters, holds a `:`, ends in a dot or a space, is `.git` in any
 * case, or is a Windows device name such as `CON` or `com1.txt`.
 */
export function isPortablePluginPath(relativePath: string): boolean {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.length > MAX_PORTABLE_PATH_LENGTH ||
    relativePath !== relativePath.normalize("NFKC") ||
    relativePath.includes("\\") ||
    relativePath.includes("\ufffd")
  ) {
    return false;
  }
  // A leading `/` leaves an empty first part, and a drive (`C:`) or a stream (`a:b`) holds a colon, so neither needs a
  // rule of its own.
  return relativePath.split("/").every(isPortableSegment);
}

function isPortableSegment(segment: string): boolean {
  return !(
    !segment ||
    segment === "." ||
    segment === ".." ||
    segment.length > MAX_PORTABLE_SEGMENT_LENGTH ||
    containsControlCharacter(segment) ||
    segment.includes(":") ||
    /[. ]$/u.test(segment) ||
    segment.toLowerCase() === ".git" ||
    WINDOWS_DEVICE_NAME.test(segment)
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refuse(code: PluginManifestRefusalCode, message: string, field?: string): Refusal {
  return field === undefined ? { ok: false, code, message } : { ok: false, code, message, field };
}

/**
 * The refusal for a manifest over `PLUGIN_LIMITS.maxManifestBytes`. Exported so a reader that measures the file
 * itself, such as the SDK's folder loader, gives the same words as `parsePluginManifest`.
 */
export function pluginManifestTooLarge(): Refusal {
  return refuse(
    "MANIFEST_TOO_LARGE",
    `The manifest is over ${PLUGIN_LIMITS.maxManifestBytes / 1024} KiB, which is the most it can be.`,
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(target: object, key: string): boolean {
  return Object.hasOwn(target, key);
}

/** The pieces that are objects, with their positions. Anything else is left to the schema. */
function pieceEntries(document: JsonObject): PieceEntry[] {
  const pieces = document.pieces;
  if (!Array.isArray(pieces)) return [];
  const entries: PieceEntry[] = [];
  for (const [index, piece] of pieces.entries()) {
    if (isJsonObject(piece)) entries.push({ index, piece });
  }
  return entries;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function issueField(issue: z.core.$ZodIssue): string | undefined {
  const path = [...issue.path];
  if (issue.code === "unrecognized_keys" && issue.keys[0] !== undefined) path.push(issue.keys[0]);
  let field = "";
  for (const segment of path) {
    if (typeof segment === "number") field += `[${segment}]`;
    else field += field ? `.${String(segment)}` : String(segment);
  }
  return field || undefined;
}
