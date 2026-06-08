import React, { useEffect, useState, useCallback, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';

// Promise-based confirmation dialog mounted once (like ToastContainer). Replaces
// blocking native confirm() with a styled, accessible modal.
//   if (await showConfirm({ title: 'Delete?', tone: 'danger' })) { ... }

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: 'danger' | 'default';
}

let requestConfirmFn: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;

export function showConfirm(opts: ConfirmOptions): Promise<boolean> {
  if (!requestConfirmFn) {
    // Host not mounted (shouldn't happen) — degrade to native confirm.
    return Promise.resolve(window.confirm(opts.message || opts.title));
  }
  return requestConfirmFn(opts);
}

export default function ConfirmHost() {
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const request = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => setState({ opts, resolve }));
  }, []);

  useEffect(() => {
    requestConfirmFn = request;
    return () => { requestConfirmFn = null; };
  }, [request]);

  const close = useCallback((result: boolean) => {
    setState((cur) => { cur?.resolve(result); return null; });
  }, []);

  useEffect(() => {
    if (!state) return;
    confirmBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, close]);

  if (!state) return null;
  const { opts } = state;
  const danger = opts.tone !== 'default';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={opts.title}
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
      onClick={() => close(false)}
    >
      <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 p-5">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${danger ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-slate-900">{opts.title}</h2>
            {opts.message && <p className="text-sm text-slate-600 mt-1 whitespace-pre-line">{opts.message}</p>}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-slate-100 bg-slate-50/50 rounded-b-xl">
          <button
            onClick={() => close(false)}
            className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 rounded-md transition-colors"
          >
            {opts.cancelText || 'Cancel'}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={() => close(true)}
            className={`px-4 py-1.5 text-sm text-white rounded-md font-medium transition-colors ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            {opts.confirmText || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
