import { useEffect, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleMeetPrerequisiteStatusResponse, GoogleMeetSessionRecord } from "@goatcitadel/contracts";
import { useIntegrationMeetActions } from "./use-integration-meet-actions";
import { useSessionDraft, __resetSessionDraftsForTests } from "../../library/session-drafts";
import { __resetIntegrationConnectionMutationsForTests } from "../integration-connection-mutation";

const api = vi.hoisted(() => ({
  startGoogleMeetSession: vi.fn(),
  stopGoogleMeetSession: vi.fn(),
  createGoogleMeetConsultHandoff: vi.fn(),
  createRealtimeVoiceClientSecret: vi.fn(),
  fetchGoogleMeetPrerequisiteStatus: vi.fn(),
  fetchGoogleMeetSessions: vi.fn(),
  fetchVoiceStatus: vi.fn(),
  isApiRequestError: vi.fn(() => false),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://meet-fixture",
  // Owner writes are attempt-tracked; these tests do not identify attempts, so dispatch passes straight through.
  captureMutationAttempt: (dispatch: () => Promise<unknown>) => dispatch(),
}));
const stamp = "2026-09-30T12:00:00.000Z",
  updated = "2026-09-30T12:01:00.000Z";
const form = {
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  displayName: "Fixture",
  accountRef: "fixture-account",
};
const prerequisites: GoogleMeetPrerequisiteStatusResponse = {
  ready: true,
  state: "ready",
  provider: "openai-realtime",
  checkedAt: stamp,
  authProfile: { available: true, accountRef: form.accountRef, source: "oauth_thread" },
  prerequisites: (["oauth_profile", "provider_key", "browser_transport", "audio_transport", "user_start"] as const).map(
    (id) => ({ id, ready: true, message: "Fixture prerequisite" }),
  ),
};
const initial: GoogleMeetSessionRecord = {
  sessionId: "meeting",
  ...form,
  state: "running",
  provider: "openai-realtime",
  createdAt: stamp,
  updatedAt: stamp,
  startedAt: stamp,
  prerequisites: prerequisites.prerequisites,
  transcript: [],
};
let root: ReactTestRenderer, s: ReturnType<typeof useIntegrationMeetActions>, records: GoogleMeetSessionRecord[];
const notice = vi.fn(),
  reload = vi.fn(async () => {}),
  trackStop = vi.fn(),
  getUserMedia = vi.fn();
