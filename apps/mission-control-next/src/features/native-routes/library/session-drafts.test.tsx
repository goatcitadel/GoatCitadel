import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetSessionDraftsForTests, hasSessionDraft, useSessionDraft } from "./session-drafts";
import { __resetFormDirtyRegistryForTests, getDirtySectionKeys } from "./use-form-dirty";

describe("session editor drafts", () => {
  let draft: ReturnType<typeof useSessionDraft<{ title: string }>>;
  let renderer: ReactTestRenderer;
  function Editor({ id = "workspace:a:note:1", title = "Canonical", revision = 1, active = true }: { id?: string; title?: string; revision?: number; active?: boolean }) {
    draft = useSessionDraft(id, { title }, revision, { label: "Note", active });
    return <input value={draft.value.title} onChange={() => undefined} />;
  }
  beforeEach(() => { __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests(); });
  it("retains text and its base revision across refresh, unmount and reopening", async () => {
    await act(async () => { renderer = create(<Editor />); });
    await act(async () => { draft.setValue({ title: "Unsaved" }); });
    await act(async () => { renderer.update(<Editor title="Another operator's edit" revision={2} />); });
    expect(draft.value.title).toBe("Unsaved");
    expect(draft.baseRevision).toBe(1);
    expect(draft.hasRemoteChanges).toBe(true);
    await act(async () => renderer.unmount());
    expect(getDirtySectionKeys()).toEqual([]);
    expect(hasSessionDraft("workspace:a:note:1")).toBe(true);
    await act(async () => { renderer = create(<Editor title="Another operator's edit" revision={2} />); });
    expect(draft.value.title).toBe("Unsaved");
    expect(getDirtySectionKeys()).toEqual(["workspace:a:note:1"]);
    await act(async () => renderer.unmount());
  });
  it("isolates records and scopes, including inactive retained drafts", async () => {
    await act(async () => { renderer = create(<Editor />); });
    await act(async () => { draft.setValue({ title: "Workspace A draft" }); });
    await act(async () => { renderer.update(<Editor id="workspace:b:note:1" title="Workspace B" />); });
    expect(draft.value.title).toBe("Workspace B");
    expect(draft.isDirty).toBe(false);
    await act(async () => { renderer.update(<Editor active={false} />); });
    expect(draft.value.title).toBe("Workspace A draft");
    expect(getDirtySectionKeys()).toEqual([]);
    await act(async () => renderer.unmount());
  });
  it("accepts successful saves without flashing the old canonical value and resumes later clean refreshes", async () => {
    await act(async () => { renderer = create(<Editor />); });
    await act(async () => { draft.setValue({ title: "Saved" }); draft.acceptSaved({ title: "Saved" }, 2); });
    expect(draft.value.title).toBe("Saved");
    expect(hasSessionDraft("workspace:a:note:1")).toBe(false);
    await act(async () => renderer.update(<Editor title="Saved" revision={2} />));
    await act(async () => renderer.update(<Editor title="Later canonical" revision={3} />));
    expect(draft.value.title).toBe("Later canonical");
    await act(async () => renderer.unmount());
  });
  it("discards only the requested draft and adopts the current canonical revision", async () => {
    await act(async () => { renderer = create(<Editor />); });
    await act(async () => draft.setValue({ title: "Unsaved A" }));
    await act(async () => renderer.update(<Editor id="workspace:a:note:2" title="Second" />));
    await act(async () => draft.setValue({ title: "Unsaved B" }));
    await act(async () => renderer.update(<Editor revision={2} title="Current" />));
    await act(async () => draft.discard());
    expect(draft.value.title).toBe("Current");
    expect(draft.baseRevision).toBe(2);
    expect(hasSessionDraft("workspace:a:note:2")).toBe(true);
    await act(async () => renderer.unmount());
  });
  it("preserves newer typing when an earlier save finishes", async () => {
    await act(async () => { renderer = create(<Editor />); });
    await act(async () => draft.setValue({ title: "Submitted" }));
    const submitted = draft.value;
    await act(async () => draft.setValue({ title: "Submitted, then continued typing" }));
    await act(async () => { expect(draft.acceptSaved(submitted, 2, submitted)).toBe(false); });
    expect(draft.value.title).toBe("Submitted, then continued typing");
    expect(draft.isDirty).toBe(true);
    expect(draft.baseRevision).toBe(2);
    await act(async () => renderer.update(<Editor title="Submitted" revision={2} />));
    expect(draft.value.title).toBe("Submitted, then continued typing");
    await act(async () => renderer.unmount());
  });
  it("carries input typed during a version save onto the acknowledged version identity", async () => {
    await act(async () => { renderer = create(<Editor id="artifact:v1" title="Version 1" revision={1} />); });
    await act(async () => draft.setValue({ title: "Submitted version" }));
    await act(async () => draft.setValue({ title: "Newer input" }));
    await act(async () => { expect(draft.acceptSavedAs("artifact:v2", { title: "Submitted version" }, 2, { title: "Submitted version" })).toBe(false); });
    expect(hasSessionDraft("artifact:v1")).toBe(false); expect(hasSessionDraft("artifact:v2")).toBe(true);
    await act(async () => renderer.update(<Editor id="artifact:v2" title="Submitted version" revision={2} />));
    expect(draft.value.title).toBe("Newer input"); expect(draft.baseRevision).toBe(2); expect(draft.hasRemoteChanges).toBe(false);
    await act(async () => renderer.unmount());
  });

});
