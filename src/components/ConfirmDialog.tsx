import { AlertCircle, Loader2 } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { COPY } from '../i18n';
import type { Locale } from '../types';

let openModalScrollLockCount = 0;
let previousBodyOverflow = '';

interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  busy?: boolean;
  ariaLabelledBy?: string;
  ariaLabel?: string;
  maxWidthClass?: string;
  className?: string;
  children: React.ReactNode;
}

const FOCUSABLE_SELECTOR =
  'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"]):not([disabled])';

export function ModalShell({
  open,
  onClose,
  busy = false,
  ariaLabelledBy,
  ariaLabel,
  maxWidthClass = 'max-w-[440px]',
  className = '',
  children,
}: ModalShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    busyRef.current = busy;
    onCloseRef.current = onClose;
  }, [busy, onClose]);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;

    if (openModalScrollLockCount === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    openModalScrollLockCount += 1;

    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        panel.focus();
      }
    });

    function onKeyDown(e: KeyboardEvent) {
      const panel = panelRef.current;
      if (!panel) return;
      if (e.key === 'Escape') {
        if (!busyRef.current) {
          e.preventDefault();
          e.stopPropagation();
          onCloseRef.current();
        }
        return;
      }
      if (e.key === 'Tab') {
        const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
          (el) => el.offsetParent !== null || el === document.activeElement
        );
        if (focusables.length === 0) {
          e.preventDefault();
          panel.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (!active || active === first || !panel.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (!active || active === last || !panel.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      openModalScrollLockCount = Math.max(0, openModalScrollLockCount - 1);
      if (openModalScrollLockCount === 0) {
        document.body.style.overflow = previousBodyOverflow;
      }
      const prev = previousFocusRef.current;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`w-full ${maxWidthClass} rounded-[8px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] my-auto outline-none ${className}`}
        style={{ boxShadow: 'var(--shadow-float)' }}
      >
        {children}
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  locale: Locale;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  locale,
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const t = COPY[locale];
  const titleId = useId();

  return (
    <ModalShell open={open} onClose={onClose} busy={busy} ariaLabelledBy={titleId} maxWidthClass="max-w-[420px]" className="p-5 space-y-4">
      <div className="space-y-1.5">
        <h2 id={titleId} className="text-[16px] font-semibold text-[var(--text)]">
          {title}
        </h2>
        <p className="text-[13px] text-[var(--text-muted)] leading-relaxed">{description}</p>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[6px] border border-[var(--error)] bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--error-text)]"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="h-8 px-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--text-muted)] text-[13px] text-[var(--text)] disabled:opacity-50 cursor-pointer"
        >
          {cancelLabel || t.cancel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onConfirm()}
          className={`h-8 px-4 rounded-[6px] text-white text-[13px] font-medium flex items-center gap-1.5 disabled:opacity-50 cursor-pointer ${
            danger ? 'bg-[var(--error-fill)] hover:opacity-90' : 'bg-[var(--accent)] hover:bg-[var(--accent-hover)]'
          }`}
        >
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />}
          <span>{confirmLabel}</span>
        </button>
      </div>
    </ModalShell>
  );
}
