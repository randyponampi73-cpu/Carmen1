import { AlertCircle, CheckCircle2, Download, X } from 'lucide-react';
import type { ToastNotification } from '../types';

interface ToastContainerProps {
  toasts: ToastNotification[];
  closeLabel: string;
  onDismiss: (id: string) => void;
  onOpenProject?: (projectId: string) => void;
}

export function ToastContainer({ toasts, closeLabel, onDismiss, onOpenProject }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-[68px] sm:bottom-4 right-3 sm:right-4 z-50 flex flex-col gap-2 w-[min(380px,calc(100vw-24px))] pointer-events-none"
    >
      {toasts.map((toast) => {
        const isSuccess = toast.type === 'success';
        const hasDownload = Boolean(toast.downloadUrl && toast.actionLabel);
        return (
          <div
            key={toast.id}
            role="status"
            className="pointer-events-auto rounded-[8px] border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-3 flex items-start gap-2.5 text-[13px]"
            style={{ boxShadow: 'var(--shadow-float)' }}
          >
            {isSuccess ? (
              <CheckCircle2 className="w-4 h-4 text-[var(--success-text)] shrink-0 mt-0.5" strokeWidth={1.75} />
            ) : (
              <AlertCircle className="w-4 h-4 text-[var(--error-text)] shrink-0 mt-0.5" strokeWidth={1.75} />
            )}

            <div className="min-w-0 flex-1 space-y-1">
              <div className="font-semibold text-[var(--text)] leading-snug">{toast.title}</div>
              <div className="text-[12px] text-[var(--text-muted)] leading-snug">{toast.message}</div>
              {(hasDownload || (toast.projectId && onOpenProject)) && (
                <div className="pt-1 flex flex-wrap items-center gap-3">
                  {hasDownload && (
                    <a
                      href={toast.downloadUrl}
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent-text)] hover:underline"
                    >
                      <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
                      <span>{toast.actionLabel}</span>
                    </a>
                  )}
                  {toast.projectId && onOpenProject && toast.openProjectLabel && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenProject(toast.projectId!);
                        onDismiss(toast.id);
                      }}
                      className="text-[12px] font-medium text-[var(--text)] hover:text-[var(--accent-text)] underline cursor-pointer"
                    >
                      {toast.openProjectLabel}
                    </button>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label={closeLabel}
              className="h-6 w-6 rounded-[6px] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] flex items-center justify-center shrink-0 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.5} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
