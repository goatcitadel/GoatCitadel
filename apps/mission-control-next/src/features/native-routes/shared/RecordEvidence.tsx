/** Secondary, complete inspection of already authorized API fields. Never treats absence as zero. */
export function RecordEvidence({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>Unavailable</span>;
  if (typeof value !== "object") return <span>{String(value)}</span>;
  const fields = Object.entries(value);
  if (!fields.length) return <span>No entries</span>;
  return (
    <dl className="mc-next-worker-record">
      {fields.map(([key, field]) => (
        <div key={key}>
          <dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt>
          <dd>
            <RecordEvidence value={field} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
