import { Ban, Box, Cable, Check, CircleHelp, Hourglass, Network, Route, X, type LucideIcon } from "lucide-react";
import type { ClassePrecision, NatureObjet } from "../../../lib/projetsVoirie";
import {
  CLASSES_NATURE, FORME_NATURE, LIBELLE_NATURE_COURT, LIBELLE_ORIGINE_RELATION, STYLE_STATUT_RELATION, libelleClasse,
  type OrigineRelation, type StatutRelation,
} from "../../../lib/projetsVoirieReseaux";

/**
 * Badges des reseaux. Chaque badge porte le MOT et une FORME (icone) propre : la couleur ne porte jamais l'information seule (WCAG 1.4.1).
 * Les couleurs de texte respectent docs/accessibilite/CONTRASTE.md (900 sur 50 ou 100).
 */

const BASE = "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold leading-tight";
const ICONES: Record<string, LucideIcon> = { cable: Cable, reseau: Network, boite: Box, route: Route, inconnue: CircleHelp, sablier: Hourglass, coche: Check, croix: X, barre: Ban };

export function BadgeNature({ nature, origine }: { nature: NatureObjet; origine?: string }) {
  const Icone = ICONES[FORME_NATURE[nature]];
  return (
    <span data-nature={nature} data-forme={FORME_NATURE[nature]} className={`${BASE} ${CLASSES_NATURE[nature]}`}>
      <Icone aria-hidden="true" className="h-3 w-3 shrink-0" />{LIBELLE_NATURE_COURT[nature]}{origine === "JEU" ? " (héritée du jeu)" : ""}
    </span>
  );
}

/** La classe est une lettre DECLAREE ; absente, le badge dit « Classe non renseignée » (bordure en tirets) : jamais une classe par defaut. */
export function BadgeClasse({ classe }: { classe: ClassePrecision | null }) {
  const connue = !!classe && classe !== "INCONNUE";
  return (
    <span data-classe={connue ? classe : "non-renseignee"} className={`${BASE} ${connue ? "border-gray-400 bg-white text-gray-900" : "border-dashed border-gray-500 bg-white text-gray-800"}`}>
      {libelleClasse(classe)}
    </span>
  );
}

export function BadgeStatutRelation({ statut }: { statut: StatutRelation }) {
  const s = STYLE_STATUT_RELATION[statut];
  const Icone = ICONES[s.forme];
  return (
    <span data-statut-relation={statut} data-forme={s.forme} className={`${BASE} ${s.classes}`}>
      <Icone aria-hidden="true" className="h-3 w-3 shrink-0" />{s.libelle}
    </span>
  );
}

export function BadgeOrigineRelation({ origine }: { origine: OrigineRelation | null }) {
  if (!origine) return null;
  return <span data-origine={origine} className={`${BASE} ${origine === "AUTOMATIQUE" ? "border-2 border-amber-400 bg-amber-50 text-amber-900" : "border-gray-400 bg-white text-gray-900"}`}>{LIBELLE_ORIGINE_RELATION[origine]}</span>;
}
