import fs from "node:fs/promises";
import {
  ConflictError,
  HOOK_TRIGGER_LABELS,
  HOOK_TRIGGER_VALUES,
  TOOL_GROUPS,
  ValidationError,
  redactStructuredSecrets,
  type CapabilityPluginInspection,
  type CapabilityPluginPieceCheck,
  type CapabilityPluginPieceView,
  type McpServerTemplateRecord,
  type PluginManifest,
  type PluginPiece,
  type PluginPin,
  type PluginSource,
  type PluginTrust,
} from "@goatcitadel/contracts";
import type { StoredPlugin } from "./capability-plugin-store.js";
import { connectorTemplateHosts, findInstallableConnectorTemplate } from "./connector-install-change-plan-adapter.js";
import { HostLookupError, assertHostResolvesPublic } from "./hardened-git.js";
import { parseHookWebhookUrl } from "./hooks-service.js";
import { mcpServerLabelKey } from "./mcp-money-moving.js";
import { readPluginManifestFile } from "./plugin-manifest-file.js";
import { PluginSnapshotPathError } from "./plugin-snapshot-store.js";
import type { FetchedPluginSource } from "./plugin-source-service.js";
import { preparePromptPackImport } from "./prompt-pack/prepare-import.js";
import type { SkillHubPluginSkillInput } from "./skill-hub-plugin-skill-source.js";
import type { SkillHubReviewResult, SkillHubSourceReviewInput } from "./skill-hub-review-service.js";

// Inspecting a plugin: fetch its source into a snapshot, read its manifest, and check every piece with the check its
// own owner uses (the Skill Hub's review for a skill, the connector install's template rule, the tool switch's list,
// the hooks address rules and the prompt-pack parser). Nothing is installed: the only things kept are the snapshot,
// the Skill Hub's record of each skill's review, and the inspection itself.

/** How long an inspection can be installed from, and read back. */
export const INSPECTION_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const ASKS_FIRST = {
  skill: "Follows your tool rules. Added after GoatCitadel's checks, then switched on.",
  connectorChanges: "Reading runs freely; creating or changing something asks first in Chat.",
  connectorEverything: "Everything it does asks first in Chat.",
  toolGroupOff: (groupLabel: string) => `Turns ${groupLabel} off in every chat while installed.`,
  hook: (host: string, triggerLabel: string) => `Sends event details, never message text, to ${host}: ${triggerLabel}.`,
  promptPack: (tests: number) =>
    `Adds ${tests} ${tests === 1 ? "test" : "tests"} to Library › Prompt packs. Nothing runs until you press Run.`,
  /** A prompt pack whose file couldn't be read: how many tests it holds isn't known. */
  unreadPromptPack: "Adds tests to Library › Prompt packs. Nothing runs until you press Run.",
} as const;

const SKILL_BLOCKED_MESSAGE = "This skill didn't pass GoatCitadel's checks.";
const SKILL_UNREADABLE_MESSAGE = "GoatCitadel can't check this skill.";
const CHECK_KEY_REUSED_MESSAGE = "This check's key was already used for something else. Check the plugin again.";
const GROUP_NOT_SWITCHABLE_MESSAGE = "That group can't be switched off.";
const UNKNOWN_GROUP_MESSAGE = "GoatCitadel has no tool group with that id.";
const HOST_NOT_PUBLIC_MESSAGE = "That address isn't a public host.";
const HOST_NOT_FOUND_MESSAGE = "That address's host can't be found.";
const UNKNOWN_TRIGGER_MESSAGE = "GoatCitadel has no hook event with that name.";
const PROMPT_PACK_MISSING_MESSAGE = "The plugin doesn't have that prompt pack file.";
const PROMPT_PACK_NOT_TEXT_MESSAGE = "The prompt pack file isn't UTF-8 text.";
const PROMPT_PACK_INVALID_MESSAGE = "The prompt pack file isn't a prompt pack GoatCitadel can read.";
const PROMPT_PACK_TAKEN_MESSAGE = "Another prompt pack already uses the id this one needs.";
/** The review's own refusal codes are upper snake case, as the Skills tab's check reads them. */
const REVIEW_CODE = /^[A-Z][A-Z0-9_]*$/u;
/** Groups a plugin can never hold off. `mcp.invoke` is Core's own connector tool, named here so it can't slip past. */
const NEVER_SWITCHED_OFF: ReadonlySet<string> = new Set(["core", "mcp.invoke"]);
const READY: CapabilityPluginPieceCheck = { status: "ready" };
const ALREADY_THERE: CapabilityPluginPieceCheck = { status: "already_there" };

