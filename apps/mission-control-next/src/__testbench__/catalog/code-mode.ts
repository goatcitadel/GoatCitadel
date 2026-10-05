import type { CodeModeRunStatus } from "@goatcitadel/contracts";
import { resolveApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { createCodeModeRun, fetchCodeModeRun } from "@goatcitadel/mission-control-shared/api/capabilities";
import { ensure, pass, waitFor } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { sha256Hex } from "./context";

const TRUSTED_SOURCE = "return { ok: true };";
const TERMINAL_STATUSES: ReadonlySet<CodeModeRunStatus> = new Set<CodeModeRunStatus>([
  "completed",
  "failed",
  "rejected",
  "expired",
]);

export const codeModeChecks: readonly CheckDef[] = [
  {
    id: "code-mode.run",
    kind: "journey",
    domain: "code-mode",
    title: "Governed Code Mode run",
    tier: "host",
    timeoutMs: 120_000,
    description:
      "Runs the fixed snippet `return { ok: true };` on this machine after approving it. Code Mode runs trusted code; it is not a hostile-code sandbox.",
    routes: [
      "POST /api/v1/code-mode/runs",
      "POST /api/v1/approvals/:approvalId/resolve",
      "GET /api/v1/code-mode/runs/:runId",
    ],
    steps: ["Create run", "Approve the run", "Run finishes", "Code hashes match the snippet"],
    async run(ctx) {
      const created = await ctx.step("Create run", () =>
        createCodeModeRun({ language: "javascript", source: TRUSTED_SOURCE }),
      );
      const approvalId = created.approvalId;
      ensure(created.status === "approval_pending" && approvalId, "The run did not wait for approval.", created);
      await ctx.step("Approve the run", () => resolveApproval(approvalId, "approve"));
      const finished = await ctx.step("Run finishes", () =>
        waitFor(
          () => fetchCodeModeRun(created.runId),
          (run) => TERMINAL_STATUSES.has(run.status),
          { signal: ctx.signal, timeoutMs: 90_000, intervalMs: 1_000, label: "The Code Mode run finishing" },
        ),
      );
      const sandbox = finished.sandbox;
      if (finished.status === "failed" && sandbox?.required === true && !sandbox.available) {
        // The gateway refused to run without an isolation runner on this machine: correct behavior, not a fault.
        return {
          status: "blocked",
          summary: `No usable Code Mode isolation runner on this machine (${sandbox.checksFailed.join(", ") || "no reason given"}); the gateway failed closed as designed.`,
          evidence: sandbox,
        };
      }
      ensure(
        finished.status === "completed",
        `The run ended ${finished.status}${finished.error ? `: ${finished.error}` : ""}.`,
        finished,
      );
      await ctx.step("Code hashes match the snippet", async () => {
        // The approved hash and the stored source artifact must both be the bytes of the snippet this check sent.
        const expected = await sha256Hex(TRUSTED_SOURCE);
        ensure(finished.codeHash === expected, "The run's code hash is not the SHA-256 of the approved snippet.", {
          codeHash: finished.codeHash,
          expected,
        });
        ensure(
          finished.codeArtifact.sha256 === expected,
          "The stored code artifact is not the snippet that was approved.",
          { codeArtifact: finished.codeArtifact, expected },
        );
      });
      return pass(`Run ${created.runId} completed; code artifact ${finished.codeArtifact.sha256.slice(0, 12)}….`);
    },
  },
];
