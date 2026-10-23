import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import type { PresenceStatus } from '@crocodile/protocol';
import { colorFor, initials } from '../lib/format';
import { useCroc } from '../croc';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'soft';

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-accent text-on-accent hover:brightness-110 shadow-[0_4px_14px_-4px_var(--accent)]',
    secondary: 'bg-raised text-text hover:bg-hover border border-line',
    danger: 'bg-danger text-white hover:brightness-110',
    ghost: 'bg-transparent text-text-2 hover:text-text hover:bg-hover',
    soft: 'bg-accent-soft text-accent hover:brightness-125',
  };
  return (
    <button
      {...props}
      className={cx(
        'inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        className,
      )}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        'selectable h-11 w-full rounded-xl border border-line bg-field px-4 text-[15px] text-text outline-none transition placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent-soft',
        className,
      )}
    />
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-[12px] font-semibold tracking-wide text-muted">{children}</div>;
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
  icon,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  icon?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          'island rise relative max-h-[90vh] overflow-hidden rounded-3xl',
          wide ? 'w-[660px]' : 'w-[460px]',
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className="absolute right-4 top-4 rounded-full p-1.5 text-muted hover:bg-hover hover:text-text"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={18} />
        </button>
        {title && (
          <div className="px-7 pt-7">
            {icon && (
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                {icon}
              </div>
            )}
            <h2 className="text-xl font-bold text-text">{title}</h2>
            {subtitle && (
              <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{subtitle}</p>
            )}
          </div>
        )}
        <div className="max-h-[62vh] overflow-y-auto px-7 py-5">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line px-7 py-4">{footer}</div>
        )}
      </div>
    </div>
  );
}

const STATUS_COLOR: Record<PresenceStatus, string> = {
  online: 'bg-online',
  idle: 'bg-idle',
  dnd: 'bg-dnd',
  offline: 'bg-faint',
};

export function StatusDot({
  status,
  className,
  size = 12,
}: {
  status: PresenceStatus;
  className?: string;
  size?: number;
}) {
  return (
    <span
      className={cx('block rounded-full border-island', STATUS_COLOR[status], className)}
      style={{
        width: size,
        height: size,
        borderWidth: Math.max(2, Math.round(size / 4.5)),
        borderColor: 'var(--island)',
      }}
    />
  );
}

/** Rounded-square avatars (not circles): part of Crocodile's look. */
export function Avatar({
  userId,
  size = 32,
  status,
  speaking,
  round,
  className,
}: {
  userId: string;
  size?: number;
  status?: PresenceStatus | 'auto';
  speaking?: boolean;
  round?: boolean;
  className?: string;
}) {
  const profile = useCroc((s) => s.profiles[userId]);
  const presence = useCroc((s) =>
    userId === s.me?.userId
      ? s.link === 'connected'
        ? s.settings.status === 'invisible'
          ? 'offline'
          : s.settings.status
        : 'offline'
      : (s.presence[userId] ?? 'offline'),
  );
  const name = profile?.username ?? '…';
  const shown = status === 'auto' ? (presence as PresenceStatus) : status;
  const radius = round ? '9999px' : `${Math.round(size * 0.32)}px`;
  return (
    <div
      className={cx('relative shrink-0', speaking && 'ripples', className)}
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden font-bold text-white"
        style={{
          borderRadius: radius,
          background: profile?.avatar
            ? undefined
            : `linear-gradient(135deg, ${colorFor(userId)}, color-mix(in oklab, ${colorFor(userId)} 60%, black))`,
          fontSize: size * 0.36,
          boxShadow: speaking ? '0 0 0 2px var(--island), 0 0 0 4px var(--accent)' : undefined,
        }}
      >
        {profile?.avatar ? (
          <img
            src={profile.avatar}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          initials(name)
        )}
      </div>
      {shown && (
        <StatusDot
          status={shown}
          size={Math.max(10, Math.round(size * 0.34))}
          className="absolute -bottom-0.5 -right-0.5"
        />
      )}
    </div>
  );
}

export function UserName({ userId, className }: { userId: string; className?: string }) {
  const name = useCroc((s) => s.profiles[userId]?.username);
  return <span className={className}>{name ?? 'Unknown'}</span>;
}

export function IconButton({
  label,
  children,
  active,
  danger,
  onClick,
  className,
  size = 36,
  disabled,
  title,
}: {
  label: string;
  children: ReactNode;
  active?: boolean;
  danger?: boolean;
  onClick?: () => void;
  className?: string;
  size?: number;
  disabled?: boolean;
  /** Tooltip, if not the label (why it is disabled, say). */
  title?: string;
}) {
  return (
    <button
      title={title ?? label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      style={{ width: size, height: size }}
      className={cx(
        'flex shrink-0 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40',
        danger
          ? 'bg-danger/15 text-danger hover:bg-danger/25'
          : active
            ? 'bg-accent-soft text-accent'
            : 'text-muted hover:bg-hover hover:text-text',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Small popover menu anchored to its trigger. */
export function Menu({
  trigger,
  children,
  align = 'left',
  up,
}: {
  trigger: (open: () => void, isOpen: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && (
        <div
          className={cx(
            'island rise absolute z-40 min-w-[220px] rounded-2xl p-1.5',
            align === 'right' ? 'right-0' : 'left-0',
            up ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  hint,
  onClick,
  danger,
}: {
  icon?: ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[14px] transition',
        danger ? 'text-danger hover:bg-danger/10' : 'text-text-2 hover:bg-hover hover:text-text',
      )}
    >
      {icon && <span className="text-muted">{icon}</span>}
      <span className="flex-1">{label}</span>
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </button>
  );
}

export function Toasts() {
  const errors = useCroc((s) => s.errors);
  return (
    <div className="pointer-events-none fixed bottom-24 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {errors.map((e) => (
        <div
          key={e.id}
          role={e.kind === 'info' ? 'status' : 'alert'}
          className={cx(
            'rise pointer-events-auto rounded-full px-5 py-2.5 text-sm font-semibold shadow-lg',
            e.kind === 'info' ? 'island text-text' : 'bg-danger text-white',
          )}
        >
          {e.message}
        </div>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        onChange(!checked);
      }}
      className={cx(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-active',
      )}
    >
      <span
        className={cx(
          'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
          checked ? 'left-[22px]' : 'left-0.5',
        )}
      />
    </button>
  );
}

export function Select({
  value,
  onChange,
  children,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  label?: string;
}) {
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className="h-11 w-full rounded-xl border border-line bg-field px-3 text-sm text-text outline-none focus:border-accent"
    >
      {children}
    </select>
  );
}

/** A row of mutually exclusive choices, the chosen one raised. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-full bg-field p-1">
      {options.map((o) => (
        <button
          key={o.id}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={cx(
            'flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition',
            value === o.id ? 'bg-island text-text shadow' : 'text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
