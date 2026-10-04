import { NativeButton, StatusChip } from "@next/features/native-routes/primitives";
import { describeCoverage } from "../runner/report";
import type { CoverageReport } from "../runner/routes";
import type { TargetInfo } from "../gateway-target/detect-target";
import { buildTargetHref } from "../gateway-target/resolve-target";

export interface TopBarProps {
  readonly target: TargetInfo;
  readonly coverage: CoverageReport | undefined;
  readonly manifestError: string | undefined;
  readonly running: boolean;
  readonly allowHost: boolean;
  readonly copyNotice: string | undefined;
  readonly onAllowHostChange: (value: boolean) => void;
  readonly onRunAll: () => void;
  readonly onStop: () => void;
  readonly onCopyReport: () => void;
}

export function TopBar(props: TopBarProps) {
  const { target } = props;
  const otherTarget = target.requested === "sandbox" ? "real" : "sandbox";
  return (
    <header className="testbench-topbar">
      <div className="testbench-target">
        <StatusChip tone={target.kind === "sandbox" ? "success" : "warning"}>
          {target.kind === "sandbox" ? "SANDBOX ✓ verified" : "REAL gateway"}
        </StatusChip>
        <span className="testbench-meta">
          {target.origin}
          {target.rootDir ? ` · root ${target.rootDir}` : ""}
        </span>
        {target.reason ? <span className="testbench-meta testbench-warning">{target.reason}</span> : null}
        <a className="testbench-link" href={buildTargetHref(window.location.href, otherTarget)}>
          {otherTarget === "real" ? "Switch to the real gateway" : "Switch to the sandbox"}
        </a>
      </div>
      <CoverageMeter coverage={props.coverage} manifestError={props.manifestError} />
      <div className="testbench-actions">
        <label className="testbench-toggle">
          <input
            type="checkbox"
            checked={props.allowHost}
            disabled={target.kind !== "sandbox" || props.running}
            onChange={(event) => props.onAllowHostChange(event.currentTarget.checked)}
          />
          Allow host checks
        </label>
        <NativeButton type="button" onClick={props.onRunAll} disabled={props.running}>
          Run all allowed
        </NativeButton>
        <NativeButton type="button" variant="outline" onClick={props.onStop} disabled={!props.running}>
          Stop
        </NativeButton>
        <NativeButton type="button" variant="outline" onClick={props.onCopyReport}>
          Copy report
        </NativeButton>
      </div>
      {props.copyNotice ? (
        <span className="testbench-meta" role="status">
          {props.copyNotice}
        </span>
      ) : null}
    </header>
  );
}

function CoverageMeter({
  coverage,
  manifestError,
}: {
  readonly coverage: CoverageReport | undefined;
  readonly manifestError: string | undefined;
}) {
  if (!coverage) {
    return (
      <div className="testbench-coverage">
        <span className="testbench-meta">{`Coverage unavailable${manifestError ? `: ${manifestError}` : ""}`}</span>
      </div>
    );
  }
  return (
    <div className="testbench-coverage">
      <span className="testbench-meta">{`Coverage ${describeCoverage(coverage)}`}</span>
      <progress
        className="testbench-progress"
        max={Math.max(1, coverage.total)}
        value={coverage.covered}
        aria-label="Route coverage"
      />
    </div>
  );
}
