import { beforeEach, describe, expect, it, vi } from "vitest";
import { composeGatewayNativeWorkerHandler } from "./remote-worker-gateway-handler-composition.js";

const mocks = vi.hoisted(() => ({
  activated: vi.fn(() => false),
  assignment: vi.fn(),
  admission: vi.fn(),
}));
vi.mock("./remote-worker-assignment-runtime-composition.js", () => ({
  remoteWorkerAssignmentRuntimeActivated: mocks.activated,
  createGatewayRemoteWorkerAssignmentRuntimeComposition: mocks.assignment,
}));
vi.mock("./remote-worker-admission-composition.js", () => ({
  createGatewayRemoteWorkerAdmissionNativeRequestHandler: mocks.admission,
}));

function fixture() {
  const execution = {};
  const gateway = {
    storage: { remoteWorkerAdmissions: {}, remoteWorkerMeshNodeAdmissions: {},
      remoteWorkerAssignments: {}, remoteWorkerNonces: {} },
    routeServices: { meshCapabilityPublication: {}, meshCapabilityInvocation: {} },
    createRemoteWorkerExecutionOwners: vi.fn(() => execution),
  };
  const invoke = () => composeGatewayNativeWorkerHandler(
    gateway as unknown as Parameters<typeof composeGatewayNativeWorkerHandler>[0],
    {} as Parameters<typeof composeGatewayNativeWorkerHandler>[1],
  );
  return { gateway, execution, invoke };
}

describe("Gateway native worker handler composition", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.activated.mockReturnValue(false);
  });

  it("does not construct execution owners while activation is off", async () => {
    const f = fixture();
    await f.invoke();
    expect(f.gateway.createRemoteWorkerExecutionOwners).not.toHaveBeenCalled();
    expect(mocks.assignment).not.toHaveBeenCalled();
    expect(mocks.admission).toHaveBeenCalledOnce();
    expect(mocks.admission.mock.calls[0]![0]).not.toHaveProperty("assignmentExecution");
  });

  it("refuses active composition before constructing execution when a mesh owner is missing", async () => {
    const f = fixture();
    Reflect.deleteProperty(f.gateway.routeServices, "meshCapabilityInvocation");
    mocks.activated.mockReturnValue(true);
    await expect(f.invoke()).rejects.toThrow("mesh capability owners are unavailable");
    expect(f.gateway.createRemoteWorkerExecutionOwners).not.toHaveBeenCalled();
    expect(mocks.admission).not.toHaveBeenCalled();
  });

  it("forwards the composed owners and preserves an admission refusal", async () => {
    const f = fixture();
    const composed = { assignmentProtocol: {}, assignmentDispatch: {}, assignmentExecution: {}, meshCapabilities: {} };
    mocks.activated.mockReturnValue(true);
    mocks.assignment.mockReturnValue(composed);
    mocks.admission.mockResolvedValue(undefined);
    await expect(f.invoke()).resolves.toBeUndefined();
    expect(f.gateway.createRemoteWorkerExecutionOwners).toHaveBeenCalledOnce();
    expect(mocks.assignment.mock.calls[0]![0]).toMatchObject({ execution: f.execution });
    expect(mocks.admission.mock.calls[0]![0]).toMatchObject(composed);
  });
});
