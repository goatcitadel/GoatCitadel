import { canonicalJsonString, normalizeRemoteWorkerRuntimeResultExpectation, type ToolAccessEvaluateRequest, type ToolAccessEvaluateResponse } from "@goatcitadel/contracts";
import { snapshotRemoteWorkerRuntimeRequestPreparation, snapshotRemoteWorkerCellCapacityInventoryAdmission, type AsyncStorage, type RemoteWorkerRuntimeRequestPreparationInput,
  type RemoteWorkerRuntimeAdmissionInput, type RemoteWorkerRuntimeAdmissionResult, type NativePolicyReservationLookup } from "@goatcitadel/storage";
import { normalizeWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { resolveRemoteWorkerChatProfile, type RemoteWorkerChatAuthorityDependencies } from "./remote-worker-chat-authority.js";
export interface RemoteWorkerNativeRuntimePolicyPort {
  authorize(input: RemoteWorkerRuntimeRequestPreparationInput & { signal?: AbortSignal }): Promise<void>;
  authorizeAdmitted(input: RemoteWorkerRuntimeRequestPreparationInput & { nonce: string; requestSha256: string; signal?: AbortSignal }): Promise<void>;
  admit(input: RemoteWorkerRuntimeAdmissionInput & { signal?: AbortSignal }): Promise<RemoteWorkerRuntimeAdmissionResult>;
}
/** Native execution retains the frozen Chat tool owner and the Gateway's current
 * deny-wins policy. A native approval never substitutes for a disabled tool. */
export function createRemoteWorkerNativeRuntimePolicy(dependencies: RemoteWorkerChatAuthorityDependencies & {
  storage: RemoteWorkerChatAuthorityDependencies["storage"] & Pick<AsyncStorage, "remoteWorkerAssignments">;
}, evaluate: (input: ToolAccessEvaluateRequest) => Promise<ToolAccessEvaluateResponse>,
  admit?: (request: ToolAccessEvaluateRequest, input: RemoteWorkerRuntimeAdmissionInput & { signal?: AbortSignal }) => Promise<RemoteWorkerRuntimeAdmissionResult>,
  inspectAdmitted?: (request: ToolAccessEvaluateRequest, input: NativePolicyReservationLookup) => Promise<ToolAccessEvaluateResponse>): RemoteWorkerNativeRuntimePolicyPort {
  const authorize = async (input: RemoteWorkerRuntimeRequestPreparationInput & { signal?: AbortSignal }, check = evaluate) => {
    const command = snapshotRemoteWorkerRuntimeRequestPreparation(input), signal = input.signal;
    const launch = command.launch as { image: string; commandLine: string; directory: string };
    // CreateProcess selects image independently of argv[0]. Require the policy
    // command to name that exact image rather than accepting a harmless decoy.
    const prefix = `"${launch.image}"`;
    if (!launch.commandLine.startsWith(prefix) || (launch.commandLine.length > prefix.length && !/^[ \t]/u.test(launch.commandLine.slice(prefix.length))))
      throw new Error("Native command policy requires the exact quoted executable image.");
    const read = async () => {
      signal?.throwIfAborted();
      const execution = await dependencies.storage.remoteWorkerAssignments.resolveActiveChatExecution(command, command.protectedAuthority);
      const binding = await resolveRemoteWorkerChatProfile(dependencies, execution);
      signal?.throwIfAborted();
      const manifest = execution.authority.assignment.manifest, selected = binding.profile.selection.tools.find(tool => tool.canonicalName === "shell.exec");
      if (!manifest.requiredCapabilityClasses.includes("durable_compute") || !manifest.requiredCapabilityClasses.includes("governed_tool") ||
          selected?.runtimeOwner?.kind !== "builtin" || !selected.effectPotential)
        throw new Error("Native runtime requires its admitted builtin shell capability.");
      return { binding, manifest };
    };
    const before = await read(), { profile, policy } = before.binding;
    const expectedProfile = canonicalJsonString(profile), expectedManifest = canonicalJsonString(before.manifest), expectedPolicy = canonicalJsonString(policy);
    const policyRequest: ToolAccessEvaluateRequest = { toolName: "shell.exec", agentId: "assistant", sessionId: profile.identity.sessionId,
      workspaceId: profile.identity.workspaceId, citadelId: profile.identity.citadelId, taskId: before.manifest.taskId,
      runId: before.manifest.durableRunId, surface: "chat", policyContext: policy, permissionProfileId: policy.permissionProfileId,
      args: { command: launch.commandLine, cwd: launch.directory } };
    const decision = await check(policyRequest);
    signal?.throwIfAborted();
    if (decision.toolName !== "shell.exec" || decision.allowed !== true) throw new Error("Native runtime is denied by current tool policy.");
    // Native dispatch has no dry-run executor, local-route substitution or
    // Ward-specific artifact redaction boundary. An allowed tool decision does
    // not waive those effects. The exact native review separately enforces the
    // require_approval effect; other restrictions must fail closed here.
    if (decision.wardEffect !== undefined && decision.wardEffect !== "allow" && decision.wardEffect !== "require_approval")
      throw new Error("Native runtime cannot enforce the current Ward restriction.");
    const after = await read();
    if (canonicalJsonString(after.binding.profile) !== expectedProfile || canonicalJsonString(after.manifest) !== expectedManifest ||
        canonicalJsonString(after.binding.policy) !== expectedPolicy) throw new Error("Native runtime policy context changed during review.");
    return policyRequest;
  };
  return {
    authorize: async input => { await authorize(input); },
    authorizeAdmitted: async input => {
      if (!inspectAdmitted) throw new Error("Native authorization requires its retained policy reservation.");
      const command = { ...snapshotRemoteWorkerRuntimeRequestPreparation(input), nonce: input.nonce,
        requestSha256: input.requestSha256, signal: input.signal };
      await authorize(command, request => inspectAdmitted(request, command));
    },
    admit: async input => {
      if (!admit) throw new Error("Native admission requires the canonical policy commit owner.");
      const request = normalizeWindowsRuntimeDispatch(input.request);
      const command = { ...snapshotRemoteWorkerCellCapacityInventoryAdmission(input), request,
        approvalId: input.approvalId, expectation: normalizeRemoteWorkerRuntimeResultExpectation(input.expectation), signal: input.signal };
      const policyRequest = await authorize({ ...command, launch: request.launch, inventoryLimits: request.inventoryLimits,
        ...(request.fileStaging ? { fileStaging: request.fileStaging } : {}) });
      return admit(policyRequest, command);
    },
  };
}
