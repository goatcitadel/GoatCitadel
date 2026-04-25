#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const docsToCheck = ["README.md", "docs/INSTALL_SETUP_TESTING.md"];
const forbiddenPatterns = [
  {
    pattern: /GOATCITADEL_AUTH_TOKEN\s*=\s*["']{2}/,
    message: "blank GOATCITADEL_AUTH_TOKEN example",
  },
  {
    pattern: /GOATCITADEL_POSTGRES_PASSWORD\s*=\s*["']{2}/,
    message: "blank GOATCITADEL_POSTGRES_PASSWORD example",
  },
  {
    pattern: /GOATCITADEL_AUTH_TOKEN\s*=\s*["']?change-this-goatcitadel-token["']?/,
    message: "placeholder GOATCITADEL_AUTH_TOKEN assignment example",
  },
  {
    pattern: /GOATCITADEL_POSTGRES_PASSWORD\s*=\s*["']?change-this-postgres-password["']?/,
    message: "placeholder GOATCITADEL_POSTGRES_PASSWORD assignment example",
  },
];

const failures = [];

for (const relativePath of docsToCheck) {
  const absolutePath = path.join(rootDir, relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  for (const forbidden of forbiddenPatterns) {
    if (forbidden.pattern.test(source)) {
      failures.push(`${relativePath}: contains ${forbidden.message}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Docker secret docs check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Docker secret docs check passed.");
