import { renderToStaticMarkup } from "react-dom/server";
import type { ImprovementActivationRecord } from "@goatcitadel/contracts";
import { expect, it } from "vitest";
import { ImprovementWatchEvidence } from "./ImprovementWatchEvidence";

const activation = {
  status: "active",
  watchStatus: "insufficient_evidence",
  positiveSignalCount: 0,
  watchSignalTarget: 5,
  regressionCount: 0,
  watchEvidenceStatus: "observed",
} as ImprovementActivationRecord;
const render = (patch: Partial<ImprovementActivationRecord> = {}) =>
  renderToStaticMarkup(<ImprovementWatchEvidence activation={{ ...activation, ...patch }} />);

it("shows no-traffic expiry as more usage needed, not stability", () => {
  expect(render()).toContain("Monitoring ended; more usage needed.");
  expect(render()).toContain("Relevant positives: 0 / 5");
  expect(render()).not.toContain("Monitoring met the target for this change");
});
it("does not call an old stable record verified", () => {
  const html = render({
    watchStatus: "stable",
    watchEvidenceStatus: "legacy_unverified",
    positiveSignalCount: undefined,
  });
  expect(html).toContain("results are unverified");
  expect(html).toContain("Relevant positives: Not verified");
  expect(html).not.toContain("Monitoring met the target for this change");
});
it.each([
  { positiveSignalCount: 4 },
  { watchEvidenceStatus: "partial" as const, positiveSignalCount: 5 },
  { positiveSignalCount: 5, regressionCount: 1 },
])("withholds stability without complete relevant positive coverage: %j", (patch) => {
  expect(render({ watchStatus: "stable", ...patch })).toContain("more usage needed");
});
it("distinguishes watching, target met, paused and rollback without a broad quality claim", () => {
  expect(render({ watchStatus: "watching", positiveSignalCount: 1 })).toContain("Monitoring is in progress");
  expect(render({ watchStatus: "stable", positiveSignalCount: 5 })).toContain(
    "Monitoring met the target for this change",
  );
  expect(render({ watchStatus: "paused", status: "paused", regressionCount: 1 })).toContain("Monitoring paused");
  expect(render({ status: "rolled_back" })).toContain("Change rolled back");
  expect(render({ watchStatus: "stable", positiveSignalCount: 5 })).toContain(
    "do not establish general task improvement",
  );
});
