import type {
  CodeModeBackendEvaluationMatrix,
  CodeModeExecutionBackendRecord,
  CodeModeExecutionBackendsResponse,
  CodeModeRunExecutionBackendRef,
  CodeModeSandboxMetadata,
} from "@goatcitadel/contracts";
import type { CodeModeAiderAdapterConfig, CodeModeDockerBackendConfig } from "../config.js";
import { isDigestPinnedImageRef } from "./code-mode-docker-launch.js";

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
    items: [host, docker, aider, ...buildReferenceBackendCandidates()],
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
      ...(sandbox.hostileSandboxClaim?.publicClaimAllowed
        ? []
        : (sandbox.hostileSandboxClaim?.blockers ?? ["Hostile-code sandboxing is not promoted."])),
    ],
    governance: [
      "Requires explicit Code Mode approval before execution.",
      "Revalidates source, wrapper manifest, policy snapshot, and sandbox posture before launch.",
      "This is trusted-code execution and does not claim hostile-code sandboxing.",
    ],
    evaluation: {
      credentialStorage: "partial",
      pathIsolation: "partial",
      networkControls: "partial",
      artifactCapture: "strong",
      resumeStateSemantics: "partial",
      windowsSupport: "strong",
      localFirstViability: "strong",
      license: "not_applicable",
      cost: "strong",
      requiredProofLanes: ["verify:code-mode:sandbox", "verify:runtime:truth"],
    },
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
  const requireDigestPin = dockerBackend?.requireDigestPin ?? true;
  const digestPinBlocked = Boolean(enabled && image && requireDigestPin && !isDigestPinnedImageRef(image));
  const callable = codeModeEnabled && enabled && Boolean(image) && !digestPinBlocked;
  return {
    backendId: CODE_MODE_DOCKER_BACKEND_ID,
    kind: "docker",
    label: "Docker execution backend",
    status: digestPinBlocked ? "blocked" : callable ? "available" : "preview",
    runtimeSupport: digestPinBlocked ? "not_available" : callable ? "active_runner" : "preview_only",
    default: false,
    callable,
    description: callable
      ? "Configured container backend for approved Code Mode runs using stdio JSON-RPC transport."
      : digestPinBlocked
        ? "Configured Docker backend is blocked because digest pinning is required but the image is tag-only."
        : "Planned container backend for Code Mode runs after policy, artifact, and approval parity is wired.",
    blockers: [
      ...(!codeModeEnabled ? ["Code Mode v1 is disabled."] : []),
      ...(!enabled ? ["Docker backend is not enabled."] : []),
      ...(codeModeEnabled && enabled && !image
        ? ["Docker backend is enabled but no container image is configured."]
        : []),
      ...(digestPinBlocked ? ["Docker backend requires a digest-pinned image (name@sha256:<64 hex chars>)."] : []),
    ],
    governance: [
      "Must preserve deny-wins policy, path jails, approval linkage, immutable artifact hashes, and runtime truth.",
      "Must not replace auth, approvals, or operator-visible sandbox posture.",
      "Docker is extra isolation evidence, not sufficient evidence for a hostile-code sandbox claim.",
      ...(callable ? ["Experimental: uses the configured local Docker daemon and a run-temp bind mount."] : []),
    ],
    evaluation: {
      credentialStorage: "partial",
      pathIsolation: "strong",
      networkControls: "partial",
      artifactCapture: "partial",
      resumeStateSemantics: "partial",
      windowsSupport: "partial",
      localFirstViability: "strong",
      license: "strong",
      cost: "strong",
      requiredProofLanes: ["verify:code-mode:sandbox", "verify:desktop", "verify:runtime:truth"],
    },
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
  const blockedByDocker = Boolean(codeModeEnabled && enabled && image && docker.status === "blocked");
  const callable = codeModeEnabled && enabled && docker.callable && Boolean(image);
  return {
    backendId: CODE_MODE_AIDER_ADAPTER_ID,
    kind: "aider_adapter",
    label: "Aider CLI adapter",
    status: blockedByDocker ? "blocked" : callable ? "available" : "preview",
    runtimeSupport: blockedByDocker ? "not_available" : callable ? "active_runner" : "preview_only",
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
    evaluation: {
      credentialStorage: "partial",
      pathIsolation: "strong",
      networkControls: "partial",
      artifactCapture: "strong",
      resumeStateSemantics: "weak",
      windowsSupport: "partial",
      localFirstViability: "partial",
      license: "partial",
      cost: "strong",
      requiredProofLanes: ["verify:code-mode:sandbox", "verify:runtime:truth"],
    },
    evidence: {
      envFlag: enabled ? `${envFlag}=true` : envFlag,
      ...(image ? { imageConfigured: true } : {}),
      ...(aiderAdapter?.command ? { command: aiderAdapter.command } : {}),
      ...(aiderAdapter?.model ? { model: aiderAdapter.model } : {}),
    },
  };
}

