import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression coverage for CODEX_FINDING #27: the weekly improvement
// replay job samples recent chat turn traces and tool runs (including
// `args_json` / `result_json`) and ships them to the configured LLM
// provider for a model-judge pass. Until a redaction layer lands and
// an explicit operator opt-in is wired up, the shipped config must
// keep this disabled.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// `config/cron-jobs.json` is gitignored and per-deployment; only the
// `*.example.json` template ships with the repo. The example file is the
// security-relevant default — when an operator first runs the gateway
// without a custom cron-jobs.json, the runtime falls back to the example
// values, and we don't want a fresh install to start emitting chat-turn
// telemetry to the LLM provider.
const cronJobsPath = path.resolve(__dirname, "..", "..", "..", "config", "cron-jobs.example.json");

interface CronJobRecord {
  jobId: string;
  enabled: boolean;
}

function loadCronJobs(): { jobs: CronJobRecord[] } {
  return JSON.parse(readFileSync(cronJobsPath, "utf8"));
}

describe("cron-jobs.example.json improvement defaults (codex #27)", () => {
  it("disables self_improvement_weekly_replay by default in the shipped example", () => {
    const config = loadCronJobs();
    const job = config.jobs.find((entry) => entry.jobId === "self_improvement_weekly_replay");
    expect(job, "self_improvement_weekly_replay entry missing from cron-jobs.example.json").toBeDefined();
    expect(job?.enabled).toBe(false);
  });
});
