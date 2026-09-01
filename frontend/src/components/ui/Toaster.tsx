import { useSyncExternalStore } from "react";
import { subscribeToasts, getToasts, dismissToast, type ToastType } from "../../lib/toast";

const STYLES: Record<ToastType, { bg: string; icon: string }> = {
  success: { bg: "bg-green-600", icon: "✓" },
  error: { bg: "bg-red-600", icon: "✕" },
  info: { bg: "bg-navy", icon: "ℹ" },
};

export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 no-print pointer-events-none">
      {toasts.map((t) => {
        const s = STYLES[t.type];
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-2.5 rounded-lg ${s.bg} text-white px-4 py-2.5 shadow-lg text-sm max-w-sm animate-in slide-in-from-right-4 fade-in duration-200`}
            role="status"
          >
            <span className="font-bold shrink-0">{s.icon}</span>
            <span className="flex-1">{t.message}</span>
            <button onClick={() => dismissToast(t.id)} className="shrink-0 opacity-70 hover:opacity-100">
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