/** The request's logger. A refusal's cause goes here, and never into the answer. */
export interface CapabilityPluginInspectionLog {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface CapabilityPluginInspectInput {
  workspaceId: string;
  source: PluginSource;
  actorId: string;
  /** The request's own key. Each skill's review is keyed `<key>:skill:<pieceId>`. */
  idempotencyKey: string;
  log: CapabilityPluginInspectionLog;
}

/** One reader per owner an inspection asks, each through its existing owner. None of them installs anything. */
export interface CapabilityPluginInspectionSources {
  /** `fetchPluginSource`, wired to the snapshot store. It throws `PluginSourceError` for a source it refuses. */
  fetchSource(source: PluginSource): Promise<FetchedPluginSource>;
  /** `PluginSnapshotStore.resolve`: a path inside a snapshot, or a plain `PluginSnapshotPathError`. */
  resolveSnapshotPath(treeSha256: string, relativePath: string): string;
  /** The Skill Hub's source review, the one the Skills tab's check runs. */
  reviewSkill(input: SkillHubSourceReviewInput): Promise<SkillHubReviewResult>;
  /** The shipped connector catalog. */
  connectorTemplates(): readonly McpServerTemplateRecord[];
  /** The labels of the connectors already saved. */
  listSavedConnectorLabels(): Promise<readonly string[]>;
  /** The tool groups the operator has switched off. */
  listSwitchedOffToolGroups(): Promise<readonly string[]>;
  /** Whether a prompt pack with this id is saved. */
  promptPackExists(packId: string): Promise<boolean>;
  /** Every address a host name resolves to. */
  lookupHost(hostname: string): Promise<Array<{ address: string }>>;
  /** The plugin store's record of an installed plugin. */
  findInstalled(pluginId: string): Promise<StoredPlugin | undefined>;
  /** Keeps the inspection with the snapshot it read. */
  saveInspection(inspection: CapabilityPluginInspection, snapshotTreeSha256: string): Promise<void>;
  now(): Date;
  newInspectionId(): string;
}

/** The manifest was refused. Its inspection is kept, with `refusal`, so it can be read back. */
export class CapabilityPluginManifestRefusedError extends Error {
  public constructor(
    public readonly inspection: CapabilityPluginInspection,
    /** Where in the manifest the problem is, such as `pieces[2].mode`. */
    public readonly field?: string,
  ) {
    super(inspection.refusal?.message ?? "The plugin's manifest was refused.");
    this.name = "CapabilityPluginManifestRefusedError";
  }
}

/** What every piece check of one inspection shares. The saved connectors and switches are read once, when first asked. */
interface InspectionContext {
  readonly input: CapabilityPluginInspectInput;
  readonly manifest: PluginManifest;
  readonly treeSha256: string;
  readonly trust: PluginTrust;
  readonly pin: PluginPin;
  readonly savedConnectorLabels: () => Promise<ReadonlySet<string>>;
  readonly switchedOffGroups: () => Promise<ReadonlySet<string>>;
}

export class CapabilityPluginInspectionService {
  public constructor(private readonly sources: CapabilityPluginInspectionSources) {}

