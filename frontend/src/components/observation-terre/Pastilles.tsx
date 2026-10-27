import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, CircleHelp, Clock, KeyRound, Radio, XCircle } from "lucide-react";
import type { NiveauPriorite } from "../../lib/teledetectionApi";
import {
  couleurPriorite, couleurStatut, infoEtatSource, libellePriorite, libelleStatut, type CoupleCouleur,
} from "../../lib/teledetectionAffichage";

/**
 * Pastilles de priorite, de statut et d'etat de source.
 * Les couples de couleurs viennent de `teledetectionAffichage` (mesures au contraste dans son test) ;
 * chaque pastille porte un LIBELLE et un pictogramme : la couleur ne dit jamais seule.
 */

function Pastille({ couple, children, className = "" }: { couple: CoupleCouleur; children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${className}`}
      style={{ backgroundColor: couple.fond, color: couple.texte }}
    >
      {children}
    </span>
  );
}

export function PastillePriorite({ niveau }: { niveau: NiveauPriorite | null | undefined }) {
  const court = niveau === "HAUTE" ? "Haute" : niveau === "MOYENNE" ? "Moyenne" : niveau === "FAIBLE" ? "Faible" : "Non déterminée";
  return (
    <Pastille couple={couleurPriorite(niveau)}>
      {niveau === "HAUTE" && <AlertTriangle aria-hidden="true" className="h-3 w-3" />}
      <span aria-hidden="true">{court}</span>
      <span className="sr-only">{libellePriorite(niveau)}</span>
    </Pastille>
  );
}

export function PastilleStatut({ statut }: { statut: string }) {
  const Icone = statut === "CONFIRMEE" ? CheckCircle2 : statut === "INFIRMEE" ? XCircle : statut === "EN_ATTENTE" ? Clock : statut === "NON_CONCLUANTE" ? CircleHelp : CircleDashed;
  return (
    <Pastille couple={couleurStatut(statut)}>
      <Icone aria-hidden="true" className="h-3 w-3" />
      {libelleStatut(statut)}
    </Pastille>
  );
}

export function PastilleEtatSource({ etat }: { etat: string }) {
  const info = infoEtatSource(etat);
  const Icone = info.active ? Radio : etat === "EN_ERREUR" ? XCircle : etat === "EN_ATTENTE_CONFIGURATION" ? KeyRound : info.connu ? CircleDashed : CircleHelp;
  return (
    <Pastille couple={info.couleur}>
      <Icone aria-hidden="true" className="h-3 w-3" />
      {info.libelle}
    </Pastille>
  );
}
