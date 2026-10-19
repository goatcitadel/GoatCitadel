import { act, create, type ReactTestRenderer } from "react-test-renderer";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatSurfaceComposition } from "./useChatSurfaceComposition";
vi.mock("../useMissionControlSurfaceState", () => ({ useMissionControlSurfaceState: () => ({ messageMode: "chat" }) }));
vi.mock("../useChatCapabilityProfileInspection", () => ({ useChatCapabilityProfileInspection: () => ({}) }));
vi.mock("../useChatDockWorkbenchController", () => ({
  useChatDockWorkbenchController: () => ({ setDockOpen: vi.fn() }),
}));
vi.mock("../useChatRunPresentation", () => ({ useChatRunPresentation: () => ({}) }));
type SurfaceInput = Parameters<typeof useChatSurfaceComposition>[0];
type Availability = { modelCouncil?: boolean; workspaceSnapshot?: boolean };
type OneShot = { modelCouncilEnabled?: boolean; workspaceSnapshotRequest?: { capture: true; requestId: string } };

let root: ReactTestRenderer;
let result: ReturnType<typeof useChatSurfaceComposition>;
beforeEach(() => {
  act(() => {
    root = create(<></>);
  });
});
afterEach(() => {
  act(() => root.unmount());
});

function Harness({ availability, oneShot }: { availability?: Availability; oneShot: OneShot }) {
  const session = {
    sessionData: {
      proactiveRuns: [],
      specialistCandidates: [],
      learnedMemory: [],
      settings: availability ? { chatFeatureAvailability: availability } : undefined,
    },
    threadController: { missionSessions: [], externalSessions: [] },
    externalControl: {},
    externalSourceAttachments: { selectedAttachmentIds: [] },
    documentContext: { pendingDocumentContextRefs: [] },
  };
  result = useChatSurfaceComposition({
    session,
    workspaceId: "one",
    draft: "Compare the options",
    pendingAttachments: [],
    sending: false,
    selection: { selectedSessionId: "chat-a" },
    execution: {
      contextActions: { capabilitySuggestions: [], specialistSuggestions: [] },
      outbound: {},
      setCapabilitySuggestions: vi.fn(),
      setSpecialistSuggestions: vi.fn(),
    },
    coordination: {
      lastCapabilitySuggestionSyncKeyRef: { current: null },
      lastSpecialistSuggestionSyncKeyRef: { current: null },
      activeStreamRef: { current: null },
    },
    submission: { currentRoutePreflight: null, routePreflight: {}, providerRouting: {}, orchestration: {} },
    oneShotContext: oneShot,
    pushLocalNotice: vi.fn(),
  } as unknown as SurfaceInput);
  return null;
}

const snapshotRequest = { capture: true as const, requestId: "snapshot-1" };

it.each([
  { name: "Council", oneShot: { modelCouncilEnabled: true }, availability: { modelCouncil: true } },
  {
    name: "workspace snapshot",
    oneShot: { workspaceSnapshotRequest: snapshotRequest },
    availability: { workspaceSnapshot: true },
  },
])("admits Send with an armed $name while the Gateway reports it available", async ({ oneShot, availability }) => {
  await act(async () => root.update(<Harness availability={availability} oneShot={oneShot} />));
  expect(result.canSend).toBe(true);
  expect(result.profileDependentAdmissionBlockReason).toBeUndefined();
});

it.each([
  {
    name: "Council",
    oneShot: { modelCouncilEnabled: true },
    availability: { workspaceSnapshot: true },
    reason: "Turn Council off to send.",
  },
  {
    name: "workspace snapshot",
    oneShot: { workspaceSnapshotRequest: snapshotRequest },
    availability: { modelCouncil: true },
    reason: "Remove the snapshot to send.",
  },
  {
    name: "Council without settings",
    oneShot: { modelCouncilEnabled: true },
    availability: undefined,
    reason: "Turn Council off to send.",
  },
])("fails closed with an armed $name that is not available", async ({ oneShot, availability, reason }) => {
  await act(async () => root.update(<Harness availability={availability} oneShot={oneShot} />));
  expect(result.canSend).toBe(false);
  expect(result.profileDependentAdmissionBlockReason).toContain(reason);
});
