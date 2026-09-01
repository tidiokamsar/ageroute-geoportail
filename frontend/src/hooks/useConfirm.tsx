import { useState, useCallback } from "react";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";

interface ConfirmState {
  message: string;
  title: string;
  danger: boolean;
  resolve: (v: boolean) => void;
}

// Remplace window.confirm() par une vraie modale stylee, coherente avec le reste de
// l'app (toutes les autres confirmations passaient par la boite native du navigateur,
// visuellement disjointe de la charte AGEROUTE). Usage : const { confirm, dialog } =
// useConfirm(); ... if (await confirm("Supprimer ?")) { ... } ; rendre {dialog} une fois
// dans le JSX du composant.
export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);

  const confirm = useCallback((message: string, opts?: { title?: string; danger?: boolean }) => {
    return new Promise<boolean>((resolve) => {
      setState({ message, title: opts?.title ?? "Confirmation", danger: opts?.danger ?? false, resolve });
    });
  }, []);

  function handle(result: boolean) {
    state?.resolve(result);
    setState(null);
  }

  const dialog = state ? (
    <Modal open onClose={() => handle(false)} title={state.title}>
      <p className="text-sm text-gray-600">{state.message}</p>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={() => handle(false)}>
          Annuler
        </Button>
        <Button variant={state.danger ? "danger" : "primary"} onClick={() => handle(true)}>
          Confirmer
        </Button>
      </div>
    </Modal>
  ) : null;

  return { confirm, dialog };
}
