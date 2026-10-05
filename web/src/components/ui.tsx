import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import { APPROVAL_LABELS, PUBLISH_LABELS, type ApprovalStatus, type PublishStatus, type Readiness } from '../../../shared/domain';
import { useUi } from '../lib/ui-state';

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'danger' | 'danger-solid' | 'ghost' | 'success' | 'default';
  size?: 'sm' | 'md';
  icon?: ReactNode;
  loading?: boolean;
  iconOnly?: boolean;
};

export function Button({ variant = 'default', size = 'md', icon, loading, iconOnly, children, className = '', disabled, ...rest }: BtnProps) {
  const cls = ['btn', variant !== 'default' && variant, size === 'sm' && 'sm', iconOnly && 'icon', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 size={15} className="spin" /> : icon}
      {children}
    </button>
  );
}

export function Badge({ tone, children, dot, title }: { tone?: string; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={`badge ${tone ?? ''}`} title={title}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

const APPROVAL_TONE: Record<ApprovalStatus, string> = {
  draft: '',
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  revision_requested: 'danger',
};
export const ApprovalBadge = ({ s }: { s: ApprovalStatus }) => <Badge tone={APPROVAL_TONE[s]} dot>{APPROVAL_LABELS[s]}</Badge>;

const PUBLISH_TONE: Record<PublishStatus, string> = {
  unscheduled: '',
  queued: 'info',
  paused: 'warning',
  publishing: 'primary',
  published: 'success',
  partially_published: 'info',
  failed: 'danger',
};
export const PublishBadge = ({ s }: { s: PublishStatus }) => <Badge tone={PUBLISH_TONE[s]}>{PUBLISH_LABELS[s]}</Badge>;

export const ReadinessBadge = ({ r }: { r: Readiness }) =>
  r === 'ready' ? <Badge tone="success">Ready</Badge> : r === 'blocked' ? <Badge tone="danger">Blocked</Badge> : <Badge tone="warning">Needs attention</Badge>;

export const Priority = ({ p }: { p: number | null }) =>
  p ? <span className={`prio p${p}`} title={`Priority ${p}`}>P{p}</span> : <span className="muted small">—</span>;

export function Card({ title, actions, children, bodyClass = 'card-body', className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; bodyClass?: string; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          <span className="spacer" />
          {actions}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <strong style={{ color: 'var(--text-2)' }}>{title}</strong>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} />;
}
export function LoadingRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="stack" style={{ padding: 16 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={18} w={`${90 - (i % 3) * 12}%`} />)}
    </div>
  );
}

export function Callout({ tone = 'info', title, children }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode }) {
  const Icon = tone === 'danger' ? XCircle : tone === 'warning' ? AlertTriangle : tone === 'success' ? CheckCircle2 : Info;
  return (
    <div className={`callout ${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon size={16} />
      <div className="stack-sm" style={{ gap: 2 }}>
        {title && <strong>{title}</strong>}
        {children && <div className="small">{children}</div>}
      </div>
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div style={{ padding: 16 }}>
      <Callout tone="danger" title="Could not load this data">
        {(error as Error)?.message ?? 'Unknown error'}
        {retry && (
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={retry}>Try again</Button>
          </div>
        )}
      </Callout>
    </div>
  );
}

function useEscape(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [onClose, active]);
}

/** Keeps keyboard focus inside a dialog and restores it on close. */
function useFocusTrap(ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !el) return;
      const f = [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')];
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
        e.preventDefault();
        f[0].focus();
      }
    };
    el?.addEventListener('keydown', onKey);
    return () => {
      el?.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [ref]);
}

export function Modal({ title, children, footer, onClose, wide }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useFocusTrap(ref);
  return (
    <>
      <div className="overlay top" onClick={onClose} />
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref}>
        <div className="modal-head">
          <h2 style={{ flex: 1 }}>{title}</h2>
          <Button variant="ghost" size="sm" iconOnly aria-label="Close" onClick={onClose} icon={<X size={16} />} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>
  );
}

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger-solid';
  /** Require an optional comment (e.g. rejection reason). */
  comment?: { label: string; required?: boolean };
  /** Require typing this word to confirm. */
  typeToConfirm?: string;
}

/** Confirmation dialog for consequential actions. Resolves with the comment (or '' ) when confirmed. */
export function useConfirm() {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: string | null) => void }) | null>(null);
  const confirm = (o: ConfirmOptions) => new Promise<string | null>((resolve) => setState({ ...o, resolve }));
  const node = state ? <ConfirmDialog {...state} onDone={(v) => { state.resolve(v); setState(null); }} /> : null;
  return { confirm, node };
}

function ConfirmDialog({ title, body, confirmLabel, tone = 'primary', comment, typeToConfirm, onDone }: ConfirmOptions & { onDone: (v: string | null) => void }) {
  const [text, setText] = useState('');
  const [typed, setTyped] = useState('');
  const blocked = (comment?.required && !text.trim()) || (typeToConfirm && typed !== typeToConfirm);
  return (
    <Modal
      title={title}
      onClose={() => onDone(null)}
      footer={
        <>
          <Button onClick={() => onDone(null)}>Cancel</Button>
          <Button variant={tone} disabled={!!blocked} onClick={() => onDone(text.trim())}>{confirmLabel}</Button>
        </>
      }
    >
      <div className="stack">
        <div style={{ color: 'var(--text-2)' }}>{body}</div>
        {comment && (
          <div className="field">
            <label htmlFor="confirm-comment">{comment.label}{comment.required ? ' (required)' : ''}</label>
            <textarea id="confirm-comment" className="textarea" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          </div>
        )}
        {typeToConfirm && (
          <div className="field">
            <label htmlFor="confirm-type">Type <strong className="mono">{typeToConfirm}</strong> to confirm</label>
            <input id="confirm-type" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
        )}
      </div>
    </Modal>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useUi();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'success' ? <CheckCircle2 size={18} color="var(--success)" /> : t.kind === 'error' ? <XCircle size={18} color="var(--danger)" /> : <Info size={18} color="var(--primary)" />}
          <div style={{ flex: 1 }}>
            <strong>{t.title}</strong>
            {t.body && <div className="small muted">{t.body}</div>}
          </div>
          <Button variant="ghost" size="sm" iconOnly aria-label="Dismiss" onClick={() => dismiss(t.id)} icon={<X size={14} />} />
        </div>
      ))}
    </div>
  );
}

export function Progress({ value, max, tone }: { value: number; max: number; tone?: 'success' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={`progress ${tone ?? ''}`} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  return (
    <div className="pager">
      <span>{from}–{Math.min(page * pageSize, total)} of {total}</span>
      <span className="spacer" />
      <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span>Page {page} of {pages}</span>
      <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  );
}

/** A control that is visibly disabled with the reason available on hover and to screen readers. */
export function Blocked({ reason, children }: { reason: string; children: ReactNode }) {
  return (
    <span title={reason} aria-label={reason} style={{ display: 'inline-flex' }}>
      {children}
    </span>
  );
}
