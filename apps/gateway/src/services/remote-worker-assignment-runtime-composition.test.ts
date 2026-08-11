import { describe, expect, it } from "vitest";
import {
  createGatewayRemoteWorkerAssignmentRuntimeComposition,
  remoteWorkerAssignmentRuntimeActivated,
  type RemoteWorkerAssignmentRuntimeCompositionDependencies,
} from "./remote-worker-assignment-runtime-composition.js";

function fakeExecutionOwners(overrides: Partial<Record<"inference" | "settlement", unknown>> = {}): unknown {
  const noop = (): never => {
    throw new Error("not exercised");
  };
  return {
    inference: overrides.inference ?? { performInference: noop },
    settlement: overrides.settlement ?? {
      artifacts: { openUpload: noop, appendPart: noop, commitArtifact: noop },
      effects: { dispatchEffect: noop },
    },
  };
}

function fakeDependencies(
  overrides: Partial<Record<"nonceConsumer" | "meshAdmissions" | "assignments" | "execution", unknown>> = {},
): RemoteWorkerAssignmentRuntimeCompositionDependencies {
  const noop = (): never => {
    throw new Error("not exercised");
  };
  const admissionStore = {
    resolveRuntimeCredentialByHash: noop,
    findCurrentGeneration: noop,
    findLatestGenerationControl: noop,
    findProtectedAdmissionEvidenceRecord: noop,
    getBootstrap: noop,
  };
  const meshAdmissions = overrides.meshAdmissions ?? { resolveCurrentForRuntimeCredential: noop };
  const assignments = overrides.assignments ?? {
    resolveActiveAuthorityByLeaseTokenHash: noop,
    resolveControlReadAuthorityByLeaseTokenHash: noop,
    findAssignmentAggregate: noop,
    renewLease: noop,
    appendEvents: noop,
    settleAssignment: noop,
    listTaskBoundChatOffers: noop,
    findTaskBoundChatClaimContext: noop,
    resolveTaskBoundChatOffer: noop,
    claimTaskBoundChatOffer: noop,
    resolveTaskBoundChatWorkload: noop,
  };
  const nonceConsumer = overrides.nonceConsumer ?? { consume: noop };
  return {
    admissionStore,
    meshAdmissions,
    assignments,
    nonceConsumer,
    ...(overrides.execution === undefined ? {} : { execution: overrides.execution }),
  } as unknown as RemoteWorkerAssignmentRuntimeCompositionDependencies;
}

describe("remote worker assignment runtime activation flag", () => {
  it("is off by default and only 'true' turns it on", () => {
    expect(remoteWorkerAssignmentRuntimeActivated({})).toBe(false);
    expect(remoteWorkerAssignmentRuntimeActivated({ GOATCITADEL_WORKER_ASSIGNMENT_RUNTIME_ENABLED: "false" })).toBe(
      false,
    );
    expect(remoteWorkerAssignmentRuntimeActivated({ GOATCITADEL_WORKER_ASSIGNMENT_RUNTIME_ENABLED: "true" })).toBe(
      true,
    );
    expect(() =>
      remoteWorkerAssignmentRuntimeActivated({ GOATCITADEL_WORKER_ASSIGNMENT_RUNTIME_ENABLED: "1" }),
    ).toThrow();
  });
});

describe("remote worker assignment runtime composition", () => {
  it("builds both owners with a passing structural preflight over canonical stores", async () => {
    const composition = createGatewayRemoteWorkerAssignmentRuntimeComposition(fakeDependencies());
    expect(composition.assignmentProtocol.execute).toBeTypeOf("function");
    expect(composition.assignmentDispatch.execute).toBeTypeOf("function");
    await expect(composition.assignmentProtocol.assertAvailable()).resolves.toBeUndefined();
    await expect(composition.assignmentDispatch.assertAvailable()).resolves.toBeUndefined();
  });

  it("fails the preflight closed when a required owner is structurally unavailable", async () => {
    const composition = createGatewayRemoteWorkerAssignmentRuntimeComposition(fakeDependencies({ nonceConsumer: {} }));
    await expect(composition.assignmentProtocol.assertAvailable()).rejects.toBeInstanceOf(TypeError);
  });

  it("omits the routes 11-12 execution owner unless both inner owners are injected", () => {
    const composition = createGatewayRemoteWorkerAssignmentRuntimeComposition(fakeDependencies());
    expect(composition.assignmentExecution).toBeUndefined();
    expect(Object.hasOwn(composition, "assignmentExecution")).toBe(false);
  });

  it("builds the routes 11-12 execution owner when the HX-503/HX-506 inner owners are injected", async () => {
    const composition = createGatewayRemoteWorkerAssignmentRuntimeComposition(
      fakeDependencies({ execution: fakeExecutionOwners() }),
    );
    expect(composition.assignmentExecution?.execute).toBeTypeOf("function");
    await expect(composition.assignmentExecution?.assertAvailable()).resolves.toBeUndefined();
  });

  it("fails the execution preflight closed when an inner HX-503/HX-506 owner is structurally unavailable", async () => {
    for (const execution of [
      fakeExecutionOwners({ inference: {} }),
      fakeExecutionOwners({ settlement: { artifacts: {}, effects: { dispatchEffect: () => undefined } } }),
      fakeExecutionOwners({
        settlement: { artifacts: { commitArtifact: () => undefined }, effects: {} },
      }),
    ]) {
      const composition = createGatewayRemoteWorkerAssignmentRuntimeComposition(fakeDependencies({ execution }));
      await expect(composition.assignmentExecution?.assertAvailable()).rejects.toBeInstanceOf(TypeError);
    }
  });
});
