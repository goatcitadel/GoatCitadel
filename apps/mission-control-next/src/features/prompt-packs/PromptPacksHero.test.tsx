// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmbeddedPageHeaderProvider } from "../native-routes/embedded-page-header";
import { PromptPacksHero, type PromptPacksHeroProps } from "./PromptPacksHero";

const props: PromptPacksHeroProps = {
  isOpsVariant: false,
  title: "Prompt packs",
  subtitle: "Manage packs, run tests, and review one selected case at a time.",
  summaryCards: [
    { label: "Selected pack", value: "Core regression", detail: "12 tests loaded" },
    { label: "Latest attempts", value: "4/12", detail: "8 not run" },
  ],
  hasReport: false,
  error: null,
  success: null,
  activeRun: null,
  selectedPackId: "pack-1",
  testsLength: 12,
  running: false,
  benchmarkActive: false,
  autoScoring: false,
  unscoredCompletedCount: 0,
  isRefreshing: false,
  onRunNext: () => undefined,
  onRunAll: () => undefined,
  onAutoScoreUnscored: () => undefined,
  onRefresh: () => undefined,
};

function render(embedded: boolean) {
  const container = document.createElement("div");
  const hero = <PromptPacksHero {...props} />;
  container.innerHTML = renderToStaticMarkup(
    embedded ? <EmbeddedPageHeaderProvider>{hero}</EmbeddedPageHeaderProvider> : hero,
  );
  return container;
}

describe("prompt-pack hero", () => {
  it("keeps the standalone hero h1 and summary tiles outside an embedding host", () => {
    const container = render(false);
    expect(container.querySelector("h1")?.textContent).toBe("Prompt packs");
    expect(container.querySelectorAll(".mc-pp-summary-card")).toHaveLength(2);
    expect(container.querySelector("dl")).toBeNull();
  });

  it("leads with a sentence and an inline definition list, without an h1, inside an embedding host", () => {
    const container = render(true);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector(".mc-pp-summary-card")).toBeNull();
    const overview = container.querySelector('section[aria-label="Prompt pack overview"]');
    expect(overview?.querySelector("p")?.textContent).toBe(props.subtitle);
    const rows = [...(overview?.querySelectorAll("dl > div") ?? [])];
    expect(rows.map((row) => row.querySelector("dt")?.textContent)).toEqual(["Selected pack", "Latest attempts"]);
    expect([...rows[0]!.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual([
      "Core regression",
      "12 tests loaded",
    ]);
    // Run controls stay reachable in both modes.
    expect(container.querySelector('section[aria-label="Prompt pack run controls"]')).not.toBeNull();
  });
});
