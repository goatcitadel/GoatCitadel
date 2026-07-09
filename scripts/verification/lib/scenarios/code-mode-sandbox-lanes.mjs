import fs from "node:fs/promises";

export async function runCodeModeSandboxRequiredLane(context, deps) {
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
      id: "code-mode.sandbox.required",
      lane: "code-mode-sandbox",
      title: "Code Mode sandbox metadata/fail-closed proof",
      subsystem: "gateway",
    },
    async () => {
      await ensureGatewayWorkspaceBuild(context);
      const proofPath = path.join(context.artifactRoot, "diagnostics", "code-mode-sandbox-required.json");
      const result = await runCommand(
        pnpmCommand(),
        ["--filter", "@goatcitadel/gateway", "exec", "tsx", "src/code-mode-sandbox-proof.ts", "--output", proofPath],
        {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: "code-mode-sandbox.required",
          env: {
            GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
            GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "true",
            GOATCITADEL_CODE_MODE_BEST_EFFORT_SANDBOX_ENABLED: "true",
            GOATCITADEL_ROOT_DIR: repoRoot,
          },
        },
      );
      const proof = await readJson(proofPath).catch(() => undefined);
      const failClosedProof =
        result.code !== 0 &&
        proof?.sandboxRequired === true &&
        proof?.sandboxAvailable === false &&
        typeof proof?.metadata?.failClosedReason === "string" &&
        proof.metadata.failClosedReason.length > 0;
      return {
        status: result.code === 0 || failClosedProof ? "passed" : "failed",
        error: result.code === 0 || failClosedProof ? undefined : clampString(result.stderr || result.stdout, 1200),
        metrics: {
          exitCode: result.code,
          durationMs: result.durationMs,
          sandboxRequired: proof?.sandboxRequired,
          sandboxAvailable: proof?.sandboxAvailable,
          failClosedProof,
          checksPassed: proof?.metadata?.checksPassed?.length,
          checksFailed: proof?.metadata?.checksFailed?.length,
        },
        artifacts: emptyArtifacts({
          diagnostics: proof ? [relativeToRun(context, proofPath)] : [],
          logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
        }),
      };
    },
  );
}

