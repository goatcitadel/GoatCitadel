import type { ChatSessionPrefsPatch, PromptPackExecutionStyle } from "@goatcitadel/contracts";
import { getChatModePreset } from "@goatcitadel/contracts";
import {
  DEFAULT_PROMPT_PACK_EXECUTION_STYLE,
  type PromptPackExecutionProfile,
  type PromptPackToolDirectives,
} from "../prompt-pack-execution-profile.js";

export interface PromptPackPromptInputDeps {
  detectToolDirectives(prompt: string): PromptPackToolDirectives;
  shouldApplyRepoGroundedChatAssist(prompt: string, profile: PromptPackExecutionProfile): boolean;
  shouldDisableModeOrchestration(profile: PromptPackExecutionProfile, prompt: string): boolean;
  promptKeepsRequestedRoleOrderOnly(prompt: string): boolean;
  promptRequestsSynthesisOrRecommendation(prompt: string): boolean;
  extractRolesInOrder(text: string): string[];
  extractOrderedSections(prompt: string): string[];
  extractPerspectiveLabels(prompt: string): string[];
  promptRequiresControllerOwnedDelivery(prompt: string): boolean;
  extractPathHints(prompt: string): string[];
  promptRequiresExactFileGrounding(prompt: string): boolean;
}

const PROMPT_PACK_ARTIFACT_TOOL_NAMES = new Set(["artifacts.create", "documents.create", "presentations.create"]);

export function buildPromptPackSessionPrefsOverrideWithDeps(input: {
  profile: PromptPackExecutionProfile;
  prompt?: string;
  executionStyle?: PromptPackExecutionStyle;
  deps: PromptPackPromptInputDeps;
}): ChatSessionPrefsPatch {
  const prompt = input.prompt ?? "";
  const executionStyle = input.executionStyle ?? DEFAULT_PROMPT_PACK_EXECUTION_STYLE;
  const directives = input.deps.detectToolDirectives(prompt);
  const repoGroundedChatAssist = input.deps.shouldApplyRepoGroundedChatAssist(prompt, input.profile);
  const disableModeOrchestration = input.deps.shouldDisableModeOrchestration(input.profile, prompt);
  const explicitToolDirective =
    input.profile.toolTier === "explicit-tools" &&
    (directives.namedTools.length > 0 ||
      directives.prefersFileTools ||
      directives.prefersWebTools ||
      directives.prefersMemoryTools);
  const webMode = directives.suppressesTools
    ? "off"
    : input.profile.mode === "code" && directives.prefersWebTools
      ? "auto"
      : repoGroundedChatAssist
        ? "off"
        : directives.prefersWebTools
          ? "auto"
          : explicitToolDirective && !directives.prefersWebTools
            ? "off"
            : input.profile.webMode;
  const memoryMode = directives.suppressesTools
    ? "off"
    : input.profile.mode === "code" && directives.prefersMemoryTools
      ? "auto"
      : repoGroundedChatAssist
        ? "off"
        : directives.prefersMemoryTools
          ? "auto"
          : explicitToolDirective && !directives.prefersMemoryTools
            ? "off"
            : input.profile.memoryMode;

  const base: ChatSessionPrefsPatch = {
    mode: input.profile.mode,
    planningMode: "off",
    toolAutonomy: directives.suppressesTools ? "manual" : input.profile.toolAutonomy,
    webMode,
    memoryMode,
    thinkingLevel: input.profile.thinkingLevel,
  };

  if (executionStyle === "agentic_surface") {
    const agenticPrefs: ChatSessionPrefsPatch = {
      ...getChatModePreset(input.profile.mode).defaultPrefs,
      ...base,
    };
    if (disableModeOrchestration) {
      return {
        ...agenticPrefs,
        orchestrationEnabled: false,
        orchestrationVisibility: input.profile.mode === "chat" ? undefined : "explicit",
        orchestrationParallelism: "sequential",
      };
    }
    return {
      ...agenticPrefs,
    };
  }

  return {
    ...base,
    // Prompt Lab runs are more reliable when the answering turn owns the full
    // contract. Keep non-chat evaluations on the single-agent path so the
    // harness, exact sections, and evidence requirements are not diffused
    // across internal worker chatter.
    orchestrationEnabled: false,
    orchestrationVisibility: input.profile.mode === "chat" ? undefined : "explicit",
    // Prompt Lab values deterministic runs over parallel stage fan-out. Keeping
    // harness orchestration sequential avoids SQLite/trace write contention
    // between sibling worker turns while preserving the visible role handoff.
    orchestrationParallelism: "sequential",
  };
}

