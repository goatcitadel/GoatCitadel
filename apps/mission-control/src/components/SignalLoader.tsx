interface SignalLoaderProps {
  label?: string;
  compact?: boolean;
}

export function SignalLoader({ label = "Working...", compact = false }: SignalLoaderProps) {
  return (
    <span className={`signal-loader ${compact ? "compact" : ""}`} role="status" aria-live="polite">
      <span className="signal-loader-bars" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{label}</span>
    </span>
  );
}
