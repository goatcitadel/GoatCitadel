interface PageTabItem {
  id: string;
  label: string;
}

interface PageTabsProps {
  items: PageTabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  vertical?: boolean;
  className?: string;
}

export function PageTabs({ items, activeId, onSelect, vertical = false, className }: PageTabsProps) {
  return (
    <nav className={`page-tabs${vertical ? " page-tabs-vertical" : ""}${className ? ` ${className}` : ""}`} aria-label="Section tabs">
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          className={`page-tab${item.id === activeId ? " active" : ""}`}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
