import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  collectResearchHosts,
  isResearchSaturationTurn,
  recordResearchIteration,
  RESEARCH_SATURATION_INSTRUCTION,
  startResearchSaturation,
} from "./research-saturation.js";

let runCounter = 0;

function run(
  toolName: string,
  fields: Partial<Pick<ChatToolRunRecord, "args" | "result" | "status">> = {},
): ChatToolRunRecord {
  runCounter += 1;
  return {
    toolRunId: `run-${runCounter}`,
    turnId: "turn-1",
    sessionId: "session-1",
    toolName,
    status: "executed",
    startedAt: "2026-10-22T00:00:00.000Z",
    ...fields,
  };
}

function searchRun(urls: string[], status: ChatToolRunRecord["status"] = "executed"): ChatToolRunRecord {
  return run("browser.search", {
    status,
    args: { query: "q" },
    result: { results: urls.map((url, index) => ({ title: `Result ${index}`, url })) },
  });
}

describe("RESEARCH_SATURATION_INSTRUCTION", () => {
  it("tells the model to stop searching and answer from its evidence", () => {
    expect(RESEARCH_SATURATION_INSTRUCTION).toBe(
      "Your last two research steps found no new sites. Stop searching and write the answer from the evidence you have, noting any gaps.",
    );
  });
});

describe("collectResearchHosts", () => {
  it("collects search result hosts as listed and dedupes them without a leading www.", () => {
    const { listed, opened } = collectResearchHosts([
      searchRun(["https://www.Example.com/a", "https://example.com/b", "https://news.example.org/c"]),
    ]);
    expect([...listed]).toEqual(["example.com", "news.example.org"]);
    expect(opened.size).toBe(0);
  });

  it("uses the landed URL of an opened page, not the requested URL", () => {
    const { listed, opened } = collectResearchHosts([
      run("browser.navigate", {
        args: { url: "https://redirect.example/r?1" },
        result: { finalUrl: "https://www.landed.example/page" },
      }),
      run("http.get", { args: { url: "https://plain.example/page" } }),
    ]);
    expect([...opened]).toEqual(["landed.example", "plain.example"]);
    expect(listed.size).toBe(0);
  });

  it("ignores failed and blocked runs", () => {
    const { listed, opened } = collectResearchHosts([
      searchRun(["https://failed-search.example/a"], "failed"),
      run("browser.navigate", { status: "failed", args: { url: "https://failed-open.example/" } }),
      run("browser.extract", { status: "blocked", args: { url: "https://blocked.example/" } }),
    ]);
    expect(listed.size + opened.size).toBe(0);
  });

  it("ignores non-research tools, non-http(s) URLs, and malformed search results", () => {
    const { listed, opened } = collectResearchHosts([
      run("http.post", { args: { url: "https://post.example/" } }),
      searchRun(["ftp://files.example/a", "not a url"]),
      run("browser.search", { result: { results: [{ title: "no url" }, null, { url: 42 }] } }),
      run("browser.search", { result: { results: "nope" } }),
      run("browser.search"),
    ]);
    expect(listed.size + opened.size).toBe(0);
  });
});

describe("isResearchSaturationTurn", () => {
  it("applies to Deep mode and research-list budgets but never to Prompt Lab eval-integrity turns", () => {
    expect(isResearchSaturationTurn({ webMode: "deep", budgetProfile: "default", promptLabEvalIntegrity: false })).toBe(
      true,
    );
    expect(
      isResearchSaturationTurn({ webMode: "auto", budgetProfile: "research_list", promptLabEvalIntegrity: false }),
    ).toBe(true);
    expect(isResearchSaturationTurn({ webMode: "auto", budgetProfile: "default", promptLabEvalIntegrity: false })).toBe(
      false,
    );
    expect(
      isResearchSaturationTurn({ webMode: "quick", budgetProfile: undefined, promptLabEvalIntegrity: false }),
    ).toBe(false);
    expect(
      isResearchSaturationTurn({ webMode: "deep", budgetProfile: "research_list", promptLabEvalIntegrity: true }),
    ).toBe(false);
  });
});

