import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkFile,
  countDestructiveMarkers,
  DESTRUCTIVE_MARKER_BUDGET,
} from "./check-mission-control-next-danger-actions.mjs";

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

  it("rejects reversible verbs anywhere in a multi-condition variant expression", () => {
    const findings = checkFile(
      "areas/work/X.tsx",
      'variant={entry.id === "cancel" || entry.id === "retry" || entry.id === "recover" ? "danger" : "secondary"}',
    );
    assert.equal(findings.length, 1);
    assert.match(findings[0], /areas\/work\/X\.tsx:1: .*reversible/);
  });

  it("resolves a dynamic label assigned from one literal in the same file", () => {
    const source = 'const label = "Retry run";\n<Button variant="danger" onClick={retry}>{label}</Button>';
    assert.deepEqual(checkFile("areas/inbox/X.tsx", source), [
      'areas/inbox/X.tsx:2: "Retry run" is reversible and must not be red',
    ]);
  });

  it("allows an explicitly marked destructive action id", () => {
    const marked =
      '{/* danger-actions: destructive cancel — the "cancel" action deletes the schedule */}\n<Button variant={pending === "cancel" ? "danger" : "primary"}>';
    assert.deepEqual(checkFile("areas/work/X.tsx", marked), []);
  });

  it("resolves a dynamic label whose every literal option is reversible", () => {
    const source =
      'const label = item.kind === "dead_letter" ? "Recover run" : "Retry run";\n<Button variant="danger">{label}</Button>';
    assert.deepEqual(checkFile("areas/inbox/X.tsx", source), [
      'areas/inbox/X.tsx:2: "Recover run" is reversible and must not be red',
    ]);
    const mixed = 'const label = gone ? "Delete file" : "Retry run";\n<Button variant="danger">{label}</Button>';
    assert.deepEqual(checkFile("areas/inbox/X.tsx", mixed), []);
  });

  it("rejects a red send-for-approval or single reject", () => {
    assert.deepEqual(checkFile("areas/library/X.tsx", '<Button variant="danger">Request send approval</Button>'), [
      'areas/library/X.tsx:1: "Request send approval" is reversible and must not be red',
    ]);
    assert.deepEqual(checkFile("areas/inbox/X.tsx", '<Button variant="danger">Reject proposal</Button>'), [
      'areas/inbox/X.tsx:1: "Reject proposal" is reversible and must not be red',
    ]);
  });

  it("keeps bulk rejects and discarding unsaved work red", () => {
    assert.deepEqual(checkFile("areas/inbox/X.tsx", '<Button variant="danger">Reject all pending</Button>'), []);
    assert.deepEqual(checkFile("areas/settings/X.tsx", '<Button variant="danger">Discard changes</Button>'), []);
  });

  it("exempts only the id a destructive marker names", () => {
    const wider =
      '{/* danger-actions: destructive cancel */}\n<Button variant={pending === "cancel" || pending === "pause" ? "danger" : "primary"}>';
    assert.equal(checkFile("areas/work/X.tsx", wider).length, 1);
    const unnamed =
      '{/* danger-actions: destructive */}\n<Button variant={pending === "cancel" ? "danger" : "primary"}>';
    assert.equal(checkFile("areas/work/X.tsx", unnamed).length, 1);
  });

  it("finds a reversible verb after a leading Confirm or Review", () => {
    assert.equal(checkFile("areas/work/X.tsx", '<Button variant="danger">Confirm retry</Button>').length, 1);
    assert.equal(checkFile("areas/work/X.tsx", '<Button variant="danger">Confirm cancel run</Button>').length, 1);
    assert.deepEqual(
      checkFile("areas/inbox/X.tsx", '<Button variant="danger">Confirm installation-wide rejection</Button>'),
      [],
    );
  });

  it("resolves a prettier-wrapped ternary label", () => {
    const source =
      'const label = isDeadLetter\n  ? "Recover run"\n  : "Retry run";\n<Button variant="danger">{label}</Button>';
    assert.equal(checkFile("areas/inbox/X.tsx", source).length, 1);
  });

  it("reads the whole condition across calls, and only the branch that yields danger", () => {
    assert.equal(
      checkFile("areas/work/X.tsx", 'variant={id === "retry" && canRetry(id) ? "danger" : "secondary"}').length,
      1,
    );
    assert.deepEqual(
      checkFile("areas/work/X.tsx", 'variant={a === "deny" ? "secondary" : b === "delete" ? "danger" : "primary"}'),
      [],
    );
  });

  it("rejects the inverted form that paints a reversible action red", () => {
    assert.equal(checkFile("areas/work/X.tsx", 'variant={id !== "cancel" ? "secondary" : "danger"}').length, 1);
  });

  it("counts destructive markers so a new exemption is a visible budget change", () => {
    assert.equal(
      countDestructiveMarkers("// danger-actions: destructive cancel\n// danger-actions: destructive remove"),
      2,
    );
    assert.equal(countDestructiveMarkers("no markers here"), 0);
    // The tree holds one: a schedule's "cancel" deletes it (WorkScheduleInspector).
    assert.equal(DESTRUCTIVE_MARKER_BUDGET, 1);
  });
});
