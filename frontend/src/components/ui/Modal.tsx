import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[480px] max-h-[85vh] overflow-y-auto">
        {/* Visible uniquement a l'impression (cf. printFiche/.printing-fiche) : en-tete
            institutionnel pour les fiches exportees en PDF. */}
        <img src="/ageroute-logo.svg" alt="AGEROUTE" className="hidden print:block h-10 w-auto mb-2" />
        <DialogTitle className="text-base font-semibold text-primary">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
