import type {
  CodeModeExecutionBackendRecord,
  CodeModeExecutionBackendsResponse,
  CodeModeRunExecutionBackendRef,
  CodeModeSandboxMetadata,
} from "@goatcitadel/contracts";
import type { CodeModeDockerBackendConfig } from "../config.js";

export const CODE_MODE_HOST_BACKEND_ID = "trusted-code-host";
export const CODE_MODE_DOCKER_BACKEND_ID = "docker-container";
export const CODE_MODE_AIDER_ADAPTER_ID = "aider-cli-adapter";

export function buildCodeModeExecutionBackends(input: {
  codeModeEnabled: boolean;
  sandbox: CodeModeSandboxMetadata;
  dockerBackend?: CodeModeDockerBackendConfig;
  env?: NodeJS.ProcessEnv;
}): CodeModeExecutionBackendsResponse {
  const host = buildTrustedCodeHostBackend(input.codeModeEnabled, input.sandbox);
  const docker = buildDockerBackend(input.codeModeEnabled, input.dockerBackend, input.env ?? process.env);
  const aider = buildAiderPreviewAdapter(input.env ?? process.env);
  const activeBackendId = docker.callable ? docker.backendId : host.backendId;
  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    mutationSemantics: "none",
    defaultBackendId: CODE_MODE_HOST_BACKEND_ID,
    activeBackendId,
    items: [host, docker, aider],
  };
}

export function buildCodeModeRunExecutionBackendRef(
  sandbox: CodeModeSandboxMetadata,
  options: { dockerBackend?: CodeModeDockerBackendConfig } = {},
): CodeModeRunExecutionBackendRef {
  const docker = buildDockerBackend(true, options.dockerBackend, process.env);
  if (docker.callable) {
    return {
      backendId: docker.backendId,
      kind: docker.kind,
      label: docker.label,
      status: docker.status,
      runtimeSupport: docker.runtimeSupport,
      isolationProfile: "docker/stdout-jsonrpc/no_network",
    };
  }
  const host = buildTrustedCodeHostBackend(true, sandbox);
  return {
    backendId: host.backendId,
    kind: host.kind,
    label: host.label,
    status: host.status,
    runtimeSupport: host.runtimeSupport,
    isolationProfile: sandbox.isolationProfile,
  };
}

function buildTrustedCodeHostBackend(
  codeModeEnabled: boolean,
  sandbox: CodeModeSandboxMetadata,
): CodeModeExecutionBackendRecord {
  const blocked = !codeModeEnabled || (sandbox.required && !sandbox.available);
  return {
    backendId: CODE_MODE_HOST_BACKEND_ID,
    kind: "host",
    label: "Trusted-code host runner",
    status: blocked ? "blocked" : "active",
    runtimeSupport: blocked ? "not_available" : "active_runner",
    isolationProfile: sandbox.isolationProfile,
    default: true,
    callable: !blocked,
    description: "Current governed Code Mode runner using host sandbox posture and immutable artifact checks.",
    blockers: [
      ...(!codeModeEnabled ? ["Code Mode v1 is disabled."] : []),
      ...(sandbox.required && !sandbox.available
        ? [sandbox.failClosedReason ?? "Required Code Mode sandbox is unavailable."]
        : []),
    ],
    governance: [
      "Requires explicit Code Mode approval before execution.",
      "Revalidates source, wrapper manifest, policy snapshot, and sandbox posture before launch.",
      "This is trusted-code execution and does not claim hostile-code sandboxing.",
    ],
    evidence: {
      sandbox,
    },
  };
}

function buildDockerBackend(
  codeModeEnabled: boolean,
  dockerBackend: CodeModeDockerBackendConfig | undefined,
  env: NodeJS.ProcessEnv,
): CodeModeExecutionBackendRecord {
  const envFlag = "GOATCITADEL_CODE_MODE_DOCKER_BACKEND_ENABLED";
  const enabled = dockerBackend?.enabled ?? isTruthyEnv(env[envFlag]);
  const image = dockerBackend?.image?.trim();
  const callable = codeModeEnabled && enabled && Boolean(image);
  return {
    backendId: CODE_MODE_DOCKER_BACKEND_ID,
    kind: "docker",
    label: "Docker execution backend",
    status: callable ? "available" : "preview",
    runtimeSupport: callable ? "active_runner" : "preview_only",
    default: false,
    callable,
    description: callable
      ? "Configured container backend for approved Code Mode runs using stdio JSON-RPC transport."
      : "Planned container backend for Code Mode runs after policy, artifact, and approval parity is wired.",
    blockers: [
      ...(!codeModeEnabled ? ["Code Mode v1 is disabled."] : []),
      ...(!enabled ? ["Docker backend is not enabled."] : []),
      ...(codeModeEnabled && enabled && !image
        ? ["Docker backend is enabled but no container image is configured."]
        : []),
    ],
    governance: [
      "Must preserve deny-wins policy, path jails, approval linkage, immutable artifact hashes, and runtime truth.",
      "Must not replace auth, approvals, or operator-visible sandbox posture.",
      ...(callable ? ["Experimental: uses the configured local Docker daemon and a run-temp bind mount."] : []),
    ],
    evidence: {
      envFlag: enabled ? `${envFlag}=true` : envFlag,
      ...(dockerBackend?.dockerCommand ? { detectedCommand: dockerBackend.dockerCommand } : {}),
    },
  };
}

function buildAiderPreviewAdapter(env: NodeJS.ProcessEnv): CodeModeExecutionBackendRecord {
  const envFlag = "GOATCITADEL_CODE_MODE_AIDER_ADAPTER_ENABLED";
  const requested = isTruthyEnv(env[envFlag]);
  return {
    backendId: CODE_MODE_AIDER_ADAPTER_ID,
    kind: "aider_adapter",
    label: "Aider CLI adapter",
    status: "preview",
    runtimeSupport: "preview_only",
    adapterForBackendId: CODE_MODE_DOCKER_BACKEND_ID,
    default: false,
    callable: false,
    description: "Planned adapter for routing approved Code Mode tasks into Aider-compatible workflows.",
    blockers: [
      "Aider invocation planner and result envelope contract exist, but the adapter is not connected to Code Mode run creation, Docker execution, or artifact ingestion yet.",
      "No replay-safe patch application runner has been promoted.",
    ],
    governance: [
      "Must retain explicit approvals and immutable run evidence.",
      "Must surface generated diffs/artifacts through the Code Mode ledger before any callable exposure.",
    ],
    evidence: {
      envFlag: requested ? `${envFlag}=true` : envFlag,
    },
  };
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}
