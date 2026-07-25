export async function runVertexFireworksProvidersLane(context, _options, deps) {
  const { emptyArtifacts, path, relativeToRun, runScenario, writeJson } = deps;

  const proofMatrixPath = path.join(context.artifactRoot, "diagnostics", "vertex-fireworks-proof-matrix.json");
  await runScenario(
    context,
    {
      id: "providers-vertex-fireworks.proof-matrix",
      lane: "providers-vertex-fireworks",
      title: "Vertex AI and Fireworks provider invariant proof matrix",
      subsystem: "providers",
    },
    async () => {
      await writeJson(proofMatrixPath, {
        generatedAt: new Date().toISOString(),
        migrationChange: "none",
        vertexFireworksFeatureDependencyMigrations: { sqlite: 160, postgres: 102 },
        invariants: [
          "Vertex authentication is Gateway-owned and supports service-account JSON plus ADC without returning credential material",
          "ADC admission is based on bounded credential-source inspection, not auth mode; file rotation is immediate and metadata proof expires",
          "Vertex requests use the canonical regional endpoint and Bearer access token after bounded credential exchange",
          "Vertex reasoning advertises and sends only low, medium, or high; Chat off omits reasoning_effort and no Google thinking_config is mixed in",
          "Fireworks uses the canonical OpenAI-compatible endpoint with complete, SSE stream, tool, parallel-tool, error, metadata, routing, and cost coverage",
          "Fireworks sends context_length_exceeded_behavior error so provider-side context truncation cannot be silent",
          "Provider responses never project private reasoning fields into the public Chat answer",
        ],
      });
      return {
        status: "passed",
        artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, proofMatrixPath)] }),
      };
    },
  );

  await runOwnedCommands(context, "providers-vertex-fireworks", providerCommands(), deps);
}

export async function runReasoningProfilesLane(context, _options, deps) {
  const { emptyArtifacts, path, relativeToRun, runScenario, writeJson } = deps;

  const proofMatrixPath = path.join(context.artifactRoot, "diagnostics", "reasoning-profiles-proof-matrix.json");
  await runScenario(
    context,
    {
      id: "reasoning-profiles.proof-matrix",
      lane: "reasoning-profiles",
      title: "Requested-versus-actual reasoning profile invariant matrix",
      subsystem: "reasoning",
    },
    async () => {
      await writeJson(proofMatrixPath, {
        generatedAt: new Date().toISOString(),
        migrationChange: "none",
        invariants: [
          "max and ultra are selectable only through explicit provider or model capability metadata",
          "unsupported direct combinations fail before provider dispatch",
          "only typed fallback calls may downgrade and they select the nearest lower supported effort",
          "requested, actual, provider wire effort, disposition, reason code, and capability source remain inspectable",
          "requested and dispatched reasoning truth persists in canonical model-usage records with provider and credential attribution",
          "private chain-of-thought fields are stripped while one public answer remains visible",
          "Chat off through ultra values preserve their typed contract from composer and route boundary to provider dispatch",
        ],
      });
      return {
        status: "passed",
        artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, proofMatrixPath)] }),
      };
    },
  );

  await runOwnedCommands(context, "reasoning-profiles", reasoningCommands(), deps);
}

async function runOwnedCommands(context, lane, commands, deps) {
  const { clampString, emptyArtifacts, path, pnpmCommand, relativeToRun, repoRoot, runCommand, runScenario } = deps;
  for (const command of commands) {
    await runScenario(
      context,
      {
        id: command.id,
        lane,
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
}

function providerCommands() {
  return [
    {
      id: "providers-vertex-fireworks.contracts",
      title: "Governed provider templates and model catalog contracts",
      subsystem: "contracts",
      args: ["--filter", "@goatcitadel/contracts", "exec", "vitest", "run", "src/provider-templates.test.ts"],
    },
    {
      id: "providers-vertex-fireworks.gateway",
      title: "Vertex auth and Vertex/Fireworks complete, stream, tools, errors, metadata, and cost",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/google-cloud-auth-service.test.ts",
        "src/services/llm-service.vertex-fireworks.test.ts",
        "src/services/llm-model-metadata.test.ts",
        "src/services/llm-pricing.test.ts",
        "src/services/llm-provider-advice-service.test.ts",
        "src/routes/llm.test.ts",
      ],
    },
    {
      id: "providers-vertex-fireworks.surface",
      title: "Secret-free Vertex and Fireworks settings projection",
      subsystem: "mission-control-next",
      args: [
        "--filter",
        "@goatcitadel/mission-control-next",
        "exec",
        "vitest",
        "run",
        "src/features/native-routes/SettingsNativePage.helpers.test.ts",
      ],
    },
    {
      id: "providers-vertex-fireworks.typecheck",
      title: "Provider contract, Gateway, shared API, and settings surface boundaries",
      subsystem: "providers",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "--filter",
        "@goatcitadel/gateway",
        "--filter",
        "@goatcitadel/mission-control-shared",
        "--filter",
        "@goatcitadel/mission-control-next",
        "typecheck",
      ],
    },
  ];
}

function reasoningCommands() {
  return [
    {
      id: "reasoning-profiles.gateway",
      title: "Reasoning resolution, durable attribution, Chat mapping, and route propagation",
      subsystem: "gateway",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/llm-reasoning-profile.test.ts",
        "src/services/llm-service.reasoning-usage.test.ts",
        "src/services/chat-reasoning-controls.test.ts",
        "src/routes/chat.messages.test.ts",
      ],
    },
    {
      id: "reasoning-profiles.typecheck",
      title: "Reasoning contract, persistence, runtime, and canonical Chat surface boundaries",
      subsystem: "reasoning",
      args: [
        "--filter",
        "@goatcitadel/contracts",
        "--filter",
        "@goatcitadel/storage",
        "--filter",
        "@goatcitadel/gateway",
        "--filter",
        "@goatcitadel/mission-control-shared",
        "--filter",
        "@goatcitadel/threaded-surface-core",
        "--filter",
        "@goatcitadel/mission-control-next",
        "typecheck",
      ],
    },
  ];
}