function Harness({ scope = "one", panel = "meet" }: { scope?: string; panel?: "meet" | null }) {
  const editor = useSessionDraft(`meet-fixture:${scope}`, form, undefined, {
    label: "Meeting fixture",
    active: panel === "meet",
  });
  const view = useRef({ scope, panel });
  if (view.current.scope !== scope || view.current.panel !== panel) view.current = { scope, panel };
  const capture = view.current,
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [, setBusy] = useState<string | null>(null);
  s = useIntegrationMeetActions({
    panel,
    meetForm: editor.value,
    meetDraft: editor,
    setMeetForm: editor.setValue,
    setMeetBusySessionId: setBusy,
    setNotice: notice,
    reload,
    isCurrent: () => mounted.current && view.current === capture,
  });
  return null;
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
async function mount(scope = "one") {
  await act(async () => {
    root = create(<Harness scope={scope} />);
  });
}
async function review() {
  await act(async () => {
    s.handleStartGoogleMeetRealtime();
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetIntegrationConnectionMutationsForTests();
  records = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No real fetch in Meet owner tests");
    }),
  );
  vi.stubGlobal("window", { RTCPeerConnection: function FixtureRtc() {} });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  getUserMedia.mockResolvedValue({ getAudioTracks: () => [{}], getTracks: () => [{ stop: trackStop }] });
  api.fetchGoogleMeetPrerequisiteStatus.mockResolvedValue(prerequisites);
  api.fetchGoogleMeetSessions.mockImplementation(async () => structuredClone(records));
  api.startGoogleMeetSession.mockImplementation(async () => {
    records = [structuredClone(initial)];
    return structuredClone(initial);
  });
  api.createRealtimeVoiceClientSecret.mockImplementation(async () => {
    records = records.map((item) => ({ ...item, updatedAt: updated }));
    return {
      provider: "openai-realtime",
      surface: "google-meet",
      meetingSessionId: "meeting",
      voiceSessionId: "voice",
      model: "fixture-model",
      voice: "fixture-voice",
      status: "ready",
      createdAt: updated,
      clientSecret: { value: "synthetic-memory-only-credential" },
    };
  });
  api.fetchVoiceStatus.mockResolvedValue({
    realtime: {
      provider: "openai-realtime",
      state: "ready",
      activeVoiceSessionId: "voice",
      model: "fixture-model",
      voice: "fixture-voice",
      apiKeyReady: true,
      updatedAt: updated,
    },
  });
  api.stopGoogleMeetSession.mockImplementation(async () => {
    const saved: GoogleMeetSessionRecord = {
      ...initial,
      state: "stopped",
      updatedAt: updated,
      stoppedAt: updated,
      cleanup: { sessionId: initial.sessionId, cleanedAt: updated, releasedAudio: true, stoppedTransport: true },
    };
    records = [saved];
    return structuredClone(saved);
  });
  api.createGoogleMeetConsultHandoff.mockImplementation(async () => {
    const saved: GoogleMeetSessionRecord = {
      ...initial,
      state: "consulting",
      updatedAt: updated,
      consultHandoff: {
        handoffId: "handoff",
        sessionId: "meeting",
        target: "chat",
        createdAt: updated,
        prompt: "Review fixture",
        transcriptChunkIds: [],
      },
    };
    records = [saved];
    return structuredClone(saved);
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});
describe("shared Meet owner actions", () => {
  it("reviews and cancels without a microphone, owner write or external credential request", async () => {
    await mount();
    await review();
    expect(s.meetReview?.description).toContain("do not join Google Meet");
    await act(async () => s.cancelMeetReview());
    await act(async () => s.confirmMeetReview());
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(api.startGoogleMeetSession).not.toHaveBeenCalled();
    expect(api.createRealtimeVoiceClientSecret).not.toHaveBeenCalled();
  });
  it("admits one exact preparation and checks both owner readbacks without retaining the credential", async () => {
    await mount();
    await review();
    await act(async () => {
      await Promise.all([s.confirmMeetReview(), s.confirmMeetReview()]);
    });
    expect(api.startGoogleMeetSession).toHaveBeenCalledExactlyOnceWith({
      ...form,
      provider: "openai-realtime",
      userStartConfirmed: true,
      browserTransportReady: true,
      audioTransportReady: true,
    });
    expect(api.createRealtimeVoiceClientSecret).toHaveBeenCalledExactlyOnceWith({
      surface: "google-meet",
      meetingSessionId: "meeting",
      instructionsProfile: "google-meet",
    });
    expect(api.fetchVoiceStatus).toHaveBeenCalledOnce();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(s.meetMutation.locked).toBe(false);
    expect(s.meetReview).toBeNull();
    expect(JSON.stringify(notice.mock.calls)).not.toContain("synthetic-memory-only-credential");
    expect(notice).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringContaining("No meeting was joined") }),
    );
  });
  it("withholds writes after microphone permission resolves into a changed draft", async () => {
    const pending = deferred<MediaStream>();
    getUserMedia.mockReturnValueOnce(pending.promise);
    await mount();
    await review();
    let action!: Promise<void>;
    await act(async () => {
      action = s.confirmMeetReview();
    });
    await act(async () => s.setMeetForm({ ...form, displayName: "Newer" }));
    await act(async () => {
      pending.resolve({ getAudioTracks: () => [{}], getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream);
      await action;
    });
    expect(trackStop).toHaveBeenCalledOnce();
    expect(api.startGoogleMeetSession).not.toHaveBeenCalled();
    expect(api.createRealtimeVoiceClientSecret).not.toHaveBeenCalled();
  });
  it("withholds dispatch after a scope round trip during prerequisites", async () => {
    const pending = deferred<GoogleMeetPrerequisiteStatusResponse>();
    api.fetchGoogleMeetPrerequisiteStatus.mockReturnValueOnce(pending.promise);
    await mount();
    await review();
    let action!: Promise<void>;
    await act(async () => {
      action = s.confirmMeetReview();
    });
    await act(async () => root.update(<Harness scope="two" />));
    await act(async () => root.update(<Harness scope="one" />));
    await act(async () => {
      pending.resolve(prerequisites);
      await action;
    });
    expect(api.startGoogleMeetSession).not.toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalledOnce();
  });
  it("acknowledges a confirmed origin record after navigation without requesting a credential", async () => {
    const pending = deferred<GoogleMeetSessionRecord>();
    api.startGoogleMeetSession.mockReturnValueOnce(pending.promise);
    await mount();
    await review();
    let action!: Promise<void>;
    await act(async () => {
      action = s.confirmMeetReview();
    });
    await act(async () => root.update(<Harness scope="two" />));
    await act(async () => s.setMeetForm({ ...form, displayName: "Workspace two" }));
    await act(async () => {
      records = [initial];
      pending.resolve(initial);
      await action;
    });
    expect(api.createRealtimeVoiceClientSecret).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
    await review();
    expect(s.meetReview?.description).toContain(form.meetingUrl);
    expect(trackStop).toHaveBeenCalledOnce();
  });
  for (const failed of ["start", "credential", "foreign-receipt"] as const)
    it(`retains installation-wide uncertainty after ${failed}`, async () => {
      if (failed === "start") api.startGoogleMeetSession.mockRejectedValueOnce(new Error("Response lost after write"));
      if (failed === "credential")
        api.createRealtimeVoiceClientSecret.mockRejectedValueOnce(new Error("Credential response lost"));
      if (failed === "foreign-receipt")
        api.createRealtimeVoiceClientSecret.mockResolvedValueOnce({ meetingSessionId: "foreign" });
      await mount();
      await review();
      await act(async () => s.confirmMeetReview());
      expect(s.meetMutation.phase).toBe("uncertain");
      expect(trackStop).toHaveBeenCalledOnce();
      await act(async () => root.unmount());
      await mount("other-workspace");
      expect(s.meetMutation.locked).toBe(true);
      await review();
      expect(s.meetReview).toBeNull();
      expect(api.startGoogleMeetSession).toHaveBeenCalledOnce();
    });
  it("rejects blocked prerequisites before creating a record", async () => {
    api.fetchGoogleMeetPrerequisiteStatus.mockResolvedValueOnce({
      ...prerequisites,
      ready: false,
      state: "blocked",
      failureReason: "No provider key",
    });
    await mount();
    await review();
    await act(async () => s.confirmMeetReview());
    expect(api.startGoogleMeetSession).not.toHaveBeenCalled();
    expect(s.meetMutation.locked).toBe(false);
    expect(trackStop).toHaveBeenCalledOnce();
  });
  it("rereads the reviewed session before a recorded handoff or stop", async () => {
    records = [initial];
    await mount();
    await act(async () => s.handleConsultGoogleMeetSession(initial));
    records = [{ ...initial, displayName: "Changed elsewhere" }];
    await act(async () => s.confirmMeetReview());
    expect(api.createGoogleMeetConsultHandoff).not.toHaveBeenCalled();
    records = [initial];
    await act(async () => s.handleConsultGoogleMeetSession(initial));
    await act(async () => s.confirmMeetReview());
    expect(api.createGoogleMeetConsultHandoff).toHaveBeenCalledExactlyOnceWith("meeting", { target: "chat" });
    records = [initial];
    await act(async () => s.handleStopGoogleMeetSession(initial));
    await act(async () => s.confirmMeetReview());
    expect(api.stopGoogleMeetSession).toHaveBeenCalledExactlyOnceWith("meeting");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(api.createRealtimeVoiceClientSecret).not.toHaveBeenCalled();
  });
});
