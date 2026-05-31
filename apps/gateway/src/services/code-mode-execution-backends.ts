import type {
  CodeModeExecutionBackendRecord,
  CodeModeExecutionBackendsResponse,
  CodeModeRunExecutionBackendRef,
  CodeModeSandboxMetadata,
} from "@goatcitadel/contracts";
import type { CodeModeAiderAdapterConfig, CodeModeDockerBackendConfig } from "../config.js";

export const CODE_MODE_HOST_BACKEND_ID = "trusted-code-host";
export const CODE_MODE_DOCKER_BACKEND_ID = "docker-container";
export const CODE_MODE_AIDER_ADAPTER_ID = "aider-cli-adapter";

export function buildCodeModeExecutionBackends(input: {
  codeModeEnabled: boolean;
  sandbox: CodeModeSandboxMetadata;
  dockerBackend?: CodeModeDockerBackendConfig;
  aiderAdapter?: CodeModeAiderAdapterConfig;
  env?: NodeJS.ProcessEnv;
}): CodeModeExecutionBackendsResponse {
  const host = buildTrustedCodeHostBackend(input.codeModeEnabled, input.sandbox);
  const docker = buildDockerBackend(input.codeModeEnabled, input.dockerBackend, input.env ?? process.env);
  const aider = buildAiderAdapter(input.codeModeEnabled, docker, input.aiderAdapter, input.env ?? process.env);
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
  options: {
    dockerBackend?: CodeModeDockerBackendConfig;
    aiderAdapter?: CodeModeAiderAdapterConfig;
    requestedBackendId?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): CodeModeRunExecutionBackendRef {
  const docker = buildDockerBackend(true, options.dockerBackend, options.env ?? process.env);
  const aider = buildAiderAdapter(true, docker, options.aiderAdapter, options.env ?? process.env);
  if (options.requestedBackendId === CODE_MODE_AIDER_ADAPTER_ID) {
    if (!aider.callable) {
      throw new Error(aider.blockers[0] ?? "Aider Code Mode adapter is not callable.");
    }
    return {
      backendId: aider.backendId,
      kind: aider.kind,
      label: aider.label,
      status: aider.status,
      runtimeSupport: aider.runtimeSupport,
      adapterForBackendId: CODE_MODE_DOCKER_BACKEND_ID,
      isolationProfile: "docker/aider-audit/no_operator_workspace",
    };
  }
  if (options.requestedBackendId === CODE_MODE_DOCKER_BACKEND_ID && !docker.callable) {
    throw new Error(docker.blockers[0] ?? "Docker Code Mode execution backend is not callable.");
  }
  if (options.requestedBackendId === CODE_MODE_HOST_BACKEND_ID) {
    const host = buildTrustedCodeHostBackend(true, sandbox);
    if (!host.callable) {
      throw new Error(host.blockers[0] ?? "Trusted-code host runner is not callable.");
    }
    return {
      backendId: host.backendId,
      kind: host.kind,
      label: host.label,
      status: host.status,
      runtimeSupport: host.runtimeSupport,
      isolationProfile: sandbox.isolationProfile,
    };
  }
  if (options.requestedBackendId && options.requestedBackendId !== CODE_MODE_DOCKER_BACKEND_ID) {
    throw new Error(`Code Mode execution backend ${options.requestedBackendId} is not available.`);
  }
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

function buildAiderAdapter(
  codeModeEnabled: boolean,
  docker: CodeModeExecutionBackendRecord,
  aiderAdapter: CodeModeAiderAdapterConfig | undefined,
  env: NodeJS.ProcessEnv,
): CodeModeExecutionBackendRecord {
  const envFlag = "GOATCITADEL_CODE_MODE_AIDER_ADAPTER_ENABLED";
  const enabled = aiderAdapter?.enabled ?? isTruthyEnv(env[envFlag]);
  const image = aiderAdapter?.image?.trim();
  const callable = codeModeEnabled && enabled && docker.callable && Boolean(image);
  return {
    backendId: CODE_MODE_AIDER_ADAPTER_ID,
    kind: "aider_adapter",
    label: "Aider CLI adapter",
    status: callable ? "available" : "preview",
    runtimeSupport: callable ? "active_runner" : "preview_only",
    adapterForBackendId: CODE_MODE_DOCKER_BACKEND_ID,
    default: false,
    callable,
    description: callable
      ? "Configured Docker-backed Aider adapter for approved audit-only Code Mode runs."
      : "Planned adapter for routing approved Code Mode tasks into Aider-compatible workflows.",
    blockers: [
      ...(!codeModeEnabled ? ["Code Mode v1 is disabled."] : []),
      ...(!enabled ? ["Aider adapter is not enabled."] : []),
      ...(!docker.callable ? ["Docker execution backend is not callable."] : []),
      ...(enabled && !image ? ["Aider adapter is enabled but no container image is configured."] : []),
    ],
    governance: [
      "Must retain explicit approvals and immutable run evidence.",
      "Runs only in run-temp/artifact space; operator workspace patches are not applied.",
      "Replay posture remains audit-only and non-replayable.",
    ],
    evidence: {
      envFlag: enabled ? `${envFlag}=true` : envFlag,
      ...(image ? { imageConfigured: true } : {}),
      ...(aiderAdapter?.command ? { command: aiderAdapter.command } : {}),
      ...(aiderAdapter?.model ? { model: aiderAdapter.model } : {}),
    },
  };
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}
