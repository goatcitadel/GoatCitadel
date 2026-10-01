import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { elicitationFixture, respondedFixture } from "./mcp-elicitation.test-support";
import { useMcpElicitationResponse } from "./use-mcp-elicitation-response";
import { __resetMcpResponsesForTests } from "./mcp-elicitation-response";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../library/use-form-dirty";
const api = vi.hoisted(() => ({ fetchMcpElicitations: vi.fn(), respondMcpElicitation: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
let request = elicitationFixture(),
  root: ReactTestRenderer | undefined,
  control!: ReturnType<typeof useMcpElicitationResponse>;
const recorded = vi.fn();
function Harness({ workspaceId }: { workspaceId: string }) {
  control = useMcpElicitationResponse({ request, workspaceId, onRecorded: recorded });
  return null;
}
async function render(workspaceId = "workspace") {
  await act(async () => {
    const element = (
      <StrictMode>
        <Harness workspaceId={workspaceId} />
      </StrictMode>
    );
    if (root) root.update(element);
    else root = create(element);
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetMcpResponsesForTests();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  request = elicitationFixture();
  api.fetchMcpElicitations.mockImplementation(async () => ({ items: [request] }));
  api.respondMcpElicitation.mockImplementation(async (_id, input) => {
    request = respondedFixture(request, input.action, input.content);
    return request;
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});
it("records once through StrictMode and keeps unknown admission across an actual remount", async () => {
  await render();
  await act(async () => control.draft.setValue({ name: "Reviewed" }));
  api.respondMcpElicitation.mockRejectedValue(new Error("lost"));
  await act(async () => control.respond("accept"));
  expect(control.attempt.phase).toBe("uncertain");
  await act(async () => root!.unmount());
  root = undefined;
  await render();
  expect(control.draft.value.name).toBe("Reviewed");
  await act(async () => control.respond("accept"));
  expect(api.respondMcpElicitation).toHaveBeenCalledTimes(1);
});
it("cancels an away-and-back view during preflight", async () => {
  await render();
  const pending = deferred<{ items: (typeof request)[] }>();
  api.fetchMcpElicitations.mockReturnValueOnce(pending.promise);
  let work!: Promise<void>;
  await act(async () => {
    work = control.respond("decline");
  });
  await render("other");
  await render();
  await act(async () => {
    pending.resolve({ items: [request] });
    await work;
  });
  expect(api.respondMcpElicitation).not.toHaveBeenCalled();
});
it("cancels a preflight when the draft changes and leaves newer input intact", async () => {
  await render();
  await act(async () => control.draft.setValue({ name: "Submitted" }));
  const pending = deferred<{ items: (typeof request)[] }>();
  api.fetchMcpElicitations.mockReturnValueOnce(pending.promise);
  let work!: Promise<void>;
  await act(async () => {
    work = control.respond("accept");
    control.draft.setValue({ name: "Newer" });
  });
  await act(async () => {
    pending.resolve({ items: [request] });
    await work;
  });
  expect(api.respondMcpElicitation).not.toHaveBeenCalled();
  expect(control.draft.value.name).toBe("Newer");
});
it("acknowledges the originating draft after a late confirmed receipt without calling a stale view", async () => {
  await render();
  await act(async () => control.draft.setValue({ name: "Reviewed" }));
  const pending = deferred<typeof request>();
  api.respondMcpElicitation.mockReturnValueOnce(pending.promise);
  let work!: Promise<void>;
  await act(async () => {
    work = control.respond("accept");
  });
  await act(async () => root!.unmount());
  root = undefined;
  request = respondedFixture(request, "accept", { name: "Reviewed" });
  await act(async () => {
    pending.resolve(request);
    await work;
  });
  await render();
  expect(control.draft.isDirty).toBe(false);
  expect(control.attempt.phase).toBe("recorded");
  expect(recorded).not.toHaveBeenCalled();
});
