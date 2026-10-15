import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkFile } from "./check-mission-control-next-danger-actions.mjs";

describe("danger-actions guard", () => {
  it("rejects red buttons for reversible verbs and accepts destructive ones", () => {
    assert.deepEqual(
      checkFile("areas/work/X.tsx", '<Button variant="danger" onClick={archive}>Archive board</Button>'),
      ['areas/work/X.tsx:1: "Archive board" is reversible and must not be red'],
    );
    assert.deepEqual(
      checkFile("areas/inbox/X.tsx", '<Button size="sm" variant="danger" onClick={deny}>\n  Deny\n</Button>'),
      ['areas/inbox/X.tsx:1: "Deny" is reversible and must not be red'],
    );
    assert.deepEqual(
      checkFile("areas/library/X.tsx", '<Button variant="danger" onClick={forget}>Forget memory</Button>'),
      [],
    );
    assert.deepEqual(
      checkFile("areas/system/X.tsx", '<Button variant="danger" onClick={() => setOpen(true)}>Archive board</Button>'),
      ['areas/system/X.tsx:1: "Archive board" is reversible and must not be red'],
    );
    assert.deepEqual(
      checkFile("areas/settings/X.tsx", '<Button variant="danger" onClick={remove}>Delete secret</Button>'),
      [],
    );
  });

  it("rejects kind-based conditions that paint a reversible action red", () => {
    assert.deepEqual(checkFile("areas/settings/X.tsx", 'variant={review.kind === "test" ? "danger" : "primary"}'), [
      'areas/settings/X.tsx:1: a "test" action is reversible and must not be red',
    ]);
    assert.deepEqual(
      checkFile("areas/settings/X.tsx", 'variant={review.action === "revoke" ? "danger" : "primary"}'),
      [],
    );
  });

  it("requires the shared helpers for typed confirmations and unsaved changes", () => {
    assert.deepEqual(checkFile("areas/inbox/X.tsx", 'if (typed !== "reject all") return;'), [
      "areas/inbox/X.tsx:1: compare typed confirmations with typedConfirmationMatches",
    ]);
    assert.deepEqual(checkFile("areas/inbox/X.tsx", 'if (!typedConfirmationMatches(typed, "reject all")) return;'), []);
    assert.deepEqual(checkFile("areas/settings/X.tsx", '<Dialog title="Unsaved provider draft">'), [
      "areas/settings/X.tsx:1: use the shared UnsavedChangesDialog for unsaved changes",
    ]);
    assert.deepEqual(checkFile("ui/UnsavedChangesDialog.tsx", '<Dialog title="Unsaved changes">'), []);
  });

  it("rejects an empty grant list described as allowing everything", () => {
    assert.deepEqual(checkFile("areas/system/X.tsx", 'help="Comma-separated. Leave empty to allow every host."'), [
      "areas/system/X.tsx:1: an empty list must not silently mean every host",
    ]);
  });
});
