import { useMemo, useState } from "react";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { EmptyState, ErrorState, NoticeBanner } from "@next/features/native-routes/primitives";
import { domainLabel } from "../catalog/domains";
import type { TestbenchEnv } from "../env";
import { checkPermission } from "../runner/policy";
import { buildMarkdownReport } from "../runner/report";
import { countStatuses, recordFor } from "../runner/state";
import type { CheckDef } from "../runner/types";
import type { TargetInfo } from "../gateway-target/detect-target";
import type { TargetRequest } from "../gateway-target/resolve-target";
import { AreaRail } from "./AreaRail";
import { CheckDrawer } from "./CheckDrawer";
import { CheckList } from "./CheckList";
import { FilterBar } from "./FilterBar";
import { DEFAULT_FILTERS, filterChecks, summarizeDomains, type CheckFilters } from "./filters";
import { describeRunEnd } from "./status-display";
import { TopBar } from "./TopBar";
import { UncoveredRoutes } from "./UncoveredRoutes";
import {
  DEFAULT_TESTBENCH_DEPS,
  useTestbench,
  type ReadyLoad,
  type TestbenchController,
  type TestbenchDeps,
} from "./use-testbench";

type TabId = "console" | "uncovered";

export interface TestbenchAppProps {
  readonly targetRequest: TargetRequest;
  readonly env: TestbenchEnv;
  readonly deps?: TestbenchDeps;
}

export function TestbenchApp({ targetRequest, env, deps = DEFAULT_TESTBENCH_DEPS }: TestbenchAppProps) {
  const bench = useTestbench(targetRequest, env, deps);
  if (bench.load.phase === "loading") {
    return (
      <main className="testbench-shell">
        <EmptyState title="Connecting to the gateway…" />
      </main>
    );
  }
  if (bench.load.phase === "blocked") {
    return (
      <main className="testbench-shell">
        <ErrorState title={bench.load.title} description={bench.load.detail} />
      </main>
    );
  }
  return <ReadyView bench={bench} load={bench.load} />;
}

function ReadyView({ bench, load }: { readonly bench: TestbenchController; readonly load: ReadyLoad }) {
  const [tab, setTab] = useState<TabId>("console");
  const [filters, setFilters] = useState<CheckFilters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [pendingExternal, setPendingExternal] = useState<CheckDef | undefined>(undefined);
  const [copyNotice, setCopyNotice] = useState<string | undefined>(undefined);
  const { runState, options } = bench;
  const visible = useMemo(() => filterChecks(load.checks, runState, filters), [load.checks, runState, filters]);
  const domains = useMemo(() => summarizeDomains(load.checks, runState, domainLabel), [load.checks, runState]);
  const counts = useMemo(
    () =>
      countStatuses(
        runState,
        load.checks.map((check) => check.id),
      ),
    [runState, load.checks],
  );
  const selected = load.checks.find((check) => check.id === selectedId);

  const requestRun = (check: CheckDef) => {
    if (check.tier === "external" && !options.confirmedExternalIds.has(check.id)) {
      setPendingExternal(check);
      return;
    }
    bench.run([check.id]);
  };
  // External checks stay clickable before confirmation: clicking opens the confirmation dialog.
  const permissionOf = (check: CheckDef) =>
    checkPermission(check, load.target, {
      ...options,
      confirmedExternalIds: new Set([...options.confirmedExternalIds, check.id]),
    });
  const confirmExternal = () => {
    if (pendingExternal) {
      bench.run([pendingExternal.id], pendingExternal.id);
    }
    setPendingExternal(undefined);
  };
  const copyReport = () => {
    const markdown = buildMarkdownReport({
      target: load.target,
      coverage: bench.coverage,
      checks: load.checks,
      state: runState,
      generatedAt: new Date().toISOString(),
    });
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) {
      setCopyNotice("Copy failed: this browser does not expose the clipboard.");
      return;
    }
    clipboard.writeText(markdown).then(
      () => setCopyNotice("Report copied as Markdown."),
      () => setCopyNotice("Copy failed: the browser blocked clipboard access."),
    );
  };

  return (
    <main className="testbench-shell">
      <TopBar
        target={load.target}
        coverage={bench.coverage}
        manifestError={load.manifestError}
        running={runState.running}
        allowHost={options.allowHost}
        copyNotice={copyNotice}
        onAllowHostChange={bench.setAllowHost}
        onRunAll={() => bench.run(load.checks.map((check) => check.id))}
        onStop={bench.stop}
        onCopyReport={copyReport}
      />
      {runState.banner ? <NoticeBanner tone="error" message={runState.banner} /> : null}
      <div className="testbench-tabs" role="tablist" aria-label="Test bench views">
        <button type="button" role="tab" aria-selected={tab === "console"} onClick={() => setTab("console")}>
          Live console
        </button>
        <button type="button" role="tab" aria-selected={tab === "uncovered"} onClick={() => setTab("uncovered")}>
          {`Uncovered routes (${bench.coverage ? bench.coverage.uncovered.length : "unavailable"})`}
        </button>
      </div>
      {tab === "console" ? (
        <>
          <FilterBar filters={filters} counts={counts} onChange={setFilters} />
          <div className="testbench-panes">
            <AreaRail
              domains={domains}
              selected={filters.domain}
              onSelect={(domain) => setFilters({ ...filters, domain })}
            />
            <CheckList
              checks={visible}
              state={runState}
              selectedId={selectedId}
              running={runState.running}
              onSelect={setSelectedId}
              onRun={requestRun}
              permissionOf={permissionOf}
            />
            <CheckDrawer
              check={selected}
              record={selected ? recordFor(runState, selected.id) : undefined}
              onClose={() => setSelectedId(undefined)}
            />
          </div>
        </>
      ) : (
        <UncoveredRoutes coverage={bench.coverage} labelFor={domainLabel} />
      )}
      <p className="testbench-sr-only" role="status" aria-live="polite">
        {describeRunEnd(runState, counts)}
      </p>
      <ConfirmModal
        open={pendingExternal !== undefined}
        title="Run an external check?"
        message={pendingExternal ? externalConfirmMessage(pendingExternal, load.target) : ""}
        confirmLabel="Run it"
        onConfirm={confirmExternal}
        onCancel={() => setPendingExternal(undefined)}
      />
    </main>
  );
}

function externalConfirmMessage(check: CheckDef, target: TargetInfo): string {
  const where = target.kind === "sandbox" ? "the sandbox gateway" : `the real gateway at ${target.origin}`;
  return [`“${check.title}” runs against ${where} and leaves this machine.`, check.description]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}
