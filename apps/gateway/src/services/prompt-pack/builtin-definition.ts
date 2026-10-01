import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJsonString, DEFAULT_PROMPT_PACK_POLICY_V2, NotFoundError } from "@goatcitadel/contracts";
import { preparePromptPackImport } from "./prepare-import.js";

export const SECURITY_RED_TEAM_PACK_FILE = "goatcitadel_prompt_pack_v6_security_red_team.md";
export const OVERALL_V7_PACK_FILE = "goatcitadel_prompt_pack_v7_overall.md";
const BUILTINS: Record<string, { file: string; name?: string; sourceLabelFromBasename?: boolean }> = {
  "security-red-team-v6": {
    file: SECURITY_RED_TEAM_PACK_FILE,
    name: "Defensive Security Evaluation",
    sourceLabelFromBasename: true,
  },
  "overall-v7": { file: OVERALL_V7_PACK_FILE },
};

export function readBuiltinPromptPackSource(rootDir: string, packKey: string) {
  const builtin = BUILTINS[packKey];
  if (!builtin) throw new NotFoundError(`Unknown built-in prompt pack: ${packKey}`);
  const filePath = resolveEvalAssetsPackPath(rootDir, builtin.file);
  if (!filePath) throw new NotFoundError(`${builtin.file} was not found in this checkout.`);
  return {
    packId: packKey,
    name: builtin.name,
    sourceLabel: builtin.sourceLabelFromBasename ? path.basename(filePath) : undefined,
    content: fs.readFileSync(filePath, "utf8"),
  };
}

export function prepareBuiltinPromptPack(rootDir: string, packKey: string) {
  const prepared = preparePromptPackImport(readBuiltinPromptPackSource(rootDir, packKey));
  if (prepared.write.tests.length > 5000) throw new Error("Bundled prompt pack exceeds the bounded import size.");
  return { ...prepared, definitionRevision: builtinDefinitionRevision(packKey, prepared.write) };
}

export function builtinDefinitionRevision(
  packKey: string,
  prepared: ReturnType<typeof preparePromptPackImport>["write"],
): string {
  return createHash("sha256")
    .update(
      canonicalJsonString({
        version: "prompt_pack.builtin_import.v1",
        packKey,
        ...prepared,
        policySource: "inherited_default",
        policyV2: DEFAULT_PROMPT_PACK_POLICY_V2,
      }),
      "utf8",
    )
    .digest("hex");
}

export function resolveEvalAssetsPackPath(rootDir: string, fileName: string): string | undefined {
  const candidates = [
    path.resolve(rootDir, "eval-assets", fileName),
    path.resolve(process.cwd(), "eval-assets", fileName),
    path.resolve(process.cwd(), "..", "..", "eval-assets", fileName),
    path.resolve(process.cwd(), "..", "..", "..", "eval-assets", fileName),
    path.resolve(rootDir, fileName),
    path.resolve(process.cwd(), fileName),
    path.resolve(process.cwd(), "..", "..", fileName),
    path.resolve(process.cwd(), "..", "..", "..", fileName),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}
