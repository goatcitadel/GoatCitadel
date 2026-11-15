#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Usage: node docs/review/2026-11-usability/tools/check-register.cjs [prefix...] [--file <path>]
// Reads prior-register.json (next to this tool's parent directory unless --file is given) and prints
//   unverdicted: N   rows whose verdict is null
//   uncarried: N     rows whose verdict is "open" or "partial" and that have no carriedAs
// Rows are limited to those whose priorId starts with one of the given prefixes. Exit code 1 when either is above 0.
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
let file = path.resolve(__dirname, "..", "prior-register.json");
const prefixes = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--file") file = path.resolve(args[++i]);
  else prefixes.push(args[i]);
}

let rows;
try {
  rows = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  console.error(`cannot read ${file}: ${error.message}`);
  process.exit(2);
}
if (!Array.isArray(rows)) {
  console.error(`${file} must hold a JSON array`);
  process.exit(2);
}
const scoped = prefixes.length ? rows.filter((row) => prefixes.some((p) => String(row.priorId).startsWith(p))) : rows;
const unverdicted = scoped.filter((row) => row.verdict === null || row.verdict === undefined);
const uncarried = scoped.filter(
  (row) => (row.verdict === "open" || row.verdict === "partial") && !row.carriedAs,
);
console.log(`unverdicted: ${unverdicted.length}`);
console.log(`uncarried: ${uncarried.length}`);
process.exit(unverdicted.length > 0 || uncarried.length > 0 ? 1 : 0);
