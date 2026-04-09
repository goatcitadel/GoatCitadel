/* global console */

import fs from "node:fs";

const file = "F:/code/personal-ai/apps/gateway/src/services/gateway-service.ts";
const lines = fs.readFileSync(file, "utf8").split("\n");

function findFunctionStart(funcName, startFrom = 0) {
  for (let i = startFrom; i < lines.length; i++) {
    if (lines[i].startsWith("function " + funcName + "(")) return i;
  }
  return -1;
}

function findFunctionEnd(startIdx) {
  let braceDepth = 0;
  let inFunc = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { braceDepth++; inFunc = true; }
      if (ch === "}") { braceDepth--; }
    }
    if (inFunc && braceDepth === 0) return i;
  }
  return -1;
}

// Block 1: sanitizeFileName through summarizePromptPackRunFailure
const b1Start = findFunctionStart("sanitizeFileName");
const b1End = findFunctionEnd(findFunctionStart("summarizePromptPackRunFailure"));

// Block 2: normalizePromptTestCode through buildPromptPackAutoScoreNotes
const b2Start = findFunctionStart("normalizePromptTestCode");
const b2End = findFunctionEnd(findFunctionStart("buildPromptPackAutoScoreNotes"));

// Block 3: truncateForModelJudge through applyPromptPlaceholderValues
const b3Start = findFunctionStart("truncateForModelJudge");
const b3End = findFunctionEnd(findFunctionStart("applyPromptPlaceholderValues"));

console.log("Block 1:", b1Start + 1, "-", b1End + 1);
console.log("Block 2:", b2Start + 1, "-", b2End + 1);
console.log("Block 3:", b3Start + 1, "-", b3End + 1);

// Verify what comes after each block
console.log("After Block 1:", lines[b1End + 2]?.substring(0, 60));
console.log("After Block 2:", lines[b2End + 2]?.substring(0, 60));
console.log("After Block 3:", lines[b3End + 2]?.substring(0, 60));

const toRemove = new Set();
for (let i = b3Start; i <= b3End; i++) toRemove.add(i);
for (let i = b2Start; i <= b2End; i++) toRemove.add(i);
for (let i = b1Start; i <= b1End; i++) toRemove.add(i);

// Also remove blank line before each block
if (b1Start > 0 && lines[b1Start - 1].trim() === "") toRemove.add(b1Start - 1);
if (b2Start > 0 && lines[b2Start - 1].trim() === "") toRemove.add(b2Start - 1);
if (b3Start > 0 && lines[b3Start - 1].trim() === "") toRemove.add(b3Start - 1);

const filtered = lines.filter((_, idx) => !toRemove.has(idx));
fs.writeFileSync(file, filtered.join("\n"));
console.log("Removed", toRemove.size, "lines. New file:", filtered.length, "lines");
