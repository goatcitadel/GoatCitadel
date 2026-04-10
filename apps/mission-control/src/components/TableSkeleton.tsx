export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <table className="skeleton-table gc-data-table" aria-busy="true" aria-label="Loading table">
      <thead>
        <tr>
          {Array.from({ length: cols }).map((_, index) => (
            <th key={index}>
              <div className="skeleton-line" />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <tr key={rowIndex}>
            {Array.from({ length: cols }).map((_, colIndex) => (
              <td key={colIndex}>
                <div className="skeleton-line" />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}


