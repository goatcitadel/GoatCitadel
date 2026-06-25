import path from "node:path";
import type {
  ChatMemoryMode,
  ChatMode,
  ChatProjectRecord,
  ChatThinkingLevel,
  ChatWebMode,
  PromptPackExecutionStyle,
  PromptPackRunRecord,
  PromptPackTestRecord,
  PromptPackToolTier,
  ToolGrantConstraints,
} from "@goatcitadel/contracts";
import { getChatModePreset } from "@goatcitadel/contracts";
import { resolveProjectRootForToolContext } from "./tool-path-resolution.js";
import {
  PROMPT_PACK_CODE_TOOL_NAME_LIST as PROMPT_PACK_CODE_TOOL_NAMES,
  PROMPT_PACK_EXPLICIT_TOOL_NAME_LIST as PROMPT_PACK_EXPLICIT_TOOL_NAMES,
  PROMPT_PACK_FILE_TOOL_NAME_LIST as PROMPT_PACK_FILE_TOOL_NAMES,
  PROMPT_PACK_MEMORY_TOOL_NAME_LIST as PROMPT_PACK_MEMORY_TOOL_NAMES,
  PROMPT_PACK_WEB_LOOKUP_DIRECT_TOOL_NAMES,
  PROMPT_PACK_WEB_TOOL_NAME_LIST as PROMPT_PACK_WEB_TOOL_NAMES,
} from "./chat-tool-families.js";

export const DEFAULT_PROMPT_PACK_EXECUTION_STYLE: PromptPackExecutionStyle = "single_turn_harness";
export const PROMPT_PACK_PROJECT_NAME = "Prompt Lab Workspace";
export const PROMPT_PACK_PROJECT_DESCRIPTION = "Auto-created project binding for prompt-pack code evaluations.";
export const PROMPT_PACK_PROJECT_WORKSPACE_PATH = "fixtures/prompt-pack-workspace";
export const PROMPT_PACK_REPO_PROJECT_NAME = "Prompt Lab Repo";
export const PROMPT_PACK_REPO_PROJECT_DESCRIPTION = "Auto-created project binding for prompt-pack repo evaluations.";
export const PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH = "__prompt_pack_repo__";
export const PROMPT_PACK_EXTERNAL_PROJECT_NAME = "Prompt Lab External Paths";
export const PROMPT_PACK_EXTERNAL_PROJECT_DESCRIPTION =
  "Auto-created project binding for prompt-pack evaluations with explicit external file paths.";

export interface PromptPackExecutionProfile {
  mode: ChatMode;
  toolTier: PromptPackToolTier;
  toolAutonomy: "safe_auto" | "manual";
  webMode: ChatWebMode;
  memoryMode: ChatMemoryMode;
  thinkingLevel: ChatThinkingLevel;
}

export interface PromptPackToolDirectives {
  namedTools: string[];
  prefersFileTools: boolean;
  prefersWebTools: boolean;
  prefersMemoryTools: boolean;
  suppressesTools: boolean;
}

export interface PromptPackProjectBindingConfig {
  name: string;
  description: string;
  workspacePath: string;
}

export interface PromptPackDurableReadinessInput {
  readonly durable: {
    readonly enabled: boolean;
    readonly executionEnabled: boolean;
    readonly chatAutoPromoteEnabled: boolean;
  };
  readonly durableKernelV1Enabled: boolean;
}

export const PROMPT_PACK_FIXTURE_PROJECT_BINDING: PromptPackProjectBindingConfig = {
  name: PROMPT_PACK_PROJECT_NAME,
  description: PROMPT_PACK_PROJECT_DESCRIPTION,
  workspacePath: PROMPT_PACK_PROJECT_WORKSPACE_PATH,
};

export const PROMPT_PACK_REPO_PROJECT_BINDING: PromptPackProjectBindingConfig = {
  name: PROMPT_PACK_REPO_PROJECT_NAME,
  description: PROMPT_PACK_REPO_PROJECT_DESCRIPTION,
  workspacePath: PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH,
};

export function promptPackExecutionRequiresDurable(profile: Pick<PromptPackExecutionProfile, "mode">): boolean {
  return profile.mode === "chat" || profile.mode === "cowork" || profile.mode === "code";
}

