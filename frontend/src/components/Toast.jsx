/**
 * Toast notification system — stacked, auto-dismissing notifications.
 *
 * Usage:
 *   const toast = useToast();
 *   toast.success('Saved.');
 *   toast.error('Something broke.');
 *   toast.info('FYI…');
 *   toast.warn('Heads up.');
 *
 * Wrap the app with <ToastProvider> at the root.
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';

const ToastContext = createContext(null);

let nextId = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (variant, message, opts = {}) => {
      const id = nextId++;
      const ttl = opts.duration ?? (variant === 'error' ? 7000 : 4500);
      setToasts((prev) => [...prev, { id, variant, message, title: opts.title }]);
      if (ttl > 0) {
        setTimeout(() => dismiss(id), ttl);
      }
      return id;
    },
    [dismiss]
  );

  const value = {
    success: (msg, opts) => push('success', msg, opts),
    error:   (msg, opts) => push('error', msg, opts),
    info:    (msg, opts) => push('info', msg, opts),
    warn:    (msg, opts) => push('warn', msg, opts),
    dismiss,
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="bb-toast-stack" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const VARIANT_ICON = {
  success: CheckCircle2,
  error:   AlertCircle,
  info:    Info,
  warn:    AlertTriangle,
};

function ToastCard({ toast, onDismiss }) {
  const Icon = VARIANT_ICON[toast.variant] || Info;
  const [leaving, setLeaving] = useState(false);

  // animate out before unmount
  const handleDismiss = () => {
    setLeaving(true);
    setTimeout(onDismiss, 180);
  };

  // mount animation
  useEffect(() => {
    // no-op; mount handled via CSS keyframe
  }, []);

  return (
    <div
      className={`bb-toast bb-toast-${toast.variant} ${leaving ? 'is-leaving' : ''}`}
      role={toast.variant === 'error' ? 'alert' : 'status'}
    >
      <Icon size={18} className="bb-toast-icon" aria-hidden="true" />
      <div className="bb-toast-body">
        {toast.title && <div className="bb-toast-title">{toast.title}</div>}
        <div className="bb-toast-msg">{toast.message}</div>
      </div>
      <button
        className="bb-toast-close"
        onClick={handleDismiss}
        aria-label="Dismiss notification"
        type="button"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Soft fallback so a misconfigured tree doesn't crash — log instead of throwing.
    return {
      success: (m) => console.warn('[toast outside provider]', m),
      error:   (m) => console.warn('[toast outside provider]', m),
      info:    (m) => console.warn('[toast outside provider]', m),
      warn:    (m) => console.warn('[toast outside provider]', m),
      dismiss: () => {},
    };
  }
  return ctx;
}
