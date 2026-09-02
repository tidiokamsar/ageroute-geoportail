import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

/**
 * `sale()` est fourni par l'appelant quand la modale porte un formulaire :
 * il retourne true tant qu'il existe des modifications non enregistrées.
 * Fermer (Esc, clic hors zone, bouton) déclenche alors une confirmation au
 * lieu de perdre la saisie en silence (P3-B, garde anti-perte).
 */
export function Modal({
  open, onClose, title, children, sale,
}: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; sale?: () => boolean;
}) {
  function demanderFermeture() {
    if (sale?.()) {
      const perdre = window.confirm("Des modifications n'ont pas été enregistrées. Fermer quand même ?");
      if (!perdre) return;
    }
    onClose();
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !next && demanderFermeture()}>
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
