// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { QualitySource } from "./QualityEvidence";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function show(element: React.ReactElement): string {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(element));
  return container.textContent ?? "";
}

it("says nothing is recorded yet, with its hint, instead of calling an empty source unavailable", () => {
  const text = show(
    <QualitySource title="Model evaluations" state="not_available" emptyHint="X.">
      <p>body</p>
    </QualitySource>,
  );
  expect(text).toContain("Model evaluations: none recorded yet. X.");
  expect(text).not.toContain("unavailable");
  expect(text).not.toContain("body");
});

it("still reads unavailable for an unknown state and for an error", () => {
  expect(
    show(
      <QualitySource title="Model evaluations" state="unknown" emptyHint="X.">
        <p>body</p>
      </QualitySource>,
    ),
  ).toContain("Model evaluations: availability unknown.");
  act(() => root?.unmount());
  container?.remove();
  expect(
    show(
      <QualitySource title="Model evaluations" state="not_available" error="Gateway down" emptyHint="X.">
        <p>body</p>
      </QualitySource>,
    ),
  ).toContain("Model evaluations: unavailable.");
});

it("keeps the unavailable wording for a source that passes no hint (shipped definitions, computed coverage)", () => {
  const text = show(
    <QualitySource title="Security execution coverage" state="not_available">
      <p>body</p>
    </QualitySource>,
  );
  expect(text).toContain("Security execution coverage: unavailable. No results are available for this source.");
  expect(text).not.toContain("none recorded yet");
});