export function buildPromptPackPromptInputWithDeps(input: {
  prompt: string;
  profile: PromptPackExecutionProfile;
  title?: string;
  deps: PromptPackPromptInputDeps;
}): {
  prompt: string;
  directives: PromptPackToolDirectives;
} {
  const directives = input.deps.detectToolDirectives(input.prompt);
  const titleRolesInOrder = input.title ? input.deps.extractRolesInOrder(input.title) : [];
  const orderedSections = input.deps.extractOrderedSections(input.prompt);
  const requestedRoleOrderOnly = input.deps.promptKeepsRequestedRoleOrderOnly(input.prompt);
  const orderedSectionsWithRequestedSynthesis =
    orderedSections.length > 0 &&
    !requestedRoleOrderOnly &&
    input.deps.promptRequestsSynthesisOrRecommendation(input.prompt)
      ? [...orderedSections, "Synthesis"]
      : orderedSections;
  const effectiveOrderedSections =
    orderedSectionsWithRequestedSynthesis.length > 0
      ? orderedSectionsWithRequestedSynthesis
      : titleRolesInOrder.length > 0
        ? requestedRoleOrderOnly
          ? titleRolesInOrder.map((role) => formatPromptPackRoleHeading(role))
          : [...titleRolesInOrder.map((role) => formatPromptPackRoleHeading(role)), "Synthesis"]
        : [];
  const perspectiveLabels = input.deps.extractPerspectiveLabels(input.prompt);
  const controllerOwnedDelivery = input.deps.promptRequiresControllerOwnedDelivery(input.prompt);
  const pathHints = input.deps.extractPathHints(input.prompt);
  const repoGroundedChatAssist = input.deps.shouldApplyRepoGroundedChatAssist(input.prompt, input.profile);
  const visibleContextPreferencePrompt =
    /\bhow I like technical answers formatted\b/i.test(input.prompt) &&
    /\b(?:user-visible|visible)\s+context\s+only\b/i.test(input.prompt);
  const shouldWrapPrompt =
    input.profile.mode !== "chat" ||
    input.profile.toolTier === "explicit-tools" ||
    repoGroundedChatAssist ||
    visibleContextPreferencePrompt;
  if (!shouldWrapPrompt) {
    return { prompt: input.prompt, directives };
  }

  const requiredFamilies: string[] = [];
  if (directives.prefersFileTools) {
    requiredFamilies.push("file/code tools");
  }
  if (directives.prefersWebTools) {
    requiredFamilies.push("web lookup tools");
  }
  if (directives.prefersMemoryTools) {
    requiredFamilies.push("memory tools");
  }

  const harnessLines = [
    "## Prompt Lab Run Contract",
    `- Mode: ${input.profile.mode}`,
    `- Tool tier: ${input.profile.toolTier}`,
    "- Finish with a complete answer in one turn. Prefer concise coverage over a long partial draft.",
    "- Do not leave required sections trailing or unfinished.",
  ];

  if (visibleContextPreferencePrompt) {
    harnessLines.push(
      "- Visible-context memory boundary: answer only from the user's visible prompt text. Do not infer user preferences from system, developer, runtime, harness, repo, or style instructions.",
    );
    harnessLines.push(
      "- Safe answer shape: say you cannot know durable technical-answer formatting preferences from the visible prompt alone, state that no memory/prior context is being used, and name the visible examples or explicit preferences needed.",
    );
  }

  if (input.profile.mode === "cowork") {
    harnessLines.push(
      "- This is a Cowork evaluation. Make the workflow legible instead of answering as one opaque voice.",
    );
    harnessLines.push(
      "- Answer the user's task directly. Do not grade, critique, review, or revise an imagined draft unless the prompt explicitly asks for review feedback.",
    );
    if (effectiveOrderedSections.length > 0) {
      harnessLines.push(
        `- Output exactly these top-level sections in this order: ${effectiveOrderedSections.map((section) => `\`${section}\``).join(", ")}.`,
      );
      harnessLines.push("- Do not add extra headings before, between, or after those sections.");
      if (requestedRoleOrderOnly) {
        harnessLines.push(
          "- Use only those top-level sections. Do not add Synthesis, Conclusion, Final Answer, Summary, or extra subheadings.",
        );
        harnessLines.push("- Keep each requested section compact: 2-4 bullets or 1-2 short paragraphs.");
        if (input.profile.toolTier === "no-tools") {
          harnessLines.push(
            "- Keep the whole answer under about 220 words unless the prompt explicitly requires more detail.",
          );
        }
      } else {
        harnessLines.push("- Keep each requested section compact, evidence-backed, and decision-oriented.");
      }
    } else {
      harnessLines.push(
        "- For non-trivial everyday tasks, use at least two role-labeled sections chosen from Planner, Researcher, Risk Review, Operator Handoff, or Synthesis.",
      );
      harnessLines.push(
        "- Do not default to Coder, Architect, QA, Ops, repo, source-file, or code-review framing unless the user task explicitly asks for software, files, or implementation work.",
      );
      harnessLines.push(
        "- Keep role sections distinct: use Planner for criteria/options, Risk Review for tradeoffs or what would change the answer, and Operator Handoff for the final recommendation when those labels fit.",
      );
      harnessLines.push("- Do not repeat the same bullets across multiple role sections.");
      harnessLines.push("- Keep each role section compact and decision-oriented.");
    }
    harnessLines.push(
      "- Do not mention repo paths, source files, tool traces, local-file evidence, or repository-wide claims unless the user explicitly asks for local file, code, or repository inspection.",
    );
    if (perspectiveLabels.length > 0) {
      harnessLines.push(
        `- Cover exactly these named perspectives/lenses: ${perspectiveLabels.map((label) => `\`${label}\``).join(", ")}.`,
      );
      harnessLines.push(
        "- Do not rename those perspectives to generic stand-ins such as Critic, Product Goat, or Architect Goat.",
      );
      harnessLines.push(
        "- Use each named perspective/lens verbatim as its own compact subsection before the final recommendation.",
      );
    }
    if (controllerOwnedDelivery) {
      harnessLines.push(
        "- Keep the final answer controller-owned. Do not expose raw specialist chatter, role transcripts, or synthetic handoff scaffolds.",
      );
      harnessLines.push(
        "- If the prompt still requires perspectives or lenses, name what each one contributed inside the controller-owned answer.",
      );
    }
    // Test-keyed steering lines were removed deliberately: the run contract
    // must stay test-agnostic so pack scores measure the model, not coaching
    // injected for specific prompts.
    if (input.profile.toolTier === "no-tools") {
      harnessLines.push(
        "- In no-tools Cowork runs, prefer terse bullets over long paragraphs. Keep the whole answer under about 350 words unless the prompt explicitly requires more detail.",
      );
    }
  }

  if (input.profile.mode === "code") {
    harnessLines.push("- This is a Code evaluation. Stay project-bound, concrete, and evidence-backed.");
    harnessLines.push(
      "- Answer the requested audit, plan, or fix directly. Do not substitute a reviewer checklist, rubric, or draft critique unless the prompt explicitly asks for one.",
    );
    harnessLines.push(
      "- Use bounded repo inspection: start with targeted file-name or symbol searches from the prompt's concrete nouns, then read the strongest matching files before answering.",
    );
    harnessLines.push(
      "- Avoid broad repository searches over `.` with generic terms when the prompt or harness names tighter paths, services, tests, or report surfaces.",
    );
    // A named artifact tool in the run contract overrides the default
    // no-artifact posture for Code rows; the contract entry wins over prose.
    if (directives.namedTools.some((toolName) => PROMPT_PACK_ARTIFACT_TOOL_NAMES.has(toolName))) {
      harnessLines.push(
        "- The Required named tools list includes an artifact tool; creating that artifact is part of the deliverable for this row.",
      );
    } else {
      harnessLines.push(
        "- Do not create document, presentation, or artifact files for Prompt Lab Code rows unless the user explicitly asks for that tool; deliver the code answer in the final message.",
      );
    }
    harnessLines.push(
      "- Stay anchored to the prompt's exact nouns and requested scope. Do not drift to a nearby repo task just because it sounds similar.",
    );
    harnessLines.push(
      "- If you read files or inspect code, name the exact file paths and the specific symbols, imports, scripts, or config values you observed.",
    );
    harnessLines.push(
      "- Do not say `based on my inspection`, `I inspected the repo`, or similar unless you also name the exact files or tool outputs that support that claim.",
    );
    harnessLines.push(
      "- Do not claim validation or execution unless you include the exact command/check and the result.",
    );
    harnessLines.push(
      "- Do not name scripts, frameworks, folders, or commands by convention alone. If repo inspection did not confirm them, say that plainly instead of guessing.",
    );
    harnessLines.push(
      "- Do not claim commands such as `pnpm outdated`, `npm test`, `vitest`, `jest`, `tsc`, `lint`, or `build` ran unless a shell/build/test/lint tool actually executed and returned results.",
    );
    harnessLines.push(
      "- When evidence is incomplete, separate Observed, Inferred, and Unverified statements instead of presenting all claims as equally proven.",
    );
    harnessLines.push(
      "- For non-trivial tasks, structure the answer as Findings or Plan, Changes, Validation, and Risks.",
    );
    harnessLines.push(
      "- If exact line numbers are requested, provide them only when tool output directly supports them.",
    );
    if (input.profile.toolTier === "no-tools") {
      harnessLines.push(
        "- In no-tools Code runs, propose the smallest concrete change and keep the whole answer under about 350 words unless the prompt explicitly requires more detail.",
      );
      harnessLines.push(
        "- Because tools are disabled, do not invent repo-native file paths, function names, scripts, or framework details. Frame any codebase-specific item as a proposed contract, assumption, or unknown unless the prompt itself provides it.",
      );
    }
  }

  if (repoGroundedChatAssist) {
    harnessLines.push(
      input.profile.mode === "code"
        ? "- This is a repo-grounded code evaluation. Inspect the repository before answering whenever current repo state matters."
        : "- This is a repo-grounded chat evaluation. Inspect the repository before answering whenever current repo state matters.",
    );
    harnessLines.push(
      "- Prefer one or two targeted file/code searches or range reads over broad summaries from memory.",
    );
    harnessLines.push("- Name the exact file paths or tool outputs behind any repo-grounded claim.");
    harnessLines.push(
      "- If inspection stays incomplete, separate Observed, Inferred, and Unverified claims instead of blending them.",
    );
    harnessLines.push("- Do not invent hidden files, hidden state, or precedence rules that were not observed.");
    harnessLines.push("- Repo inspection assist: enabled.");
  }

  if (input.profile.toolTier === "explicit-tools") {
    if (directives.suppressesTools) {
      harnessLines.push(
        "- This is an explicit-tools evaluation, but the user task explicitly forbids tool use. Do not call tools.",
      );
      harnessLines.push(
        "- Answer only from the prompt and label any answer as non-verified when the user asks for a gut-check, memory-only answer, or no-lookup response.",
      );
    } else {
      harnessLines.push("- This is an explicit-tools evaluation. Use the tools requested in the prompt.");
      harnessLines.push(
        "- Before drafting findings or recommendations, execute the required tool calls or explicitly state which required tool path was unavailable.",
      );
    }
    if (input.profile.mode === "code") {
      harnessLines.push(
        "- Prefer file/code tools for read-only inspection or audits. Do not use `shell.exec` unless the prompt explicitly requires command execution or a shell-only check.",
      );
    }
    if (directives.namedTools.length > 0) {
      harnessLines.push(
        `- Required named tools: ${directives.namedTools.map((toolName) => `\`${toolName}\``).join(", ")}`,
      );
    }
    if (requiredFamilies.length > 0) {
      harnessLines.push(`- Required tool families: ${requiredFamilies.join(", ")}`);
    }
    if (!directives.suppressesTools) {
      harnessLines.push(
        "- Surface tool-backed evidence in the answer. Mention which files, URLs, or tool outputs materially informed the result.",
      );
      harnessLines.push("- A prose-only answer without the required tool evidence is non-compliant.");
      harnessLines.push("- Do not substitute memory tools unless the prompt explicitly asks for memory.");
      harnessLines.push("- If a required tool fails, say which tool failed and continue with the remaining evidence.");
      if (input.profile.mode === "code" || repoGroundedChatAssist || directives.prefersFileTools) {
        harnessLines.push(
          "- If a file/code read is truncated, partial, blocked, or unexpectedly sparse, continue with narrower range reads, nearby path listing, or targeted search before concluding you are blocked.",
        );
        harnessLines.push(
          "- One failed or partial file/code read is not enough to stop. Retry once with a narrower read or a targeted file search on the same topic before concluding the repo path is unavailable.",
        );
        harnessLines.push(
          "- For exact-evidence asks, do not write `based on my inspection` or claim exact patch points/assertions unless the answer names the exact files or tool outputs used.",
        );
      }
    }
    if (!directives.suppressesTools && directives.prefersFileTools) {
      harnessLines.push(
        "- Available file/code tools in this run include `fs.read`, `fs.list`, `fs.stat`, `file.read_range`, `file.find`, `code.search`, and `code.search_files`.",
      );
      harnessLines.push("- Use those tools before concluding that local file access is unavailable.");
      harnessLines.push("- If local file paths are listed, inspect those paths before answering.");
      harnessLines.push("- Do not claim a local file was read unless a file/code tool actually executed.");
      harnessLines.push(
        "- When the prompt names subsystems instead of exact files, start with `code.search_files` or `file.find` using the prompt's concrete nouns, then read the strongest matches before answering.",
      );
      harnessLines.push(
        "- Do not search the repo for the output-contract labels themselves (for example `Canonical label`, `Inference path`, or the requested bullet titles). Search for the subsystem nouns, path hints, routes, services, tables, or UI surfaces named in the prompt instead.",
      );
      harnessLines.push(
        "- After path discovery returns likely matches, read at least one concrete implementation file before concluding that exact evidence is unavailable.",
      );
      if (input.deps.promptRequiresExactFileGrounding(input.prompt)) {
        harnessLines.push(
          "- For exact-evidence, exact-file, exact-patch-point, or exact-rollout-wiring asks, a pure path-discovery pass is not enough. Read at least two concrete repo files, or one implementation file plus the nearest test/config/doc companion, before concluding the evidence is incomplete.",
        );
        harnessLines.push(
          "- Do not stop after only `code.search_files` or `file.find` hits when the prompt asks for exact grounding.",
        );
      }
      harnessLines.push(
        "- Treat repo-relative paths such as `apps/...`, `packages/...`, `docs/...`, `config/...`, `scripts/...`, or `artifacts/...` as rooted at the GoatCitadel repository unless the prompt explicitly points to `fixtures/prompt-pack-workspace`.",
      );
      if (pathHints.length > 0) {
        const boundedScope = pathHints
          .slice(0, 6)
          .map((value) => `\`${value}\``)
          .join(", ");
        harnessLines.push(
          `- Keep file/code reads inside the prompt-listed scope unless another path is explicitly required: ${boundedScope}.`,
        );
      }
    }
    if (!directives.suppressesTools && directives.prefersWebTools) {
      harnessLines.push(
        "- Available web tools in this run include `browser.search`, `browser.navigate`, `browser.extract`, and any named `browser.interact` / `http.post` calls requested by the prompt.",
      );
      harnessLines.push(
        "- Use one focused search, open or extract at most two high-quality sources, and then synthesize from the successful evidence instead of retrying blocked hosts.",
      );
      harnessLines.push(
        "- Cite only sources you actually opened, extracted, or materially relied on. Do not list blocked, unread, or merely attempted pages as sources used.",
      );
      harnessLines.push(
        "- If the prompt asks for exactly one source, a short answer, or exactly N sentences, do not append a separate source inventory or evidence appendix.",
      );
    }
    if (!directives.suppressesTools && directives.namedTools.includes("browser.interact")) {
      harnessLines.push(
        "- For `browser.interact`, send an explicit `steps` array. A missing `steps` field is a malformed call.",
      );
    }
    if (!directives.suppressesTools && directives.namedTools.includes("http.post")) {
      harnessLines.push(
        "- If `http.post` is required, include the observed response status/body facts in the answer instead of describing a hypothetical POST.",
      );
    }
  }

  return {
    prompt: `${harnessLines.join("\n")}\n\n## User Task\n${input.prompt}`.trim(),
    directives,
  };
}

function formatPromptPackRoleHeading(role: string): string {
  if (role === "qa") {
    return "QA";
  }
  return toTitleCase(role);
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_.]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