  /**
   * Inspects a plugin source. Throws the source's own `PluginSourceError` when it can't be fetched, a
   * `CapabilityPluginManifestRefusedError` (with its inspection kept) when its manifest is refused, and a 409 when the
   * plugin is already installed. Otherwise every piece is checked in manifest order and the inspection is kept.
   */
  public async inspect(input: CapabilityPluginInspectInput): Promise<CapabilityPluginInspection> {
    const fetched = await this.sources.fetchSource(input.source);
    const parsed = await readPluginManifestFile(fetched.snapshot.dir);
    const inspectedAt = this.sources.now();
    const frame = {
      inspectionId: this.sources.newInspectionId(),
      workspaceId: input.workspaceId,
      trust: fetched.trust,
      sourceKind: input.source.kind,
      sourceDisplay: fetched.sourceDisplay,
      pin: fetched.pin,
      ignored: [],
      inspectedAt: inspectedAt.toISOString(),
      expiresAt: new Date(inspectedAt.getTime() + INSPECTION_LIFETIME_MS).toISOString(),
    };
    if (!parsed.ok) {
      const refused: CapabilityPluginInspection = {
        ...frame,
        pluginId: "",
        name: "",
        description: "",
        version: "",
        manifestSha256: "",
        pieces: [],
        refusal: { code: parsed.code, message: parsed.message },
        installable: false,
      };
      await this.sources.saveInspection(refused, fetched.snapshot.treeSha256);
      throw new CapabilityPluginManifestRefusedError(refused, parsed.field);
    }
    const { manifest, manifestSha256 } = parsed;
    const installed = await this.sources.findInstalled(manifest.pluginId);
    if (installed) {
      throw new ConflictError({
        code: "ALREADY_EXISTS",
        message: `${installed.name} is already installed.`,
        details: { pluginId: manifest.pluginId },
      });
    }

    const context: InspectionContext = {
      input,
      manifest,
      treeSha256: fetched.snapshot.treeSha256,
      trust: fetched.trust,
      pin: fetched.pin,
      savedConnectorLabels: once(
        async () => new Set((await this.sources.listSavedConnectorLabels()).map((label) => mcpServerLabelKey(label))),
      ),
      switchedOffGroups: once(async () => new Set(await this.sources.listSwitchedOffToolGroups())),
    };
    const pieces: CapabilityPluginPieceView[] = [];
    // One at a time, in manifest order: a skill's review writes its own record, and the answer keeps that order.
    for (const piece of manifest.pieces) pieces.push(await this.checkPiece(piece, context));

    const inspection: CapabilityPluginInspection = {
      ...frame,
      pluginId: manifest.pluginId,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      ...(manifest.author ? { author: manifest.author } : {}),
      manifestSha256,
      pieces,
      installable: pieces.every((item) => item.check.status !== "blocked"),
    };
    await this.sources.saveInspection(inspection, fetched.snapshot.treeSha256);
    return inspection;
  }

  private checkPiece(piece: PluginPiece, context: InspectionContext): Promise<CapabilityPluginPieceView> {
    switch (piece.kind) {
      case "skill":
        return this.checkSkill(piece, context);
      case "connector":
        return this.checkConnector(piece, context);
      case "tool_group_off":
        return checkToolGroup(piece, context);
      case "hook":
        return this.checkHook(piece);
      case "prompt_pack":
        return this.checkPromptPack(piece, context);
    }
  }

  /** The Skill Hub's own review of the skill's folder in the snapshot: ready, or blocked with its first code. */
  private async checkSkill(
    piece: Extract<PluginPiece, { kind: "skill" }>,
    context: InspectionContext,
  ): Promise<CapabilityPluginPieceView> {
    const { input } = context;
    const pluginSkill: SkillHubPluginSkillInput = {
      snapshotTreeSha256: context.treeSha256,
      path: piece.path,
      pluginId: context.manifest.pluginId,
      pieceId: piece.id,
      trust: context.trust,
      pinLabel: context.pin.kind === "commit" ? `commit:${context.pin.commit}` : `content:${context.pin.treeSha256}`,
    };
    const view = { pieceId: piece.id, kind: "skill" as const, asksFirst: ASKS_FIRST.skill };
    let reviewed: SkillHubReviewResult;
    try {
      reviewed = await this.sources.reviewSkill({
        workspaceId: input.workspaceId,
        pluginSkill,
        idempotencyKey: `${input.idempotencyKey}:skill:${piece.id}`,
        actorId: input.actorId,
      });
    } catch (error) {
      return { ...view, label: piece.id, check: skillRefusal(error, piece.id, input.log) };
    }
    const skillName = reviewed.snapshot.provenance.skillName;
    const blocker = reviewed.snapshot.blockerCodes[0];
    return {
      ...view,
      label: typeof skillName === "string" && skillName ? skillName : piece.id,
      check: blocker ? blocked(blocker, SKILL_BLOCKED_MESSAGE) : READY,
      skillSnapshotId: reviewed.snapshot.snapshotId,
    };
  }

