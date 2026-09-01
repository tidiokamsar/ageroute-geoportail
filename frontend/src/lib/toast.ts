// Petit store de notifications "toast" maison (pas de dependance externe) : un store
// module-level + useSyncExternalStore cote composant. Donne un retour visuel sur chaque
// action (enregistrement, suppression, erreur) la ou l'app etait jusqu'ici silencieuse.
export type ToastType = "success" | "error" | "info";
export interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function emit() {
  listeners.forEach((l) => l());
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function push(type: ToastType, message: string) {
  const id = nextId++;
  toasts = [...toasts, { id, type, message }];
  emit();
  setTimeout(() => dismissToast(id), type === "error" ? 6000 : 3500);
}

export const toast = {
  success: (m: string) => push("success", m),
  error: (m: string) => push("error", m),
  info: (m: string) => push("info", m),
};

export function subscribeToasts(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getToasts() {
  return toasts;
}