export function ensurePromptPackDurableReadiness(
  profile: Pick<PromptPackExecutionProfile, "mode">,
  readiness: PromptPackDurableReadinessInput,
): void {
  if (!promptPackExecutionRequiresDurable(profile)) {
    return;
  }
  if (
    readiness.durable.enabled &&
    readiness.durable.executionEnabled &&
    readiness.durable.chatAutoPromoteEnabled &&
    readiness.durableKernelV1Enabled
  ) {
    return;
  }
  throw new Error(
    `Prompt Lab preflight failed: durable-owned ${profile.mode} execution is unavailable. ` +
      "GoatCitadel shipped Chat/Cowork/Code runs require durable execution before Prompt Lab can start the run.",
  );
}

export function resolvePromptPackExecutionProfile(input: {
  test: PromptPackTestRecord;
  override?: {
    mode?: ChatMode;
    toolTier?: PromptPackToolTier;
    toolAutonomy?: "safe_auto" | "manual";
    webMode?: ChatWebMode;
    memoryMode?: ChatMemoryMode;
    thinkingLevel?: ChatThinkingLevel;
  };
}): PromptPackExecutionProfile {
  const mode = input.override?.mode ?? input.test.mode ?? "chat";
  const preset = getChatModePreset(mode).defaultPrefs;
  const toolTier = input.override?.toolTier ?? input.test.toolTier ?? "implicit-tools";
  const presetMemoryMode = (preset as { memoryMode?: ChatMemoryMode }).memoryMode ?? "auto";
  const profile: PromptPackExecutionProfile = {
    mode,
    toolTier,
    toolAutonomy: (preset.toolAutonomy ?? "safe_auto") as "safe_auto" | "manual",
    webMode: (preset.webMode ?? "auto") as ChatWebMode,
    memoryMode: presetMemoryMode,
    thinkingLevel: (preset.thinkingLevel ?? "standard") as ChatThinkingLevel,
  };

  switch (toolTier) {
    case "no-tools":
      profile.toolAutonomy = "manual";
      profile.webMode = "off";
      profile.memoryMode = "off";
      break;
    case "explicit-tools":
    case "implicit-tools":
    default:
      profile.toolAutonomy = "safe_auto";
      profile.webMode = "auto";
      profile.memoryMode = "auto";
      break;
  }

  if (mode === "code" && toolTier !== "no-tools") {
    const directives = detectPromptPackToolDirectives(input.test.prompt ?? "");
    profile.webMode = directives.prefersWebTools ? "auto" : "off";
    profile.memoryMode = directives.prefersMemoryTools ? "auto" : "off";
  }

  if (input.override?.toolAutonomy) {
    profile.toolAutonomy = input.override.toolAutonomy;
  }
  if (input.override?.webMode) {
    profile.webMode = input.override.webMode;
  }
  if (input.override?.memoryMode) {
    profile.memoryMode = input.override.memoryMode;
  }
  if (input.override?.thinkingLevel) {
    profile.thinkingLevel = input.override.thinkingLevel;
  }

  return profile;
}

export function resolvePromptPackExecutionStyle(value?: string | null): PromptPackExecutionStyle {
  return value === "agentic_surface" ? "agentic_surface" : DEFAULT_PROMPT_PACK_EXECUTION_STYLE;
}

export function getResolvedPromptPackExecutionProfile(
  run: PromptPackRunRecord,
  test: PromptPackTestRecord,
): PromptPackExecutionProfile {
  return resolvePromptPackExecutionProfile({
    test,
    override: {
      mode: run.mode,
      toolTier: run.toolTier,
      toolAutonomy: run.toolAutonomy,
      webMode: run.webMode,
      memoryMode: run.memoryMode,
      thinkingLevel: run.thinkingLevel,
    },
  });
}

