import { Ban, CircleCheck, CircleX, Circle, FlaskConical, Hourglass, Inbox, Loader, Lock, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { descripteurStatut, TONS, type NomIcone, type NomTon } from "./imports.noyau";

/**
 * Statut d'un lot : icone ET texte ET couleur. La couleur ne porte jamais le sens seule (daltonisme, impression
 * en noir et blanc, lecteur d'ecran). Les libelles, tons et icones sont decides par `imports.noyau.ts`.
 *
 * Un statut en attente ou non applique (« Schéma validé : non appliqué ») est ambre, jamais vert : seul `IMPORTE`
 * est vert, et le serveur ne l'attribue pas encore.
 */

const ICONES: Record<NomIcone, LucideIcon> = {
  boite: Inbox,
  sablier: Hourglass,
  fiole: FlaskConical,
  coche: CircleCheck,
  croix: CircleX,
  alerte: TriangleAlert,
  chargement: Loader,
  cadenas: Lock,
  cercle: Circle,
};

/** Icone du noyau rendue en lucide, toujours decorative (`aria-hidden`) : le texte voisin dit la meme chose. */
export function IconeLot({ nom, className }: { nom: NomIcone; className?: string }) {
  const Icone = ICONES[nom] ?? Ban;
  return <Icone aria-hidden="true" focusable="false" className={cn("size-4 shrink-0", className)} />;
}

export function classesPuce(ton: NomTon): string {
  return TONS[ton].classes.puce;
}

export interface BadgeStatutLotProps {
  /** Valeur du serveur. Une valeur inconnue est affichee en neutre, « Statut inconnu : X ». */
  statut: string;
  className?: string;
}

export function BadgeStatutLot({ statut, className }: BadgeStatutLotProps) {
  const d = descripteurStatut(statut);
  return (
    <span
      data-statut={d.code}
      data-ton={d.ton}
      className={cn(
        "inline-flex max-w-full items-center gap-j1 rounded-jeton-sm border px-j2 py-j1 text-legende font-medium",
        classesPuce(d.ton),
        className,
      )}
    >
      <IconeLot nom={d.icone} />
      <span className="min-w-0 [overflow-wrap:anywhere]">{d.libelle}</span>
    </span>
  );
}
