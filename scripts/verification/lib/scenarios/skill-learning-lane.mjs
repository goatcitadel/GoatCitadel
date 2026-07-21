import fs from "node:fs/promises";

export async function runSkillLearningLane(context, _options, deps) {
  const {
    clampString,
    emptyArtifacts,
    path,
    pnpmCommand,
    relativeToRun,
    repoRoot,
    runCommand,
    runScenario,
    writeJson,
  } = deps;
  const currentDependencyMigrationHeads = deps.readSkillLearningMigrationHeads
    ? await deps.readSkillLearningMigrationHeads()
    : await readMigrationHeads(repoRoot, path);

  const proofMatrixPath = path.join(context.artifactRoot, "diagnostics", "skill-learning-proof-matrix.json");
  await runScenario(
    context,
    {
      id: "skill-learning.proof-matrix",
      lane: "skill-learning",
      title: "Governed correction-to-candidate learning invariant matrix",
      subsystem: "capabilities",
    },
    async () => {
      await writeJson(proofMatrixPath, {
        generatedAt: new Date().toISOString(),
        migrationChange: "none",
        featureMigrationPair: { sqlite: 161, postgres: 103 },
        currentDependencyMigrationHeads,
        postgresProofConfigured: Boolean(process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim()),
        invariants: [
          "only an explicitly authenticated /learn into candidate skill action or selected /learn apply history action records correction evidence",
          "canonical Gateway Chat storage supplies exact source and correction bytes, SHA-256 hashes, actor, session, turn, workspace revision, and effective config revision provenance",
          "history discovery is a bounded dry-run with an immutable high-water, resumable cursor, explicit selection token, and independent workspace/config revision CAS",
          "model, tool, browser, foreign-actor, secret-like, conflicting, malformed, and noncanonical evidence fails closed or remains quarantined",
          "three distinct clean sessions cause exactly one eligibility transition; later or same-session evidence links without creating another version",
          "staged artifacts are immutable, inactive, governed-lineage candidates with an inspectable proposal and Journey event",
          "learning never writes durable memory and never directly activates a callable skill",
          "artifact writes and replay reads reject managed-root, parent, directory, and file symlink substitution",
          "Code Mode candidate writes include governed workspace, exact source fingerprint, and creating-actor lineage",
          "Library repositories retain candidate, evidence-link, proposal, and Journey inspection truth while Chat returns one canonical result",
        ],
      });
      return {
        status: "passed",
        artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, proofMatrixPath)] }),
      };
    },
  );

  const commands = [
    {
      id: "skill-learning.contracts",
      title: "Correction provenance, permission envelope, and poisoning assessment contracts",
      subsystem: "contracts",
      args: ["--filter", "@goatcitadel/contracts", "exec", "vitest", "run", "src/skill-governance.test.ts"],
    },
    {
      id: "skill-learning.storage",
      title: "Evidence, recurrence, candidate lineage, evidence links, Journey, and schema parity",
      subsystem: "storage",
      args: [
        "--filter",
        "@goatcitadel/storage",
        "exec",
        "tsx",
        "--test",
        "src/skill-learning-evidence-repo.test.ts",
        "src/candidate-skill-version-repo.test.ts",
        "src/governance-journey-event-repo.test.ts",
      ],
    },
    {
      id: "skill-learning.schema",
      title: "Frozen SQLite 161 and PostgreSQL 103 skill-governance schema pair",
      subsystem: "storage",
      args: [
        "--filter",
        "@goatcitadel/storage",
        "exec",
        "tsx",
        "--test",
        "--test-name-pattern",
        "pairs forward-only SQLite 161 with PostgreSQL 103",
        "src/skill-governance-schema-parity.test.ts",
      ],
    },
    {
      id: "skill-learning.gateway",
      title: "Explicit Chat learning, history workshop, immutable artifacts, and replay guards",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/skill-learning-service.test.ts",
        "src/services/chat-command-service.runtime.test.ts",
      ],
    },
    {
      id: "skill-learning.code-mode-lineage",
      title: "Post-161 governed Code Mode candidate lineage",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/capability-system-service.test.ts",
        "-t",
        "stages a candidate bundle after approval|links Code Mode candidate bundles",
      ],
    },
    {
      id: "skill-learning.typecheck",
      title: "Learning contract, persistence, Gateway, and Chat boundaries",
      subsystem: "capabilities",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "--filter",
        "@goatcitadel/storage",
        "--filter",
        "@goatcitadel/gateway",
        "typecheck",
      ],
    },
  ];

  for (const command of commands) {
    await runScenario(
      context,
      {
        id: command.id,
        lane: "skill-learning",
        title: command.title,
        subsystem: command.subsystem,
      },
      async () => {
        const result = await runCommand(pnpmCommand(), command.args, {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: command.id,
        });
        return {
          status: result.code === 0 ? "passed" : "failed",
          error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1_500),
          metrics: { exitCode: result.code, durationMs: result.durationMs },
          artifacts: emptyArtifacts({
            logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
          }),
        };
      },
    );
  }

  await runScenario(
    context,
    {
      id: "skill-learning.postgres",
      lane: "skill-learning",
      title: "Real PostgreSQL governed skill-learning persistence proof",
      subsystem: "storage-postgres",
    },
    async () => {
      if (!process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim()) {
        return {
          status: "skipped",
          notes: ["Set GOATCITADEL_TEST_POSTGRES_URL to execute the real PostgreSQL proof."],
          artifacts: emptyArtifacts(),
        };
      }
      const result = await runCommand(pnpmCommand(), ["--filter", "@goatcitadel/storage", "test:postgres"], {
        cwd: repoRoot,
        artifactRoot: path.join(context.artifactRoot, "diagnostics"),
        logName: "skill-learning.postgres",
      });
      return {
        status: result.code === 0 ? "passed" : "failed",
        error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1_500),
        metrics: { exitCode: result.code, durationMs: result.durationMs },
        artifacts: emptyArtifacts({
          logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
        }),
      };
    },
  );
}

async function readMigrationHeads(repoRoot, path) {
  const [sqliteSource, postgresSource] = await Promise.all([
    fs.readFile(path.join(repoRoot, "packages", "storage", "src", "sqlite.ts"), "utf8"),
    fs.readFile(path.join(repoRoot, "packages", "storage", "src", "postgres", "migrations.ts"), "utf8"),
  ]);
  return {
    sqlite: maxDeclaredMigrationVersion(sqliteSource, "SQLite"),
    postgres: maxDeclaredMigrationVersion(postgresSource, "PostgreSQL"),
  };
}

function maxDeclaredMigrationVersion(source, label) {
  const versions = [...source.matchAll(/\bversion:\s*(\d+)\b/gu)].map((match) => Number(match[1]));
  if (versions.length === 0 || versions.some((version) => !Number.isSafeInteger(version) || version < 1)) {
    throw new Error(`${label} migration head could not be resolved.`);
  }
  return Math.max(...versions);
}