export function resolvePromptPackProjectBinding(
  profile: PromptPackExecutionProfile,
  prompt = "",
  options?: {
    rootDir?: string;
    workspaceRoot?: string;
  },
): PromptPackProjectBindingConfig | undefined {
  const pathHints = extractPromptPackPathHints(prompt);
  const directives = detectPromptPackToolDirectives(prompt);
  const repoGroundedChatAssist = shouldApplyPromptPackRepoGroundedChatAssist(prompt, profile);
  const needsProjectBinding =
    profile.mode === "code" || directives.prefersFileTools || repoGroundedChatAssist || pathHints.length > 0;
  if (!needsProjectBinding) {
    return undefined;
  }
  if (prompt.toLowerCase().includes(PROMPT_PACK_PROJECT_WORKSPACE_PATH.toLowerCase())) {
    return PROMPT_PACK_FIXTURE_PROJECT_BINDING;
  }
  const externalPathBinding = resolvePromptPackExternalPathBinding(pathHints, {
    rootDir: options?.rootDir,
    workspaceRoot: options?.workspaceRoot,
  });
  if (externalPathBinding) {
    return externalPathBinding;
  }
  return PROMPT_PACK_REPO_PROJECT_BINDING;
}

export function findPromptPackProjectBinding(
  projects: ChatProjectRecord[],
  preferredWorkspacePath = PROMPT_PACK_PROJECT_WORKSPACE_PATH,
): ChatProjectRecord | undefined {
  if (isPromptPackExternalProjectWorkspacePath(preferredWorkspacePath)) {
    return projects.find(
      (project) =>
        project.workspacePath === preferredWorkspacePath &&
        project.name === PROMPT_PACK_EXTERNAL_PROJECT_NAME &&
        project.description === PROMPT_PACK_EXTERNAL_PROJECT_DESCRIPTION,
    );
  }
  const preferredByPath = projects.find((project) => project.workspacePath === preferredWorkspacePath);
  if (preferredByPath) {
    return preferredByPath;
  }
  if (preferredWorkspacePath === PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH) {
    return projects.find(
      (project) =>
        project.name === PROMPT_PACK_REPO_PROJECT_NAME ||
        (project.workspacePath === PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH &&
          project.description === PROMPT_PACK_REPO_PROJECT_DESCRIPTION),
    );
  }
  return projects.find(
    (project) =>
      project.name === PROMPT_PACK_PROJECT_NAME ||
      (project.workspacePath === PROMPT_PACK_PROJECT_WORKSPACE_PATH &&
        project.description === PROMPT_PACK_PROJECT_DESCRIPTION),
  );
}

