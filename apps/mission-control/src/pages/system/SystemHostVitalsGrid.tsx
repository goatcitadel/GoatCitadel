import type { SystemVitalsResponse } from "../../api/client";
import { Panel } from "../../components/Panel";
import { formatBytes } from "./system-page-helpers";

interface SystemHostVitalsGridProps {
  vitals: SystemVitalsResponse;
}

export function SystemHostVitalsGrid({ vitals }: SystemHostVitalsGridProps) {
  return (
    <div className="metric-grid">
      <Panel title="Host Vitals" subtitle="Local machine and process health at a glance." className="stat-card">
        <p className="stat-card-value">{Math.round(vitals.uptimeSeconds)}s</p>
        <p className="stat-card-note">Uptime</p>
        <p className="stat-card-note">
          Hostname {vitals.hostname} · {vitals.cpuCount} cores
        </p>
      </Panel>
      <Panel title="Load Average" subtitle="Three-sample host load average." className="stat-card">
        <p className="stat-card-value system-stat-mono">{vitals.loadAverage.map((n) => n.toFixed(2)).join(" / ")}</p>
        <p className="stat-card-note">1m / 5m / 15m load</p>
      </Panel>
      <Panel title="Memory" subtitle="Host and process memory use." className="stat-card">
        <p className="stat-card-value">{formatBytes(vitals.memoryUsedBytes)}</p>
        <p className="stat-card-note">of {formatBytes(vitals.memoryTotalBytes)} host memory</p>
        <p className="stat-card-note">Process RSS {formatBytes(vitals.processRssBytes)}</p>
      </Panel>
    </div>
  );
}
