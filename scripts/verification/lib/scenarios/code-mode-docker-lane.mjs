/**
 * Docker backend proof (#368): pulls the digest-pinned image recorded in
 * baselines/code-mode-docker-proof-image.json, then runs the gated Gateway test that
 * executes an approved Code Mode run through code-mode-docker-launch.ts and re-hashes
 * its artifacts. A skipped proof (no Docker, no image) fails the lane.
 */
export async function runCodeModeDockerProofLane(context, deps) {
  const {
    clampString,
    emptyArtifacts,
    ensureGatewayWorkspaceBuild,
    path,
    pnpmCommand,
    readJson,
    relativeToRun,
    repoRoot,
    runCommand,
    runScenario,
  } = deps;

  await runScenario(
    context,
    {
      id: "code-mode.docker.proof",
      lane: "code-mode-docker",
      title: "Code Mode Docker backend digest-pinned proof",
      subsystem: "gateway",
    },
    async () => {
      const diagnostics = path.join(context.artifactRoot, "diagnostics");
      const pinned = await readJson(
        path.join(repoRoot, "scripts", "verification", "baselines", "code-mode-docker-proof-image.json"),
      );
      const image = typeof pinned?.image === "string" ? pinned.image : "";
      if (!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/u.test(image)) {
        return { status: "failed", error: "Docker proof image must be pinned as name@sha256:<64 hex>." };
      }
      const pull = await runCommand("docker", ["pull", image], {
        cwd: repoRoot,
        artifactRoot: diagnostics,
        logName: "code-mode-docker.pull",
      });
      if (pull.code !== 0) {
        return {
          status: "failed",
          error: clampString(`docker pull ${image} failed: ${pull.stderr || pull.stdout}`, 1200),
          metrics: { image, pullExitCode: pull.code },
        };
      }
      await ensureGatewayWorkspaceBuild(context);
      const result = await runCommand(
        pnpmCommand(),
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "vitest",
          "run",
          "src/services/capability-system-service.test.ts",
          "--maxWorkers=2",
          "-t",
          "docker proof",
        ],
        {
          cwd: repoRoot,
          artifactRoot: diagnostics,
          logName: "code-mode-docker.proof",
          env: { GOATCITADEL_CODE_MODE_DOCKER_PROOF_IMAGE: image },
        },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      const proved = result.code === 0 && /Tests\s+1 passed/u.test(output) && !/1 failed/u.test(output);
      return {
        status: proved ? "passed" : "failed",
        error: proved ? undefined : clampString(output, 1200),
        metrics: { image, exitCode: result.code, durationMs: result.durationMs, proved },
        artifacts: emptyArtifacts({
          logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
        }),
      };
    },
  );
}
