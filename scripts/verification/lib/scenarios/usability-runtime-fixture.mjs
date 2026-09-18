import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repoRoot, sanitizeFilePart } from "../shared.mjs";
import { writeDeterministicLlmProviderConfig } from "./deterministic-llm-stub.mjs";

/** Fresh-install browser proof uses shipped defaults, never operator config,
 * schedules, credentials, workspace guidance or existing runtime records. */
export async function prepareUsabilityRuntime(runId, baseUrl, options = {}) {
  const sourceRoot = options.sourceRoot ?? repoRoot;
  const tempParent = options.tempParent ?? (process.env.GOATCITADEL_VERIFY_TEMP_ROOT?.trim() || os.tmpdir());
  const example = JSON.parse(await fs.readFile(path.join(sourceRoot, "config", "goatcitadel.example.json"), "utf8"));
  delete example.generation;
  example.cronJobs = { jobs: [] };
  // The stub writer replaces this before the fixture can be returned/launched.
  example.llm = { activeProviderId: "", providers: [] };
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, `goatcitadel-usability-${sanitizeFilePart(runId)}-`));
  const config = path.join(root, "config");
  await fs.mkdir(config);
  await fs.mkdir(path.join(root, "data"));
  await fs.writeFile(path.join(config, "goatcitadel.json"), `${JSON.stringify(example, null, 2)}\n`);
  await fs.writeFile(path.join(config, "llm-model-metadata.json"), '{"version":1,"entries":{}}\n');
  await writeDeterministicLlmProviderConfig(root, baseUrl);
  const configured = JSON.parse(await fs.readFile(path.join(config, "goatcitadel.json"), "utf8"));
  for (const [filename, section] of Object.entries({
    "assistant.config.json": "assistant", "tool-policy.json": "toolPolicy",
    "budgets.json": "budgets", "llm-providers.json": "llm", "cron-jobs.json": "cronJobs",
  })) {
    await fs.writeFile(path.join(config, filename), `${JSON.stringify(configured[section], null, 2)}\n`);
  }
  // Skills are shipped source inputs; private workspace copies are not.
  const skills = path.join(sourceRoot, "skills");
  try {
    await fs.stat(skills);
  } catch (error) {
    if (error?.code === "ENOENT") return root;
    throw error;
  }
  await fs.cp(skills, path.join(root, "skills"), { recursive: true });
  return root;
}
