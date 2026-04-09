import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const root = process.cwd();

const requiredFiles = [
  "README.md",
  "CHANGELOG.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
];

const requiredHeadings = {
  "CHANGELOG.md": ["# Changelog", "## [Unreleased]"],
  "AGENTS.md": ["# GoatCitadel Agent Conventions", "## Agent Roles", "## Safety Boundaries (Non-Overridable)"],
  "CONTRIBUTING.md": ["# Contributing to GoatCitadel", "## Quality Gates", "## Governance Docs Policy"],
  "SECURITY.md": ["# Security Policy", "## Reporting a Vulnerability", "## Security Invariants"],
};

const errors = [];

for (const relPath of requiredFiles) {
  const absPath = path.join(root, relPath);
  try {
    await access(absPath, constants.F_OK | constants.R_OK);
  } catch {
    errors.push(`Missing required file: ${relPath}`);
    continue;
  }
  const expectedHeadings = requiredHeadings[relPath];
  if (!expectedHeadings?.length) {
    continue;
  }
  const content = await readFile(absPath, "utf8");
  for (const heading of expectedHeadings) {
    if (!content.includes(heading)) {
      errors.push(`File ${relPath} missing required heading: ${heading}`);
    }
  }
}

if (errors.length > 0) {
  console.error("[docs:check] governance docs validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("[docs:check] governance docs validation passed.");