function buildReferenceBackendCandidates(): CodeModeExecutionBackendRecord[] {
  return [
    buildReferenceBackend({
      backendId: "e2b-reference",
      kind: "e2b",
      label: "E2B reference candidate",
      description: "Reference-only remote sandbox candidate; no GoatCitadel execution support is configured.",
      evaluation: {
        credentialStorage: "unknown",
        pathIsolation: "strong",
        networkControls: "partial",
        artifactCapture: "partial",
        resumeStateSemantics: "partial",
        windowsSupport: "not_applicable",
        localFirstViability: "weak",
        license: "partial",
        cost: "partial",
        requiredProofLanes: ["verify:code-mode:sandbox", "verify:runtime:truth", "docs:check"],
      },
    }),
    buildReferenceBackend({
      backendId: "daytona-reference",
      kind: "daytona",
      label: "Daytona reference candidate",
      description: "Reference-only workspace backend candidate; not exposed as a callable Code Mode runner.",
      evaluation: {
        credentialStorage: "unknown",
        pathIsolation: "strong",
        networkControls: "partial",
        artifactCapture: "partial",
        resumeStateSemantics: "partial",
        windowsSupport: "partial",
        localFirstViability: "partial",
        license: "partial",
        cost: "partial",
        requiredProofLanes: ["verify:code-mode:sandbox", "verify:desktop", "verify:runtime:truth"],
      },
    }),
    buildReferenceBackend({
      backendId: "sandbox0-reference",
      kind: "sandbox0",
      label: "Sandbox0 reference candidate",
      description: "Reference-only sandbox candidate pending policy, artifact, credential, and Windows proof.",
      evaluation: {
        credentialStorage: "unknown",
        pathIsolation: "unknown",
        networkControls: "unknown",
        artifactCapture: "unknown",
        resumeStateSemantics: "unknown",
        windowsSupport: "unknown",
        localFirstViability: "unknown",
        license: "unknown",
        cost: "unknown",
        requiredProofLanes: ["verify:code-mode:sandbox", "docs:check"],
      },
    }),
    buildReferenceBackend({
      backendId: "kubernetes-agent-sandbox-reference",
      kind: "kubernetes_agent_sandbox",
      label: "Kubernetes agent sandbox reference",
      description: "Reference-only cluster sandbox candidate; no managed workflow lifecycle is enabled.",
      evaluation: {
        credentialStorage: "partial",
        pathIsolation: "strong",
        networkControls: "strong",
        artifactCapture: "partial",
        resumeStateSemantics: "partial",
        windowsSupport: "not_applicable",
        localFirstViability: "weak",
        license: "strong",
        cost: "partial",
        requiredProofLanes: ["verify:code-mode:sandbox", "verify:runtime:truth", "docs:check"],
      },
    }),
  ];
}

function buildReferenceBackend(input: {
  backendId: string;
  kind: CodeModeExecutionBackendRecord["kind"];
  label: string;
  description: string;
  evaluation: CodeModeBackendEvaluationMatrix;
}): CodeModeExecutionBackendRecord {
  return {
    backendId: input.backendId,
    kind: input.kind,
    label: input.label,
    status: "preview",
    runtimeSupport: "preview_only",
    default: false,
    callable: false,
    description: input.description,
    blockers: ["Reference/evaluation only: no configured GoatCitadel execution backend exists."],
    governance: [
      "Visible for backend evaluation only.",
      "Must not appear as a callable execution backend until policy, approvals, artifact capture, credential storage, and proof lanes are implemented.",
      "Does not change trusted-code or hostile-code sandbox claims.",
    ],
    evaluationOnly: true,
    evaluation: input.evaluation,
    evidence: {},
  };
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}
