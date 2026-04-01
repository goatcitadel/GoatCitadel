import fs from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionStarterPackArtifactRecord,
  ExtensionStarterPackDraft,
  ExtensionStarterPackFileRecord,
  FollowOnParityReport,
} from "@goatcitadel/contracts";

const EXTENSION_CONTRACT_PATH = "docs/PLUGIN_SDK_CONTRACT.md";
const EXTENSION_ADDON_TEMPLATE_ROOT = "templates/addons/reference-separate-repo-addon";
const EXTENSION_PLUGIN_TEMPLATE_ROOT = "templates/integration-plugins/reference-integration-plugin";
const EXTENSION_STARTER_ARTIFACT_ROOT = "artifacts/follow-on-parity/extensions/starter-pack";

export interface ExtensionStarterPackFileDraft {
  relativePath: string;
  content: string;
}

export interface ExtensionStarterPackExportFileInput {
  relativePath: string;
  fullPath: string;
  bytes: number;
}

export function buildExtensionStarterPackDraft(report: FollowOnParityReport): ExtensionStarterPackDraft {
  const generatedAt = new Date().toISOString();
  const starterRoot = buildExtensionStarterPackArtifactRoot(generatedAt);
  const files = buildExtensionStarterPackRelativePaths(starterRoot);
  const summary = [
    report.plugins.sdkSummary,
    "A repo-native starter pack can now be exported with the current contract doc, reference add-on scaffold, and reference integration-plugin scaffold.",
  ].join(" ");
  const markdown = [
    "# Extension Starter Pack",
    "",
    `Generated: ${generatedAt}`,
    `Starter root: ${starterRoot}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Included Files",
    "",
    ...files.map((file) => `- ${file}`),
    "",
    "## Source Inputs",
    "",
    `- Contract: ${EXTENSION_CONTRACT_PATH}`,
    `- Add-on scaffold: ${EXTENSION_ADDON_TEMPLATE_ROOT}/`,
    `- Integration-plugin scaffold: ${EXTENSION_PLUGIN_TEMPLATE_ROOT}/`,
    "",
    "## Notes",
    "",
    "- This starter pack is a repo-native handoff bundle, not a published SDK package.",
    "- Replace placeholder metadata, URLs, install commands, and runtime details before external use.",
    "- Keep the reference plugin lifecycle smoke-tested against the scaffolded source path.",
  ].join("\n");
  return {
    generatedAt,
    summary,
    starterRoot,
    files,
    markdown,
  };
}

export async function buildExtensionStarterPackFiles(
  draft: ExtensionStarterPackDraft,
): Promise<ExtensionStarterPackFileDraft[]> {
  const [contractDoc, addonManifest, addonReadme, pluginManifest, pluginReadme] = await Promise.all([
    readRepoTextFile(EXTENSION_CONTRACT_PATH),
    readRepoTextFile(`${EXTENSION_ADDON_TEMPLATE_ROOT}/goatcitadel.addon.json`),
    readRepoTextFile(`${EXTENSION_ADDON_TEMPLATE_ROOT}/README.md`),
    readRepoTextFile(`${EXTENSION_PLUGIN_TEMPLATE_ROOT}/goatcitadel.integration-plugin.json`),
    readRepoTextFile(`${EXTENSION_PLUGIN_TEMPLATE_ROOT}/README.md`),
  ]);

  return [
    {
      relativePath: `${draft.starterRoot}/README.md`,
      content: [
        "# GoatCitadel Extension Starter Pack",
        "",
        `Generated: ${draft.generatedAt}`,
        "",
        draft.summary,
        "",
        "Included assets:",
        "",
        "- `docs/PLUGIN_SDK_CONTRACT.md`",
        "- `addons/reference-separate-repo-addon/`",
        "- `integration-plugins/reference-integration-plugin/`",
        "",
        "Use this bundle when you need a copyable author baseline outside the main repo.",
      ].join("\n"),
    },
    {
      relativePath: `${draft.starterRoot}/docs/PLUGIN_SDK_CONTRACT.md`,
      content: contractDoc,
    },
    {
      relativePath: `${draft.starterRoot}/addons/reference-separate-repo-addon/goatcitadel.addon.json`,
      content: addonManifest,
    },
    {
      relativePath: `${draft.starterRoot}/addons/reference-separate-repo-addon/README.md`,
      content: addonReadme,
    },
    {
      relativePath: `${draft.starterRoot}/integration-plugins/reference-integration-plugin/goatcitadel.integration-plugin.json`,
      content: pluginManifest,
    },
    {
      relativePath: `${draft.starterRoot}/integration-plugins/reference-integration-plugin/README.md`,
      content: pluginReadme,
    },
  ];
}

export function buildExtensionStarterPackArtifact(
  draft: ExtensionStarterPackDraft,
  files: ExtensionStarterPackExportFileInput[],
): ExtensionStarterPackArtifactRecord {
  const normalizedFiles: ExtensionStarterPackFileRecord[] = files.map((file) => ({
    relativePath: file.relativePath,
    fullPath: file.fullPath,
    bytes: file.bytes,
  }));
  return {
    generatedAt: draft.generatedAt,
    summary: draft.summary,
    starterRoot: draft.starterRoot,
    fileCount: normalizedFiles.length,
    totalBytes: normalizedFiles.reduce((sum, file) => sum + file.bytes, 0),
    files: normalizedFiles,
  };
}

export function buildExtensionStarterPackArtifactRoot(generatedAt: string): string {
  const day = generatedAt.slice(0, 10);
  const timestamp = generatedAt.replace(/[:.]/g, "-");
  return `${EXTENSION_STARTER_ARTIFACT_ROOT}/${day}/extension-starter-pack-${timestamp}`;
}

function buildExtensionStarterPackRelativePaths(starterRoot: string): string[] {
  return [
    `${starterRoot}/README.md`,
    `${starterRoot}/docs/PLUGIN_SDK_CONTRACT.md`,
    `${starterRoot}/addons/reference-separate-repo-addon/goatcitadel.addon.json`,
    `${starterRoot}/addons/reference-separate-repo-addon/README.md`,
    `${starterRoot}/integration-plugins/reference-integration-plugin/goatcitadel.integration-plugin.json`,
    `${starterRoot}/integration-plugins/reference-integration-plugin/README.md`,
  ];
}

async function readRepoTextFile(relativePath: string): Promise<string> {
  const absolutePath = path.resolve(process.cwd(), "../../", relativePath);
  return fs.readFile(absolutePath, "utf8");
}
