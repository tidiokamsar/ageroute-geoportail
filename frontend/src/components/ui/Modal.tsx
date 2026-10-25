import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./dialog";
import { Button } from "./Button";

/**
 * `sale()` est fourni par l'appelant quand la modale porte un formulaire :
 * il retourne true tant qu'il existe des modifications non enregistrées.
 * Fermer (Esc, clic hors zone, bouton) déclenche alors une confirmation au
 * lieu de perdre la saisie en silence (P3-B, garde anti-perte).
 *
 * POURQUOI LA CONFIRMATION EST INTERNE ET N'UTILISE PAS `useConfirm`
 *
 * `useConfirm` rend lui-même un `Modal` : l'appeler ici ferait un import circulaire
 * (Modal -> useConfirm -> Modal). La confirmation est donc un second dialogue Radix imbriqué
 * dans celui-ci, au même rendu que `useConfirm` (« Annuler » / « Confirmer »), à la place de
 * la boîte native `window.confirm` qui sortait de la charte, n'était pas stylable et ne se
 * testait pas.
 */
export function Modal({
  open, onClose, title, children, sale,
}: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; sale?: () => boolean;
}) {
  const [confirmationOuverte, setConfirmationOuverte] = useState(false);

  function demanderFermeture() {
    if (sale?.()) {
      setConfirmationOuverte(true);
      return;
    }
    onClose();
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !next && demanderFermeture()}>
      <DialogContent masquerCroix className="max-w-[480px] max-h-[85vh] overflow-y-auto">
        {/* En-tete STICKY avec fermeture explicite. Bug du 23/10 : la croix du Dialog
            (absolute top-4 right-4) vit dans le conteneur DEFILABLE — sur une fiche
            longue elle defile hors de vue, et l'utilisateur n'a plus aucun moyen visible
            de fermer. L'en-tete colle reste en place pendant tout le defilement ;
            Esc et le clic hors zone continuent de fonctionner (Radix). La croix standard
            du Dialog est masquee ici (`masquerCroix`) : elle doublait ce bouton. */}
        <div className="sticky top-0 z-10 -m-6 mb-4 flex items-start justify-between gap-3 border-b border-gray-100 bg-white px-6 py-4">
          <DialogTitle className="text-base font-semibold text-primary">{title}</DialogTitle>
          <button
            type="button"
            onClick={demanderFermeture}
            aria-label="Fermer"
            className="shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-navy focus:outline-none focus:ring-2 focus:ring-navy/30"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {/* Visible uniquement a l'impression (cf. printFiche/.printing-fiche) : en-tete
            institutionnel pour les fiches exportees en PDF. */}
        <img src="/ageroute-logo.svg" alt="AGEROUTE" className="hidden print:block h-10 w-auto mb-2" />
        {children}

        <Dialog open={confirmationOuverte} onOpenChange={setConfirmationOuverte}>
          <DialogContent masquerCroix className="max-w-[420px]">
            <DialogTitle className="text-base font-semibold text-primary">Modifications non enregistrées</DialogTitle>
            <DialogDescription className="text-sm text-gray-600">
              Des modifications n'ont pas été enregistrées. Fermer quand même ?
            </DialogDescription>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setConfirmationOuverte(false)}>
                Continuer la saisie
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => { setConfirmationOuverte(false); onClose(); }}
              >
                Fermer sans enregistrer
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