  /** The connector install's own template rule; a connector already saved under the template's label is kept. */
  private async checkConnector(
    piece: Extract<PluginPiece, { kind: "connector" }>,
    context: InspectionContext,
  ): Promise<CapabilityPluginPieceView> {
    const templates = this.sources.connectorTemplates();
    const view = {
      pieceId: piece.id,
      kind: "connector" as const,
      asksFirst: piece.asksFirst === "everything" ? ASKS_FIRST.connectorEverything : ASKS_FIRST.connectorChanges,
    };
    const found = findInstallableConnectorTemplate(templates, piece.templateId);
    if (!found.ok) {
      const label = templates.find((item) => item.templateId === piece.templateId)?.label ?? piece.templateId;
      return { ...view, label, check: blocked(found.field, found.message) };
    }
    const { template } = found;
    if ((await context.savedConnectorLabels()).has(mcpServerLabelKey(template.label))) {
      return { ...view, label: template.label, check: ALREADY_THERE };
    }
    const hosts = connectorTemplateHosts(template);
    return { ...view, label: template.label, check: READY, ...(hosts.length > 0 ? { hosts } : {}) };
  }

  /**
   * The hooks owner's address rule (a valid https address) and a public host: the literal, and every address a name
   * resolves to. Installing adds the host to the hooks allowlist, so that list isn't read here.
   */
  private async checkHook(piece: Extract<PluginPiece, { kind: "hook" }>): Promise<CapabilityPluginPieceView> {
    const triggerLabel = HOOK_TRIGGER_LABELS[piece.trigger] ?? piece.trigger;
    let url: URL;
    try {
      url = parseHookWebhookUrl(piece.url);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return {
        pieceId: piece.id,
        kind: "hook",
        label: triggerLabel,
        asksFirst: ASKS_FIRST.hook("its address", triggerLabel),
        check: blocked("HOOK_URL_INVALID", error.message),
        needsSecret: true,
      };
    }
    const view = {
      pieceId: piece.id,
      kind: "hook" as const,
      label: triggerLabel,
      asksFirst: ASKS_FIRST.hook(url.host, triggerLabel),
      hosts: [url.hostname],
      needsSecret: true,
    };
    if (!HOOK_TRIGGER_VALUES.includes(piece.trigger)) {
      return { ...view, check: blocked("UNKNOWN_HOOK_TRIGGER", UNKNOWN_TRIGGER_MESSAGE) };
    }
    try {
      await assertHostResolvesPublic(url, (hostname) => this.sources.lookupHost(hostname));
    } catch (error) {
      return error instanceof HostLookupError
        ? { ...view, check: blocked("HOST_NOT_FOUND", HOST_NOT_FOUND_MESSAGE) }
        : { ...view, check: blocked("HOST_NOT_PUBLIC", HOST_NOT_PUBLIC_MESSAGE) };
    }
    return { ...view, check: READY };
  }