export async function runCodeModeHostileSandboxLane(context, deps) {
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
    writeJson,
  } = deps;

  await runScenario(
    context,
    {
      id: "code-mode.hostile-sandbox.promotion-gate",
      lane: "code-mode-hostile-sandbox",
      title: "Code Mode hostile-code sandbox claim stays gated by native adversarial canaries",
      subsystem: "gateway",
    },
    async () => {
      await ensureGatewayWorkspaceBuild(context);
      const requiredCanaries = [
        "outside_root_read_denied",
        "outside_root_write_denied",
        "network_denied",
        "env_secret_absent",
        "symlink_path_traversal_denied",
        "process_job_limits_enforced",
        "artifact_hash_integrity",
        "fail_closed_required_mode",
      ];
      const files = {
        contracts: path.join(repoRoot, "packages", "contracts", "src", "capabilities.ts"),
        sandboxTypes: path.join(repoRoot, "apps", "gateway", "src", "services", "code-mode-sandbox", "types.ts"),
        linux: path.join(repoRoot, "apps", "gateway", "src", "services", "code-mode-sandbox", "linux-firejail-adapter.ts"),
        darwin: path.join(repoRoot, "apps", "gateway", "src", "services", "code-mode-sandbox", "darwin-seatbelt-adapter.ts"),
        win32: path.join(repoRoot, "apps", "gateway", "src", "services", "code-mode-sandbox", "windows-appcontainer-adapter.ts"),
      };
      const contents = Object.fromEntries(
        await Promise.all(Object.entries(files).map(async ([key, filePath]) => [key, await fs.readFile(filePath, "utf8")])),
      );
      const issues = [];
      const proofPath = path.join(context.artifactRoot, "diagnostics", "code-mode-hostile-sandbox-proof.json");
      const result = await runCommand(
        pnpmCommand(),
        [
          "--filter",
          "@goatcitadel/gateway",
          "exec",
          "tsx",
          "src/code-mode-hostile-sandbox-proof.ts",
          "--output",
          proofPath,
        ],
        {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: "code-mode-hostile-sandbox.proof",
          env: {
            GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
            GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "true",
            GOATCITADEL_CODE_MODE_BEST_EFFORT_SANDBOX_ENABLED: "true",
            GOATCITADEL_ROOT_DIR: repoRoot,
          },
        },
      );
      const proof = await readJson(proofPath).catch(() => undefined);
      for (const canary of requiredCanaries) {
        if (!contents.contracts.includes(canary) || !contents.sandboxTypes.includes(canary)) {
          issues.push(`Missing hostile sandbox canary metadata: ${canary}`);
        }
      }
      if (!contents.sandboxTypes.includes("buildHostileSandboxClaimMetadata") || !contents.sandboxTypes.includes("publicClaimAllowed")) {
        issues.push("Hostile sandbox claim metadata must keep explicit proof aggregation and public-claim gating.");
      }
      for (const [platform, needle] of [
        ["linux", "firejail"],
        ["darwin", "sandbox-exec"],
        ["win32", "AppContainer"],
      ]) {
        if (!contents[platform].toLowerCase().includes(String(needle).toLowerCase())) {
          issues.push(`Missing native ${platform} sandbox adapter evidence for ${needle}.`);
        }
      }
      if (!contents.linux.includes("--rlimit-nproc=1") || !contents.linux.includes("rlimit-nproc 1")) {
        issues.push("Linux Firejail hostile proof must include process limit enforcement.");
      }
      if (contents.darwin.includes("(allow process*)")) {
        issues.push("macOS Seatbelt hostile proof must not allow broad process operations.");
      }
      if (!contents.win32.includes("GetStdHandle") || !contents.win32.includes("STARTF_USESTDHANDLES")) {
        issues.push("Windows AppContainer stdio JSON-RPC launcher must preserve inherited std handles.");
      }
      if (
        !contents.win32.includes("code-mode-harness.mjs") ||
        !contents.win32.includes("GrantFileAccess(nodePath, sid") ||
        !contents.win32.includes("GrantFileAccess(harnessPath, sid")
      ) {
        issues.push(
          "Windows AppContainer launcher must stage the harness in the workspace and grant explicit SID access only to staged executable inputs.",
        );
      }
      if (!proof) {
        issues.push("Hostile sandbox proof CLI did not write a proof artifact.");
      } else {
        for (const canary of requiredCanaries) {
          if (!proof.claim?.requiredCanaries?.includes(canary)) {
            issues.push(`Hostile sandbox proof omitted required canary: ${canary}`);
          }
        }
        if (proof.claim?.publicClaimAllowed === true) {
          const allPlatformProofsPass = proof.claim.platformProof?.every(
            (item) =>
              item.status === "pass" &&
              requiredCanaries.every((canary) => item.checksPassed?.includes(canary)) &&
              (item.checksFailed?.length ?? 0) === 0,
          );
          if (!allPlatformProofsPass) {
            issues.push("Hostile sandbox public claim was allowed without a complete green platform matrix.");
          }
        }
        if (proof.claim?.platformClaims?.win32?.publicClaimAllowed === true) {
          const win32Proof = proof.claim.platformClaims.win32.proof;
          const win32ProofPasses =
            win32Proof?.status === "pass" &&
            requiredCanaries.every((canary) => win32Proof.checksPassed?.includes(canary)) &&
            (win32Proof.checksFailed?.length ?? 0) === 0;
          if (!win32ProofPasses) {
            issues.push("Windows hostile sandbox public claim was allowed without green Windows canary proof.");
          }
        }
        if (proof.sandboxAvailable && proof.currentPlatformProof?.status !== "pass") {
          issues.push(
            `Available native hostile sandbox failed canaries: ${
              proof.currentPlatformProof?.checksFailed?.join(", ") || "unknown"
            }`,
          );
        }
      }
      if (result.code !== 0 && (!proof || proof.sandboxAvailable)) {
        issues.push(clampString(result.stderr || result.stdout, 1200));
      }
      const artifactPath = path.join(context.artifactRoot, "diagnostics", "code-mode-hostile-sandbox.json");
      await writeJson(artifactPath, {
        checkedAt: new Date().toISOString(),
        claimStatus: proof?.claim?.claimStatus ?? "not_promoted",
        requiredCanaries,
        files,
        issues,
        proofRef: proof ? relativeToRun(context, proofPath) : undefined,
        currentPlatform: proof?.platform,
        currentPlatformProofStatus: proof?.currentPlatformProof?.status,
        publicClaimAllowed: proof?.claim?.publicClaimAllowed ?? false,
        windowsPublicClaimAllowed: proof?.claim?.platformClaims?.win32?.publicClaimAllowed ?? false,
        windowsPlatformProofStatus: proof?.claim?.platformClaims?.win32?.proof?.status ?? "missing",
        platformClaims: proof?.claim?.platformClaims,
      });
      return {
        status: issues.length ? "failed" : "passed",
        error: issues.length ? issues.join("\n") : undefined,
        metrics: {
          canaries: requiredCanaries.length,
          issues: issues.length,
          exitCode: result.code,
          currentPlatform: proof?.platform,
          currentPlatformProofStatus: proof?.currentPlatformProof?.status,
          checksPassed: proof?.currentPlatformProof?.checksPassed?.length,
          checksFailed: proof?.currentPlatformProof?.checksFailed?.length,
          publicClaimAllowed: proof?.claim?.publicClaimAllowed ?? false,
          windowsPublicClaimAllowed: proof?.claim?.platformClaims?.win32?.publicClaimAllowed ?? false,
          windowsPlatformProofStatus: proof?.claim?.platformClaims?.win32?.proof?.status ?? "missing",
        },
        artifacts: emptyArtifacts({
          diagnostics: [
            relativeToRun(context, artifactPath),
            ...(proof ? [relativeToRun(context, proofPath)] : []),
          ],
          logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
        }),
      };
    },
  );
}
