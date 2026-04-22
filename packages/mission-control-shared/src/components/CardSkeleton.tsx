export function CardSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <article className="card skeleton-card" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }).map((_, index) => (
        <div key={index} className="skeleton-line" />
      ))}
    </article>
  );
}