  /** The prompt-pack parser on the file, as a dry run, and a free `plugin-<pluginId>-<pieceId>` id. */
  private async checkPromptPack(
    piece: Extract<PluginPiece, { kind: "prompt_pack" }>,
    context: InspectionContext,
  ): Promise<CapabilityPluginPieceView> {
    const view = { pieceId: piece.id, kind: "prompt_pack" as const };
    const unread = (check: CapabilityPluginPieceCheck): CapabilityPluginPieceView => ({
      ...view,
      label: piece.id,
      asksFirst: ASKS_FIRST.unreadPromptPack,
      check,
    });
    let file: string;
    try {
      file = this.sources.resolveSnapshotPath(context.treeSha256, piece.path);
    } catch (error) {
      if (!(error instanceof PluginSnapshotPathError)) throw error;
      return unread(blocked("PIECE_PATH_INVALID", error.message));
    }
    const content = await readSnapshotText(file);
    if (typeof content !== "string") return unread(content);

    const packId = `plugin-${context.manifest.pluginId}-${piece.id}`;
    let prepared: ReturnType<typeof preparePromptPackImport>;
    try {
      // The label an install saves it under, so the name shown here is the name it gets.
      prepared = preparePromptPackImport({ content, packId, sourceLabel: `Plugin ${context.manifest.name}` });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : PROMPT_PACK_INVALID_MESSAGE;
      return unread(blocked("PROMPT_PACK_INVALID", message));
    }
    const tests = prepared.write.tests.length;
    const taken = await this.sources.promptPackExists(packId);
    return {
      ...view,
      label: prepared.write.name,
      asksFirst: ASKS_FIRST.promptPack(tests),
      check: taken ? blocked("PROMPT_PACK_ID_TAKEN", PROMPT_PACK_TAKEN_MESSAGE) : READY,
    };
  }
}

/** A switchable group from the Tools tab's own list; Core and `mcp.invoke` never. One already off is kept off. */
async function checkToolGroup(
  piece: Extract<PluginPiece, { kind: "tool_group_off" }>,
  context: InspectionContext,
): Promise<CapabilityPluginPieceView> {
  const group = TOOL_GROUPS.find((item) => item.id === piece.groupId);
  const label = group?.label ?? piece.groupId;
  const view = { pieceId: piece.id, kind: "tool_group_off" as const, label, asksFirst: ASKS_FIRST.toolGroupOff(label) };
  if (NEVER_SWITCHED_OFF.has(piece.groupId) || (group && !group.switchable)) {
    return { ...view, check: blocked("GROUP_NOT_SWITCHABLE", GROUP_NOT_SWITCHABLE_MESSAGE) };
  }
  if (!group) return { ...view, check: blocked("UNKNOWN_TOOL_GROUP", UNKNOWN_GROUP_MESSAGE) };
  return { ...view, check: (await context.switchedOffGroups()).has(group.id) ? ALREADY_THERE : READY };
}

/**
 * The review's refusal of a plugin's skill, as a blocked piece. Its code is kept when it is one of the review's own
 * codes; the review's words, which name the Skill Hub, are not. A refusal on `pluginSkill` is already plain and passes
 * through, and its cause (which can name folders) goes only to the server log. A reused key is a plain 409. Anything
 * else is a fault and passes through.
 */
function skillRefusal(error: unknown, pieceId: string, log: CapabilityPluginInspectionLog): CapabilityPluginPieceCheck {
  if (error instanceof ValidationError) {
    const field = error.details?.field;
    if (field === "pluginSkill") {
      logCause(error, pieceId, log);
      return blocked("PLUGIN_SKILL_UNAVAILABLE", error.message);
    }
    if (field === "sourceRef") return blocked("SOURCE_REFUSED", SKILL_UNREADABLE_MESSAGE);
    if (typeof field === "string" && REVIEW_CODE.test(field)) return blocked(field, SKILL_BLOCKED_MESSAGE);
  }
  if (error instanceof ConflictError)
    throw new ConflictError({ code: "STATE_CONFLICT", message: CHECK_KEY_REUSED_MESSAGE });
  throw error;
}

function logCause(error: Error, pieceId: string, log: CapabilityPluginInspectionLog): void {
  const cause = (error as { cause?: unknown }).cause;
  if (cause === undefined) return;
  const diagnostic =
    cause instanceof Error ? { name: cause.name, message: cause.message, stack: cause.stack } : { value: cause };
  log.warn({ pieceId, err: redactStructuredSecrets(diagnostic).value }, "a plugin's skill couldn't be reviewed");
}

/** A file in the snapshot as text, or the blocked check that says why it can't be read. */
async function readSnapshotText(file: string): Promise<string | CapabilityPluginPieceCheck> {
  let bytes: Buffer;
  try {
    // The snapshot holds only plain files within the plugin limits, so one read is bounded.
    if (!(await fs.lstat(file)).isFile()) return blocked("PROMPT_PACK_MISSING", PROMPT_PACK_MISSING_MESSAGE);
    bytes = await fs.readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return blocked("PROMPT_PACK_MISSING", PROMPT_PACK_MISSING_MESSAGE);
    throw error;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return blocked("PROMPT_PACK_NOT_TEXT", PROMPT_PACK_NOT_TEXT_MESSAGE);
  }
}

function blocked(code: string, message: string): CapabilityPluginPieceCheck {
  return { status: "blocked", code, message };
}

/** Runs `read` at most once, when first asked, and hands every caller the same answer. */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= read());
}
