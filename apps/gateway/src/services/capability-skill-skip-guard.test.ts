import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { OPERATOR_SKILL_SKIP_NOTES } from "./capability-skill-actions-service.js";

/**
 * The operator's skip for a skill switch or a skill install step resolves the skill's own `skill.lifecycle` approval, or
 * the install step's `skill_hub.lifecycle` approval, as the operator, with a recorded note, and only the Capabilities
 * skill actions may do that (HX-402: the approval effect stays the only executor). Any other production file that
 * writes one of the skip notes, or that both asks for a skill or Skill Hub approval and resolves one, could approve on
 * the operator's behalf, so this guard fails on it. So does any file but the Capabilities skill route that calls the
 * actions, and any file but their composition that builds them. The old skills and Skill Hub routes, Chat's skill
 * commands, `change.request` and tool calls never skip.
 */
const SKIP_SERVICE = "apps/gateway/src/services/capability-skill-actions-service.ts";
const NOTE_TOKENS = ["OPERATOR_SKILL_SKIP_NOTES", ...Object.values(OPERATOR_SKILL_SKIP_NOTES)];
/**
 * The calls that ask the skill state owner for a `skill.lifecycle` approval, and the one that asks Skill Hub's approval
 * owner for a `skill_hub.lifecycle` approval (by its composed name, not the generic `createApproval`).
 */
const REQUEST_METHODS = new Set([
  "setSkillState",
  "bulkSetSkillState",
  "requestSkillStateApproval",
  "requestSkillStateBulkApproval",
  "requestActivationPolicyApproval",
  "createSkillHubApproval",
]);
const RESOLVE_METHOD = "resolveApproval";
const REQUEST_CALL = new RegExp(`\\.(?:${[...REQUEST_METHODS].join("|")})\\(`, "u");
const RESOLVE_CALL = new RegExp(`\\.${RESOLVE_METHOD}\\(`, "u");
/**
 * Files that hold both owners side by side without chaining them. They may name both, but no single function in them
 * may both ask for a skill approval and resolve one.
 */
const OWNER_FACADES = new Set([
  // GatewayService's setSkillState and resolveApproval, each delegating to its own owner for the routes.
  "apps/gateway/src/services/gateway-service.ts",
  // Hands the two owners to the Capabilities switch, one reader each.
  "apps/gateway/src/services/capability-skills-composition.ts",
]);
/** The one route that may call the composed switch, and the one composition that may build it. */
const SWITCH_ROUTE = "apps/gateway/src/routes/capability-skills.ts";
const SWITCH_COMPOSITION = "apps/gateway/src/services/capability-skills-composition.ts";
/**
 * A call of the composed switch or install steps (or the source check that starts them), or a read of them off the
 * composed services (the route reads them, then calls them).
 */