describe("recordResearchIteration", () => {
  const sameTwo = ["https://a.example/1", "https://b.example/2"];

  it("nudges after two consecutive web iterations that add no new hosts", () => {
    const toolRuns: ChatToolRunRecord[] = [searchRun(sameTwo)];
    let state = startResearchSaturation(toolRuns);

    const firstRun = searchRun(sameTwo);
    toolRuns.push(firstRun);
    const first = recordResearchIteration(state, { toolRuns, iterationRuns: [firstRun] });
    expect(first.nudge).toBe(false);
    state = first.state;

    const secondRun = searchRun(sameTwo);
    toolRuns.push(secondRun);
    const second = recordResearchIteration(state, { toolRuns, iterationRuns: [secondRun] });
    expect(second.nudge).toBe(true);
  });

  it("nudges at most once per turn", () => {
    const toolRuns: ChatToolRunRecord[] = [searchRun(sameTwo)];
    let state = startResearchSaturation(toolRuns);
    const nudges: boolean[] = [];
    for (let index = 0; index < 5; index += 1) {
      const iterationRun = searchRun(sameTwo);
      toolRuns.push(iterationRun);
      const step = recordResearchIteration(state, { toolRuns, iterationRuns: [iterationRun] });
      nudges.push(step.nudge);
      state = step.state;
    }
    expect(nudges).toEqual([false, true, false, false, false]);
  });

  it("resets the streak when an iteration finds a new host", () => {
    const toolRuns: ChatToolRunRecord[] = [searchRun(sameTwo)];
    let state = startResearchSaturation(toolRuns);
    const script = [sameTwo, [...sameTwo, "https://c.example/3"], sameTwo, sameTwo];
    const nudges: boolean[] = [];
    for (const urls of script) {
      const iterationRun = searchRun(urls);
      toolRuns.push(iterationRun);
      const step = recordResearchIteration(state, { toolRuns, iterationRuns: [iterationRun] });
      nudges.push(step.nudge);
      state = step.state;
    }
    expect(nudges).toEqual([false, false, false, true]);
  });

  it("resets the streak when an iteration runs no web tool, and counts failed web runs as web steps", () => {
    const toolRuns: ChatToolRunRecord[] = [searchRun(sameTwo)];
    let state = startResearchSaturation(toolRuns);
    const iterations: ChatToolRunRecord[][] = [
      [searchRun(sameTwo)],
      [run("memory.search", { args: { query: "notes" } })],
      [],
      [searchRun(sameTwo)],
      [run("browser.navigate", { status: "failed", args: { url: "https://a.example/1" } })],
    ];
    const nudges: boolean[] = [];
    for (const iterationRuns of iterations) {
      toolRuns.push(...iterationRuns);
      const step = recordResearchIteration(state, { toolRuns, iterationRuns });
      nudges.push(step.nudge);
      state = step.state;
    }
    expect(nudges).toEqual([false, false, false, false, true]);
  });

  it("counts hosts already known before the loop as the baseline", () => {
    const toolRuns: ChatToolRunRecord[] = [];
    let state = startResearchSaturation(toolRuns);
    const nudges: boolean[] = [];
    for (let index = 0; index < 3; index += 1) {
      const iterationRun = searchRun(sameTwo);
      toolRuns.push(iterationRun);
      const step = recordResearchIteration(state, { toolRuns, iterationRuns: [iterationRun] });
      nudges.push(step.nudge);
      state = step.state;
    }
    expect(nudges).toEqual([false, false, true]);
  });

  it("counts opening a page on an already listed site as progress, and nudges only once nothing new is added", () => {
    const toolRuns: ChatToolRunRecord[] = [searchRun(sameTwo)];
    let state = startResearchSaturation(toolRuns);
    const iterations: ChatToolRunRecord[][] = [
      [run("browser.navigate", { args: { url: "https://a.example/1" }, result: { finalUrl: "https://a.example/1" } })],
      [run("browser.navigate", { args: { url: "https://b.example/2" }, result: { finalUrl: "https://b.example/2" } })],
      [searchRun(sameTwo)],
      [searchRun(sameTwo)],
    ];
    const nudges: boolean[] = [];
    for (const iterationRuns of iterations) {
      toolRuns.push(...iterationRuns);
      const step = recordResearchIteration(state, { toolRuns, iterationRuns });
      nudges.push(step.nudge);
      state = step.state;
    }
    expect(nudges).toEqual([false, false, false, true]);
  });

  it("nudges when passes keep re-opening a site that was already opened and list nothing new", () => {
    const toolRuns: ChatToolRunRecord[] = [searchRun(sameTwo)];
    let state = startResearchSaturation(toolRuns);
    const open = () =>
      run("browser.navigate", { args: { url: "https://a.example/1" }, result: { finalUrl: "https://a.example/1" } });
    const nudges: boolean[] = [];
    for (let index = 0; index < 4; index += 1) {
      const iterationRuns = [open()];
      toolRuns.push(...iterationRuns);
      const step = recordResearchIteration(state, { toolRuns, iterationRuns });
      nudges.push(step.nudge);
      state = step.state;
    }
    expect(nudges).toEqual([false, false, true, false]);
  });

  it("does not mutate the state it was given", () => {
    const toolRuns: ChatToolRunRecord[] = [searchRun(sameTwo)];
    const state = startResearchSaturation(toolRuns);
    const snapshot = { ...state };
    const iterationRun = searchRun(sameTwo);
    toolRuns.push(iterationRun);
    recordResearchIteration(state, { toolRuns, iterationRuns: [iterationRun] });
    expect(state).toEqual(snapshot);
  });
});
