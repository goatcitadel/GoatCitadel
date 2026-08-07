#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import { auditPptxPackage, formatPptxAuditFailure } from "./lib/pptx-package-audit.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage:
  node scripts/verification/pptx-package-audit.mjs --deck <file.pptx> --output <audit.json> [options]

Options:
  --expected-text <json>       JSON array of exact visible strings that must survive rendering
  --expected-text-by-slide <json>
                               JSON { schemaVersion: 1, slides: [{ slideNumber, expectedVisibleText }] }
  --expected-urls <json>       JSON array of HTTPS hyperlink targets that must exist
  --manifest <json>            Renderer manifest to compare against the OOXML package
  --require-layout-diversity   Require 3 families, <=2 consecutive, and <=60% dominant for 8+ slides
  --help                       Show this message

Example:
  node scripts/verification/pptx-package-audit.mjs --deck workspace/goatcitadel_out/deck.pptx --expected-text artifacts/expected-text.json --expected-text-by-slide artifacts/expected-text-by-slide.json --expected-urls artifacts/expected-urls.json --manifest artifacts/render-manifest.json --require-layout-diversity --output artifacts/pptx-audit.json`);
  process.exit(0);
}

const deckPath = requireArg(args, "deck");
const outputPath = requireArg(args, "output");
if (path.extname(deckPath).toLowerCase() !== ".pptx") throw new Error("--deck must identify a .pptx file");
if (path.extname(outputPath).toLowerCase() !== ".json") throw new Error("--output must identify a .json file");
if (await exists(outputPath)) throw new Error(`Refusing to overwrite existing audit output: ${outputPath}`);

const options = {
  expectedVisibleText: await readJsonArray(args.expectedText, "--expected-text"),
  expectedVisibleTextBySlide: await readOptionalJson(args.expectedTextBySlide),
  expectedExternalUrls: await readJsonArray(args.expectedUrls, "--expected-urls"),
  manifest: await readOptionalJson(args.manifest),
  requireLayoutDiversity: args.requireLayoutDiversity === true,
};
const report = await auditPptxPackage(deckPath, options);
await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`PPTX audit ${report.passed ? "passed" : "failed"}.`);
console.log(`Artifact: ${path.resolve(outputPath)}`);
console.log(`Slides: ${report.metrics.slideCount}`);
if (!report.passed) {
  console.error(formatPptxAuditFailure(report));
  process.exitCode = 1;
}

function parseArgs(values) {
  const parsed = {};
  const aliases = new Map([
    ["--deck", "deck"],
    ["--output", "output"],
    ["--expected-text", "expectedText"],
    ["--expected-text-by-slide", "expectedTextBySlide"],
    ["--expected-urls", "expectedUrls"],
    ["--manifest", "manifest"],
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help") parsed.help = true;
    else if (value === "--require-layout-diversity") parsed.requireLayoutDiversity = true;
    else if (aliases.has(value)) {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      parsed[aliases.get(value)] = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

function requireArg(argsValue, key) {
  const value = argsValue[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required`);
  return value.trim();
}

async function readJsonArray(filePath, label) {
  if (!filePath) return [];
  const value = await readOptionalJson(filePath);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`${label} must contain a JSON array of non-empty strings`);
  }
  return value;
}

async function readOptionalJson(filePath) {
  if (!filePath) return undefined;
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