export function buildPromptPackSessionToolAllowlist(profile: PromptPackExecutionProfile, prompt = ""): string[] {
  if (profile.toolTier === "no-tools") {
    return [];
  }
  const directives = detectPromptPackToolDirectives(prompt);
  if (directives.suppressesTools) {
    return [];
  }
  const repoGroundedChatAssist = shouldApplyPromptPackRepoGroundedChatAssist(prompt, profile);
  const tools = new Set<string>();
  if (profile.mode === "code") {
    for (const toolName of PROMPT_PACK_CODE_TOOL_NAMES) {
      tools.add(toolName);
    }
    if (promptPackNeedsShellExec(prompt, directives)) {
      tools.add("shell.exec");
    }
  } else if (directives.prefersFileTools || repoGroundedChatAssist) {
    for (const toolName of PROMPT_PACK_FILE_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (directives.prefersWebTools) {
    for (const toolName of PROMPT_PACK_WEB_TOOL_NAMES) {
      tools.add(toolName);
    }
    tools.add("time.now");
  }
  if (directives.prefersMemoryTools) {
    for (const toolName of PROMPT_PACK_MEMORY_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  for (const toolName of directives.namedTools) {
    tools.add(toolName);
  }
  return [...tools];
}

export function isPromptPackReadTool(toolName: string): boolean {
  return PROMPT_PACK_FILE_TOOL_NAMES.includes(toolName as (typeof PROMPT_PACK_FILE_TOOL_NAMES)[number]);
}

export function buildPromptPackSessionReadGrantConstraints(input: {
  prompt: string;
  rootDir: string;
  workspaceRoot: string;
  projectWorkspacePath?: string;
}): ToolGrantConstraints | undefined {
  const allowedPaths = buildPromptPackSessionAllowedPaths(input);
  if (allowedPaths.length === 0) {
    return undefined;
  }
  return { allowedPaths };
}

export function buildPromptPackSessionAllowedPaths(input: {
  prompt: string;
  rootDir: string;
  workspaceRoot: string;
  projectWorkspacePath?: string;
}): string[] {
  const allowedPaths = new Set<string>();
  const projectRoot = resolvePromptPackProjectRootForAllowedPaths(input);
  if (input.projectWorkspacePath && !isPromptPackExternalProjectWorkspacePath(input.projectWorkspacePath)) {
    addPromptPackAllowedPath(allowedPaths, projectRoot ?? input.workspaceRoot, false);
  }
  for (const candidate of extractPromptPackPathHints(input.prompt)) {
    for (const resolvedPath of resolvePromptPackAllowedCandidates({
      candidate,
      workspaceRoot: input.workspaceRoot,
      projectRoot,
      projectWorkspacePath: input.projectWorkspacePath,
    })) {
      addPromptPackAllowedPath(allowedPaths, resolvedPath, true);
    }
  }
  return [...allowedPaths];
}

function resolvePromptPackProjectRootForAllowedPaths(input: {
  rootDir: string;
  workspaceRoot: string;
  projectWorkspacePath?: string;
}): string | undefined {
  if (!input.projectWorkspacePath) {
    return undefined;
  }
  if (input.projectWorkspacePath === PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH) {
    return resolvePromptPackPortablePath(input.rootDir);
  }
  const resolved =
    resolveProjectRootForToolContext({
      workspaceRoot: input.workspaceRoot,
      repoRoot: input.rootDir,
      projectWorkspacePath: input.projectWorkspacePath,
    }) ?? input.workspaceRoot;
  if (isPromptPackWindowsAbsolutePath(input.workspaceRoot) || isPromptPackWindowsAbsolutePath(input.rootDir)) {
    return resolvePromptPackPortablePath(input.workspaceRoot, input.projectWorkspacePath);
  }
  return resolved;
}

function resolvePromptPackExternalPathBinding(
  pathHints: string[],
  options: {
    rootDir?: string;
    workspaceRoot?: string;
  },
): PromptPackProjectBindingConfig | undefined {
  if (!options.rootDir || !options.workspaceRoot) {
    return undefined;
  }
  const externalDirectories = pathHints
    .filter((pathHint) => path.isAbsolute(pathHint) || isPromptPackWindowsAbsolutePath(pathHint))
    .map((pathHint) => resolvePromptPackPortablePath(pathHint))
    .filter(
      (absolutePath) =>
        !isPromptPackPathWithinRoot(options.rootDir ?? "", absolutePath) &&
        !isPromptPackPathWithinRoot(options.workspaceRoot ?? "", absolutePath),
    )
    .map((absolutePath) => {
      const pathApi = promptPackPathApiFor(absolutePath);
      const basename = pathApi.basename(absolutePath);
      return basename.startsWith(".") || pathApi.extname(basename).length > 0
        ? pathApi.dirname(absolutePath)
        : absolutePath;
    });
  if (externalDirectories.length === 0) {
    return undefined;
  }
  const workspacePath = commonPromptPackPathRoot(externalDirectories);
  if (!workspacePath) {
    return undefined;
  }
  return {
    name: PROMPT_PACK_EXTERNAL_PROJECT_NAME,
    description: PROMPT_PACK_EXTERNAL_PROJECT_DESCRIPTION,
    workspacePath,
  };
}

function commonPromptPackPathRoot(paths: string[]): string | undefined {
  const [first, ...rest] = paths;
  if (!first) {
    return undefined;
  }
  const pathApi = promptPackPathApiFor(first, ...rest);
  let common = pathApi.resolve(first);
  for (const candidate of rest) {
    const resolved = pathApi.resolve(candidate);
    while (!isPromptPackPathWithinRoot(common, resolved)) {
      const parent = pathApi.dirname(common);
      if (parent === common) {
        return undefined;
      }
      common = parent;
    }
  }
  return common;
}

function isPromptPackExternalProjectWorkspacePath(projectWorkspacePath: string): boolean {
  return path.isAbsolute(projectWorkspacePath) || isPromptPackWindowsAbsolutePath(projectWorkspacePath);
}

function isPromptPackPathWithinRoot(root: string, target: string): boolean {
  if (!root || !target) {
    return false;
  }
  const pathApi = promptPackPathApiFor(root, target);
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

export function extractPromptPackPathHints(prompt: string): string[] {
  const matches = new Set<string>();
  const captureMatches = (pattern: RegExp) => {
    for (const match of prompt.matchAll(pattern)) {
      const candidate = match[1]?.trim().replace(/[.,:;]+$/, "");
      if (candidate) {
        matches.add(candidate.replaceAll("\\", "/"));
      }
    }
  };
  captureMatches(/([A-Za-z]:[\\/][^\s`"',)]+)/g);
  captureMatches(
    /(?:^|[\s`"'(])((?:\.{1,2}\/)?(?:fixtures\/prompt-pack-workspace|apps\/|packages\/|docs\/|workspace\/|config\/|scripts\/|artifacts\/)[^\s`"',)]*)/g,
  );
  captureMatches(
    /(?:^|[\s`"'(])((?:goatcitadel_prompt_pack(?:_[A-Za-z0-9._-]+)?\.md|AGENTS\.md|\.gitignore|pnpm-workspace\.yaml|package\.json))(?:$|[\s`"',)])/g,
  );
  return [...matches];
}

function resolvePromptPackAllowedCandidates(input: {
  candidate: string;
  workspaceRoot: string;
  projectRoot?: string;
  projectWorkspacePath?: string;
}): string[] {
  if (path.isAbsolute(input.candidate) || isPromptPackWindowsAbsolutePath(input.candidate)) {
    return [resolvePromptPackPortablePath(input.candidate)];
  }

  const candidates = new Set<string>([resolvePromptPackPortablePath(input.workspaceRoot, input.candidate)]);

  if (input.projectRoot) {
    const projectRelative = normalizePromptPackProjectRelativeInput(input.candidate, input.projectWorkspacePath);
    candidates.add(resolvePromptPackPortablePath(input.projectRoot, projectRelative));
  }

  return [...candidates];
}

function normalizePromptPackProjectRelativeInput(rawPath: string, projectWorkspacePath?: string): string {
  if (!projectWorkspacePath) {
    return rawPath;
  }
  const normalizedRawPath = rawPath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  const normalizedProjectPath = projectWorkspacePath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  const projectBaseName = normalizedProjectPath.split("/").at(-1);
  if (!projectBaseName) {
    return rawPath;
  }
  if (normalizedRawPath === normalizedProjectPath) {
    return ".";
  }
  if (normalizedRawPath.startsWith(`${normalizedProjectPath}/`)) {
    return normalizedRawPath.slice(normalizedProjectPath.length + 1);
  }
  if (normalizedRawPath === projectBaseName) {
    return ".";
  }
  if (normalizedRawPath.startsWith(`${projectBaseName}/`)) {
    return normalizedRawPath.slice(projectBaseName.length + 1);
  }
  return rawPath;
}

function addPromptPackAllowedPath(target: Set<string>, candidate: string, includeParentForFile: boolean): void {
  const pathApi = promptPackPathApiFor(candidate);
  const normalizedCandidate = pathApi.resolve(candidate);
  target.add(normalizedCandidate);
  if (!includeParentForFile) {
    return;
  }
  const basename = pathApi.basename(normalizedCandidate);
  const looksLikeFile = basename.startsWith(".") || pathApi.extname(basename).length > 0;
  if (looksLikeFile) {
    target.add(pathApi.dirname(normalizedCandidate));
  }
}

function isPromptPackWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value.trim());
}

function promptPackPathApiFor(...values: string[]): typeof path.win32 | typeof path {
  return values.some((value) => isPromptPackWindowsAbsolutePath(value)) ? path.win32 : path;
}

export function resolvePromptPackPortablePath(...segments: string[]): string {
  return promptPackPathApiFor(...segments).resolve(...segments);
}

function promptPackNeedsShellExec(prompt: string, directives: PromptPackToolDirectives): boolean {
  if (directives.namedTools.includes("shell.exec") || directives.namedTools.includes("shell.exec_background")) {
    return true;
  }
  const lower = prompt.toLowerCase();
  return (
    /\b(shell|terminal)\s+(command|commands?)\b/.test(lower) ||
    /\b(run|execute|invoke|launch|start)\b[^.\n]{0,80}\b(command|commands|script|scripts|shell|terminal)\b/.test(
      lower,
    ) ||
    /\b(run|execute|invoke|launch|start)\b[^.\n]{0,80}\b(npm|pnpm|yarn|bun|node|python|pytest|cargo|docker|gradle|mvn|make|go test)\b/.test(
      lower,
    ) ||
    /\binstall\b[^.\n]{0,80}\b(package|packages|dependency|dependencies|deps)\b/.test(lower)
  );
}

export function detectPromptPackToolDirectives(prompt: string): PromptPackToolDirectives {
  const lower = prompt.toLowerCase();
  const namedTools = PROMPT_PACK_EXPLICIT_TOOL_NAMES.filter((toolName) => lower.includes(toolName));
  const suppressesTools = promptSuppressesToolUse(prompt);
  const prefersFileTools =
    !suppressesTools &&
    (/\b(use|using|with)\s+(?:only\s+|just\s+|strictly\s+)?(?:file|filesystem|code|file\/code)\s+tools\b/.test(lower) ||
      /\b(use|using|with)\s+(?:only\s+|just\s+|strictly\s+)?file\s+or\s+code\s+tools\b/.test(lower) ||
      /\bread\b[\s\S]{0,80}\busing\s+(?:only\s+|just\s+|strictly\s+)?(?:file|file\/code)\s+tools\b/.test(lower) ||
      /\buse\b[\s\S]{0,120}\bfile\s+(?:search|read)\b[\s\S]{0,80}\btools\b/.test(lower) ||
      /\bfile\s+search\b[\s\S]{0,80}\bfile\s+read\b[\s\S]{0,80}\btools\b/.test(lower) ||
      /\bfile\s+read\s+tools?\b/.test(lower));
  const prefersWebTools =
    !suppressesTools &&
    (namedTools.some((toolName) => PROMPT_PACK_WEB_LOOKUP_DIRECT_TOOL_NAMES.has(toolName)) ||
      /\bweb\s+lookup\b/.test(lower) ||
      /\buse\s+(?:a\s+)?(?:web|browser)\s+(?:search|lookup)\b/.test(lower) ||
      /\buse\s+(?:a\s+)?web\s+page\b[\s\S]{0,120}\breputable\s+source\b/.test(lower) ||
      /\b(?:accessible\s+)?reputable\s+web\s+page\b/.test(lower) ||
      /\bfind\s+(?:one\s+)?(?:accessible\s+)?(?:reputable|reliable|official|credible)\s+(?:web\s+page|source)\b/.test(
        lower,
      ) ||
      /\blive\s+(?:lookup|information|source|sources|weather)\b/.test(lower) ||
      /\bcurrent\s+(?:weather|disruption|disruptions|sources?|advice|guidance|status|information)\b/.test(lower) ||
      /\blatest\s+official\s+guidance\b/.test(lower) ||
      /\bstandard mileage rate\b/.test(lower) ||
      /\bbring an umbrella\b/.test(lower) ||
      /\bresearch\s+whether\b/.test(lower) ||
      /\buse\s+available\s+lookup\b/.test(lower) ||
      /\bfind\s+a\s+plausible\s+public\s+venue\b/.test(lower) ||
      /\bfind\s+(?:one\s+)?(?:reliable|official|credible)\s+source\b/.test(lower) ||
      /\bsource\s+on\s+whether\b/.test(lower) ||
      /\bopen\s+late\s+this\s+friday\b/.test(lower) ||
      /\bpublic\s+venue\b[\s\S]{0,80}\b(?:small meetup|meetup|availability|meeting room)\b/.test(lower) ||
      /\bfarmers?\s+market\b[\s\S]{0,120}\b(?:busy|arrive|arrival|weekend)\b/.test(lower) ||
      /\blook\s+up\b/.test(lower) ||
      /\blook\s+up\b[\s\S]{0,80}\b(?:current|latest|public|official|source|hours?|tips?|weather|venue|place|market)\b/.test(
        lower,
      ) ||
      /\bcurrent\s+public\b[\s\S]{0,80}\b(?:source|tips?|guidance|information)\b/.test(lower) ||
      /\bcite\b[\s\S]{0,80}\b(?:source|sources|url|web|official)\b/.test(lower));
  const prefersMemoryTools =
    !suppressesTools &&
    (namedTools.some((toolName) => toolName.startsWith("memory.")) ||
      /\bmemory\s+tools?\b/.test(lower) ||
      /\buse\s+(?:available\s+)?memory\b/.test(lower) ||
      /\buse\s+available\s+memory\/context\b/.test(lower) ||
      /\bavailable\s+memory\/context\b/.test(lower) ||
      /\bbased on what you know about my preferences\b/.test(lower) ||
      /\bmemory-informed\b/.test(lower));

  return {
    namedTools,
    prefersFileTools,
    prefersWebTools,
    prefersMemoryTools,
    suppressesTools,
  };
}

export function promptSuppressesToolUse(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    /\banswer\s+without\s+tools\b/.test(lower) ||
    /\bdo\s+not\s+use\s+(?:any\s+)?tools\b/.test(lower) ||
    /\bdon't\s+use\s+(?:any\s+)?tools\b/.test(lower) ||
    /\bplease\s+do\s+not\s+look\s+anything\s+up\b/.test(lower) ||
    /\bdo\s+not\s+look\s+(?:anything|this|that|it)\s+up\b/.test(lower) ||
    /\bdon't\s+look\s+(?:anything|this|that|it)\s+up\b/.test(lower) ||
    /\bfrom\s+memory\s+only\b/.test(lower) ||
    /\bbased\s+only\s+on\s+the\s+(?:details|prompt|text)\b/.test(lower)
  );
}

export function promptUsesRoleOrder(prompt: string): boolean {
  return /\broles?\s+in\s+(?:this\s+)?(?:exact\s+)?order\b/i.test(prompt);
}

export function promptRequestsSynthesisOrRecommendation(prompt: string): boolean {
  return (
    /\b(?:then\s+)?end\s+with\b[\s\S]{0,120}\b(?:synthesized|recommendation|uncertainty|handoff|summary)\b/i.test(
      prompt,
    ) ||
    /\bthen\s+give\b[\s\S]{0,80}\b(?:single\s+)?recommendation\b/i.test(prompt) ||
    /\bgive\b[\s\S]{0,80}\bsingle\s+recommendation\b/i.test(prompt)
  );
}

export function promptKeepsRequestedRoleOrderOnly(prompt: string): boolean {
  return (
    /\bkeep\b[\s\S]{0,40}\brequested role order only\b/i.test(prompt) ||
    /\brequested role order only\b/i.test(prompt) ||
    (/\brequested role order\b/i.test(prompt) &&
      (/\bno extra headings\b/i.test(prompt) || /\bdo not add extra headings\b/i.test(prompt))) ||
    (/\bkeep\b[\s\S]{0,80}\bsections?\b[\s\S]{0,40}\brequested order\b/i.test(prompt) &&
      /\bdo not add\b[\s\S]{0,40}\bsynthesis section\b/i.test(prompt)) ||
    /\bdo not add\b[\s\S]{0,20}\bsynthesis section\b/i.test(prompt)
  );
}

export function promptRequiresExactFileGrounding(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    /\bexact (?:evidence|file|files|patch points?|assertions?|cit(?:e|ed)|line numbers?|rollout wiring)\b/.test(
      normalized,
    ) ||
    /\bfile-grounded\b/.test(normalized) ||
    /\bcite the exact\b/.test(normalized)
  );
}

export function shouldApplyPromptPackRepoGroundedChatAssist(
  prompt: string,
  profile: Pick<PromptPackExecutionProfile, "mode" | "toolTier">,
): boolean {
  if (profile.toolTier !== "implicit-tools") {
    return false;
  }
  const normalized = prompt.toLowerCase();
  return (
    /\binspect(?: the)? (?:repo|repository|codebase|workspace)\b/.test(normalized) ||
    /\brepo(?:sitory)? inspection\b/.test(normalized) ||
    /\buse (?:file|code|file\/code) tools\b/.test(normalized) ||
    /\bcite (?:the )?exact files?\b/.test(normalized) ||
    /\bexact (?:file )?evidence\b/.test(normalized) ||
    /\bguidance-loading chain\b/.test(normalized) ||
    /\bcurrent implementation\b/.test(normalized) ||
    /\b(?:find|locate)\b[\s\S]{0,80}\bexisting\b[\s\S]{0,60}\b(?:tests?|test files?|implementations?|files?|routes?|services?|components?)\b/.test(
      normalized,
    ) ||
    (/\bcurrent\b/.test(normalized) && /\b(repo|repository|workspace|codebase)\b/.test(normalized))
  );
}

export function formatPromptPackExecutionProfile(profile: PromptPackExecutionProfile): string {
  return [profile.toolAutonomy, profile.webMode, profile.memoryMode, profile.thinkingLevel].join(" / ");
}
