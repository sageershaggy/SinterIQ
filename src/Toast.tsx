import React, { useEffect, useState, useCallback } from 'react';
import { CheckCircle2, AlertCircle, X, Info } from 'lucide-react';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  message?: string;
}

let addToastFn: ((toast: Omit<ToastMessage, 'id'>) => void) | null = null;

export function showToast(type: ToastMessage['type'], title: string, message?: string) {
  addToastFn?.({ type, title, message });
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { ...toast, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  useEffect(() => {
    addToastFn = addToast;
    return () => { addToastFn = null; };
  }, [addToast]);

  const dismiss = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] space-y-2 max-w-sm">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-start gap-3 p-4 rounded-xl shadow-lg border backdrop-blur-sm animate-[slideIn_0.3s_ease-out] ${
            toast.type === 'success' ? 'bg-green-50 border-green-200' :
            toast.type === 'error' ? 'bg-red-50 border-red-200' :
            'bg-blue-50 border-blue-200'
          }`}
        >
          {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />}
          {toast.type === 'error' && <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />}
          {toast.type === 'info' && <Info className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />}
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-semibold ${
              toast.type === 'success' ? 'text-green-800' :
              toast.type === 'error' ? 'text-red-800' :
              'text-blue-800'
            }`}>{toast.title}</div>
            {toast.message && (
              <div className={`text-xs mt-0.5 ${
                toast.type === 'success' ? 'text-green-600' :
                toast.type === 'error' ? 'text-red-600' :
                'text-blue-600'
              }`}>{toast.message}</div>
            )}
          </div>
          <button onClick={() => dismiss(toast.id)} className="text-slate-400 hover:text-slate-600 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
