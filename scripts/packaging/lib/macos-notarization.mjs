import { spawnSync } from "node:child_process";

const SUBMISSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function notarizeMacDmg(dmgPath, { appleId, teamId, password, cwd, spawn = spawnSync }) {
  const receipt = runXcrun("notarytool", "submit", [
    dmgPath, "--apple-id", appleId, "--team-id", teamId, "--password", password, "--wait", "--output-format", "json",
  ], cwd, spawn);
  let submission;
  try {
    submission = JSON.parse(receipt);
  } catch {
    throw new Error("Apple notarization did not return a JSON receipt.");
  }
  const id = typeof submission?.id === "string" && SUBMISSION_ID.test(submission.id) ? submission.id : undefined;
  if (submission?.status !== "Accepted" || !id) {
    throw new Error(id ? `Apple did not accept notarization submission ${id}.` : "Apple notarization acceptance could not be verified.");
  }
  runXcrun("stapler", "staple", [dmgPath], cwd, spawn);
  runXcrun("stapler", "validate", [dmgPath], cwd, spawn);
  return id;
}

function runXcrun(tool, operation, args, cwd, spawn) {
  const result = spawn("xcrun", [tool, operation, ...args], { cwd, encoding: "utf8" });
  // Spawn failures and tool output can include the original credential-bearing arguments.
  if (result.error || result.status !== 0) {
    const detail = Number.isInteger(result.status) ? ` (exit ${result.status})` : "";
    throw new Error(`xcrun ${tool} ${operation} failed${detail}.`);
  }
  return result.stdout;
}
