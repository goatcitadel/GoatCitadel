export async function runSecurityEvalsLane(context, deps) {
  const {
    clampString,
    emptyArtifacts,
    path,
    pnpmCommand,
    relativeToRun,
    repoRoot,
    runCommand,
    runScenario,
  } = deps;
  await runScenario(
    context,
    {
      id: "security-evals.defensive-red-team-pack",
      lane: "security-evals",
      title: "Defensive security prompt-pack route and gate evidence",
      subsystem: "security",
    },
    async () => {
      const result = await runCommand(
        pnpmCommand(),
        [
          "--dir",
          "apps/gateway",
          "exec",
          "vitest",
          "run",
          "src/routes/prompt-packs.test.ts",
          "src/services/prompt-pack-service.parser-report.test.ts",
        ],
        {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: "security-evals.defensive-red-team-pack",
        },
      );
      return {
        status: result.code === 0 ? "passed" : "failed",
        error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1200),
        notes: [
          "Covers built-in defensive security prompt-pack listing, explicit import, read-only gates, parser balance, and non-execution posture.",
        ],
        metrics: {
          exitCode: result.code,
          durationMs: result.durationMs,
        },
        artifacts: emptyArtifacts({
          logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
        }),
      };
    },
  );
}
