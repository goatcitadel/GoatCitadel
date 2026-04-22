export function BlocksShuffleLoader({
  compact = false,
  label,
}: {
  compact?: boolean;
  label?: string;
}) {
  return (
    <div className={`mc-next-blocks-loader${compact ? " compact" : ""}`} role="status" aria-live="polite">
      <div className="mc-next-blocks-loader-grid" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      {label ? <span className="mc-next-blocks-loader-label">{label}</span> : null}
    </div>
  );
}
