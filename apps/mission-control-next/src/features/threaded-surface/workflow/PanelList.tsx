export function PanelList({
  title,
  items,
  emptyCopy,
}: {
  title: string;
  items: Array<{
    id: string;
    title: string;
    status?: string | null;
    meta?: string | null;
    note?: string | null;
    tone?: "warning" | null;
  }>;
  emptyCopy: string;
}) {
  return (
    <section className="mc-next-panel-list">
      <p className="mc-next-panel-kicker">{title}</p>
      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item.id} data-tone={item.tone ?? undefined}>
              <div className="mc-next-panel-list-head">
                <strong>{item.title}</strong>
                {item.status ? <span>{item.status}</span> : null}
              </div>
              {item.meta ? <p>{item.meta}</p> : null}
              {item.note ? <p>{item.note}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>{emptyCopy}</p>
      )}
    </section>
  );
}
