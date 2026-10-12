import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './ui';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

/**
 * A right-click menu of the app's own actions. `open` from an onContextMenu
 * handler; render `element` anywhere.
 */
export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const element = menu
    ? createPortal(<Menu {...menu} onClose={() => setMenu(null)} />, document.body)
    : null;
  return { open, element };
}

function Menu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(0);
  // Keep it on screen: open up or left of the pointer near the edges.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, y + height > window.innerHeight - 8 ? y - height : y),
    });
    el.focus();
  }, [x, y]);
  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('wheel', onClose);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('wheel', onClose);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  const choose = (item: MenuItem) => {
    onClose();
    item.onSelect();
  };
  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      className="island rise fixed z-[70] min-w-48 rounded-2xl p-1.5 outline-none"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = items.length;
          setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          choose(items[active]!);
        }
      }}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          role="menuitem"
          onMouseEnter={() => setActive(i)}
          onClick={() => choose(item)}
          className={cx(
            'flex w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-left text-sm',
            i === active && (item.danger ? 'bg-danger text-white' : 'bg-hover'),
            item.danger && i !== active && 'text-danger',
          )}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}