const SWITCH_CALL = /\bactions\??\.(?:setState|checkSource|requestStep)\(|\bcapabilitySkills\??\.actions\b/u;
const SWITCH_CONSTRUCTION = /\bnew\s+CapabilitySkillActionsService\b/u;
/**
 * A plugin's uninstall revokes its skills through one bound function the Skills composition makes over the switch's
 * own `revokeForPluginUninstall`. Only that composition may name the method, and only the composition that wires the
 * Skills and Plugins tabs together may take the bound function, so the uninstall plan only ever gets a plain function.
 */
const PLUGIN_REVOKE_METHOD = /\brevokeForPluginUninstall\b/u;
const PLUGIN_REVOKE_FUNCTION = /\brevokeSkillForPluginUninstall\b/u;
const PLUGIN_REVOKE_CALLER = "apps/gateway/src/services/capability-skills-plugins-composition.ts";
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "out", "artifacts"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

interface SourceFile {
  relativePath: string;
  content: string;
}

describe("Capabilities skill switch skip guard", () => {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const readInventory = (): SourceFile[] =>
    ["apps", "packages"].flatMap((top) =>
      listProductionSources(resolve(repoRoot, top)).map((filePath) => ({
        relativePath: relative(repoRoot, filePath).replaceAll("\\", "/"),
        content: readFileSync(filePath, "utf8"),
      })),
    );

  it("finds the skip notes only in the Capabilities skill switch", () => {
    const inventory = readInventory();
    const service = inventory.find((file) => file.relativePath === SKIP_SERVICE);
    // The walk really reached the switch, and the switch really writes every note.
    for (const token of NOTE_TOKENS) expect(service?.content, token).toContain(token);
    expect(() => assertSkipNotesOnlyInSwitch(inventory)).not.toThrow();
  });

  it("lets only the Capabilities skill switch ask for a skill approval and resolve it", () => {
    const inventory = readInventory();
    // The switch and both facades really name both calls, so each rule below is exercised.
    for (const path of [SKIP_SERVICE, ...OWNER_FACADES]) {
      const file = inventory.find((item) => item.relativePath === path);
      expect(file?.content, path).toMatch(REQUEST_CALL);
      expect(file?.content, path).toMatch(RESOLVE_CALL);
    }
    // The install steps ask Skill Hub's approval owner through the composition, so the Hub rule is exercised too.
    for (const path of [SKIP_SERVICE, SWITCH_COMPOSITION]) {
      expect(inventory.find((item) => item.relativePath === path)?.content, path).toMatch(
        /\.createSkillHubApproval\(/u,
      );
    }
    expect(() => assertOnlySwitchResolvesItsRequest(inventory)).not.toThrow();
  });

  it("lets only the Capabilities skill route call the switch, and only its composition build it", () => {
    const inventory = readInventory();
    // The walk really reached the route and the composition, and each really does its one job.
    expect(inventory.find((file) => file.relativePath === SWITCH_ROUTE)?.content).toMatch(SWITCH_CALL);
    expect(inventory.find((file) => file.relativePath === SWITCH_COMPOSITION)?.content).toMatch(SWITCH_CONSTRUCTION);
    expect(() => assertOnlyRouteCallsSwitch(inventory)).not.toThrow();
    expect(() => assertOnlyCompositionBuildsSwitch(inventory)).not.toThrow();
  });

  it("lets a plugin's uninstall revoke its skills only through the one bound function, from the one composition", () => {
    const inventory = readInventory();
    const contentOf = (path: string) => inventory.find((file) => file.relativePath === path)?.content;
    // The walk really reached each file, and each really does its one job.
    expect(contentOf(SKIP_SERVICE)).toMatch(/\bpublic async revokeForPluginUninstall\(/u);
    expect(contentOf(SWITCH_COMPOSITION)).toMatch(/\.revokeForPluginUninstall\(/u);
    expect(contentOf(SWITCH_COMPOSITION)).toMatch(PLUGIN_REVOKE_FUNCTION);
    expect(contentOf(PLUGIN_REVOKE_CALLER)).toMatch(/\.revokeSkillForPluginUninstall\(/u);
    expect(() => assertOnlyCompositionRevokesForPlugins(inventory)).not.toThrow();
  });

  it("names the offending file when anything else revokes a plugin's skill", () => {
    expect(() =>
      assertOnlyCompositionRevokesForPlugins([
        { relativePath: SKIP_SERVICE, content: "public async revokeForPluginUninstall(input) {}" },
        {
          relativePath: SWITCH_COMPOSITION,
          content: "revokeSkillForPluginUninstall: (input) => actions.revokeForPluginUninstall(input),",
        },
        {
          relativePath: PLUGIN_REVOKE_CALLER,
          content: "revokeSkill: (input) => skills.revokeSkillForPluginUninstall(input),",
        },
        // The uninstall plan reaching the switch itself, or the bound function, would choose when to revoke.
        {
          relativePath: "apps/gateway/src/services/plugin-uninstall-change-plan-adapter.ts",
          content: "await this.actions.revokeForPluginUninstall({ snapshotId });",
        },
        {
          relativePath: "apps/gateway/src/services/gateway-service.ts",
          content: "const { revokeSkillForPluginUninstall } = composed.capabilitySkills;",
        },
      ]),
    ).toThrow(
      "A plugin's skill is revoked outside its one composition: apps/gateway/src/services/plugin-uninstall-change-plan-adapter.ts, apps/gateway/src/services/gateway-service.ts",
    );
  });

  it("names the offending file when anything else calls the switch", () => {
    expect(() =>
      assertOnlyRouteCallsSwitch([
        { relativePath: SWITCH_ROUTE, content: "const owner = fastify.services.capabilitySkills?.actions;" },
        // Chat reusing the switch, so its skill commands would skip too.
        {
          relativePath: "apps/gateway/src/services/chat-command-service.ts",
          content: "await this.services.capabilitySkills.actions.setState({ skillId, state, actorId });",
        },
        {
          relativePath: "apps/gateway/src/routes/skills.ts",
          content: "const { actions } = composed;\nawait actions.setState(body);",
        },
        // The old Skill Hub routes reusing the install steps, so their operations would skip too.
        {
          relativePath: "apps/gateway/src/services/skills-route-service.ts",
          content: "return await this.actions.requestStep({ ...input, actorId });",
        },
        { relativePath: "apps/gateway/src/services/chat-skill-hub.ts", content: "await actions?.checkSource(input);" },
        // Something else's own setState is not the switch.
        { relativePath: "apps/mission-control-next/src/cockpit/store.ts", content: "store.setState({ open: true });" },
      ]),
    ).toThrow(
      "The Capabilities skill switch is called outside its route: apps/gateway/src/services/chat-command-service.ts, apps/gateway/src/routes/skills.ts, apps/gateway/src/services/skills-route-service.ts, apps/gateway/src/services/chat-skill-hub.ts",
    );
  });

  it("names the offending file when anything else builds the switch", () => {
    expect(() =>
      assertOnlyCompositionBuildsSwitch([
        { relativePath: SWITCH_COMPOSITION, content: "actions: new CapabilitySkillActionsService(sources)," },
        {
          relativePath: "apps/gateway/src/services/gateway-service.ts",
          content: "const switcher = new CapabilitySkillActionsService({ ...owners });",
        },
      ]),
    ).toThrow(
      "The Capabilities skill switch is built outside its composition: apps/gateway/src/services/gateway-service.ts",
    );
  });

  it("names the offending file when anything else writes a skip note", () => {
    expect(() =>
      assertSkipNotesOnlyInSwitch([
        { relativePath: SKIP_SERVICE, content: OPERATOR_SKILL_SKIP_NOTES.setting },
        {
          relativePath: "apps/gateway/src/services/chat-command-service.ts",
          content: OPERATOR_SKILL_SKIP_NOTES.tightening,
        },
        {
          relativePath: "apps/mission-control-next/src/cockpit/areas/capabilities/skills/use-skill-switch.ts",
          content: `import { OPERATOR_SKILL_SKIP_NOTES } from "x";`,
        },
      ]),
    ).toThrow(
      "A skill skip note is used outside the Capabilities skill switch: apps/gateway/src/services/chat-command-service.ts, apps/mission-control-next/src/cockpit/areas/capabilities/skills/use-skill-switch.ts",
    );
  });

  it("names the offending file when anything else asks for a skill approval and resolves one", () => {
    const resolveAfterRequest = [
      "async function skip(skills: any, approvals: any) {",
      "  const outcome = await skills.setSkillState('a', 'enabled', undefined, { expectedRevision: 1 });",
      "  await approvals.resolveApproval(outcome.pendingApproval.approvalId, { decision: 'approve', resolvedBy: 'x' });",
      "}",
    ].join("\n");
    const separateFunctions = [
      "const ask = (skills: any) => skills.requestSkillStateApproval('a', 'sleep', undefined, { expectedRevision: 1 });",
      "const approve = (approvals: any, id: string) => approvals.resolveApproval(id, { decision: 'approve' });",
    ].join("\n");
    expect(() =>
      assertOnlySwitchResolvesItsRequest([
        { relativePath: SKIP_SERVICE, content: resolveAfterRequest },
        // A facade may hold both in separate functions, but never chain them in one.
        { relativePath: "apps/gateway/src/services/capability-skills-composition.ts", content: separateFunctions },
        { relativePath: "apps/gateway/src/services/gateway-service.ts", content: resolveAfterRequest },
        // Anywhere else, naming both is enough.
        { relativePath: "apps/gateway/src/routes/skills.ts", content: separateFunctions },
      ]),
    ).toThrow(
      "A skill approval is resolved by code that also asks for it, outside the Capabilities skill switch: apps/gateway/src/services/gateway-service.ts, apps/gateway/src/routes/skills.ts",
    );
  });

  it("names the offending file when anything else asks for a Skill Hub approval and resolves one", () => {
    const hubSkip = [
      "async function install(skills: any, approvals: any, input: any) {",
      "  const created = await skills.createSkillHubApproval(input);",
      "  await approvals.resolveApproval(created.approval.approvalId, { decision: 'approve', resolvedBy: 'x' });",
      "}",
    ].join("\n");
    const separateFunctions = [
      "const ask = (skillHub: any, input: any) => skillHub.createSkillHubApproval(input);",
      "const approve = (approvals: any, id: string) => approvals.resolveApproval(id, { decision: 'approve' });",
    ].join("\n");
    expect(() =>
      assertOnlySwitchResolvesItsRequest([
        { relativePath: SKIP_SERVICE, content: hubSkip },
        { relativePath: "apps/gateway/src/services/capability-skills-composition.ts", content: separateFunctions },
        // The old Skill Hub operations route approving its own request would skip without the setting.
        { relativePath: "apps/gateway/src/routes/skills.ts", content: hubSkip },
        { relativePath: "apps/gateway/src/services/skills-route-service.ts", content: separateFunctions },
      ]),
    ).toThrow(
      "A skill approval is resolved by code that also asks for it, outside the Capabilities skill switch: apps/gateway/src/routes/skills.ts, apps/gateway/src/services/skills-route-service.ts",
    );
  });
});

function assertSkipNotesOnlyInSwitch(inventory: readonly SourceFile[]): void {
  const offenders = inventory
    .filter((file) => file.relativePath !== SKIP_SERVICE && NOTE_TOKENS.some((token) => file.content.includes(token)))
    .map((file) => file.relativePath);
  if (offenders.length > 0) {
    throw new Error(`A skill skip note is used outside the Capabilities skill switch: ${offenders.join(", ")}`);
  }
}

/** Anything else calling the switch would let its own requests skip (Chat's skill commands, say). */
function assertOnlyRouteCallsSwitch(inventory: readonly SourceFile[]): void {
  const offenders = inventory
    .filter((file) => file.relativePath !== SWITCH_ROUTE && SWITCH_CALL.test(file.content))
    .map((file) => file.relativePath);
  if (offenders.length > 0) {
    throw new Error(`The Capabilities skill switch is called outside its route: ${offenders.join(", ")}`);
  }
}

/** A second instance would be a second switch, with its own owners, outside the one the route reaches. */
function assertOnlyCompositionBuildsSwitch(inventory: readonly SourceFile[]): void {
  const offenders = inventory
    .filter((file) => file.relativePath !== SWITCH_COMPOSITION && SWITCH_CONSTRUCTION.test(file.content))
    .map((file) => file.relativePath);
  if (offenders.length > 0) {
    throw new Error(`The Capabilities skill switch is built outside its composition: ${offenders.join(", ")}`);
  }
}

/**
 * The switch's `revokeForPluginUninstall` is named only where it is defined and bound, and the bound function only
 * there and in the one composition that hands it to the plugins as a plain function.
 */
function assertOnlyCompositionRevokesForPlugins(inventory: readonly SourceFile[]): void {
  const offenders = inventory
    .filter(
      (file) =>
        (PLUGIN_REVOKE_METHOD.test(file.content) && ![SKIP_SERVICE, SWITCH_COMPOSITION].includes(file.relativePath)) ||
        (PLUGIN_REVOKE_FUNCTION.test(file.content) &&
          ![SWITCH_COMPOSITION, PLUGIN_REVOKE_CALLER].includes(file.relativePath)),
    )
    .map((file) => file.relativePath);
  if (offenders.length > 0) {
    throw new Error(`A plugin's skill is revoked outside its one composition: ${offenders.join(", ")}`);
  }
}

function assertOnlySwitchResolvesItsRequest(inventory: readonly SourceFile[]): void {
  const offenders = inventory
    .filter((file) => {
      if (file.relativePath === SKIP_SERVICE) return false;
      if (!REQUEST_CALL.test(file.content) || !RESOLVE_CALL.test(file.content)) return false;
      return OWNER_FACADES.has(file.relativePath) ? hasFunctionDoingBoth(file) : true;
    })
    .map((file) => file.relativePath);
  if (offenders.length > 0) {
    throw new Error(
      `A skill approval is resolved by code that also asks for it, outside the Capabilities skill switch: ${offenders.join(", ")}`,
    );
  }
}

/** Whether one function, method or arrow, not counting the functions nested in it, makes both calls. */
function hasFunctionDoingBoth(file: SourceFile): boolean {
  const source = ts.createSourceFile(file.relativePath, file.content, ts.ScriptTarget.Latest, true);
  const callsByFunction = new Map<ts.Node, Set<"request" | "resolve">>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const kind = REQUEST_METHODS.has(name) ? "request" : name === RESOLVE_METHOD ? "resolve" : undefined;
      if (kind) {
        const owner = enclosingFunction(node) ?? source;
        callsByFunction.set(owner, new Set([...(callsByFunction.get(owner) ?? []), kind]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...callsByFunction.values()].some((kinds) => kinds.size === 2);
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return undefined;
}

/** Production TypeScript under a directory: no tests, declarations, builds or installed packages. */
function listProductionSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".") ? [] : listProductionSources(fullPath);
    }
    if (
      !entry.isFile() ||
      !SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ||
      /\.(test|spec|vitest)\.[cm]?tsx?$/u.test(entry.name) ||
      entry.name.endsWith(".d.ts")
    ) {
      return [];
    }
    return [fullPath];
  });
}
