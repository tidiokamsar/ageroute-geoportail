import { Ban, Check, CheckCheck, CircleSlash, FileQuestion, Hourglass, Inbox, Search, TriangleAlert, Wrench, X, type LucideIcon } from "lucide-react";
import { AIDE_STATUT_DOCUMENT, LIBELLE_STATUT_DOCUMENT, type EtatFonction, type StatutDocument } from "../../../lib/projetsVoirieDocuments";

/**
 * Badges des documents et des fonctions : chaque badge porte le MOT et une FORME (icone) propre, la couleur ne porte jamais l'information seule
 * (WCAG 1.4.1). Couleurs de texte 900 sur fond 50 ou 100 (docs/accessibilite/CONTRASTE.md).
 */

const BASE = "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold leading-tight";

const STYLE_STATUT: Record<StatutDocument, { icone: LucideIcon; classes: string }> = {
  ATTENDU: { icone: Hourglass, classes: "border-dashed border-gray-400 bg-white text-gray-900" },
  RECU: { icone: Inbox, classes: "border-sky-300 bg-sky-50 text-sky-900" },
  EN_ANALYSE: { icone: Search, classes: "border-indigo-300 bg-indigo-50 text-indigo-900" },
  EXPLOITABLE: { icone: Check, classes: "border-green-300 bg-green-50 text-green-900" },
  INCOMPLET: { icone: FileQuestion, classes: "border-amber-400 bg-amber-50 text-amber-900" },
  A_CORRIGER: { icone: Wrench, classes: "border-amber-400 bg-amber-100 text-amber-900" },
  VALIDE: { icone: CheckCheck, classes: "border-green-500 bg-green-100 text-green-900" },
  REJETE: { icone: X, classes: "border-red-300 bg-red-50 text-red-900" },
  REMPLACE: { icone: Ban, classes: "border-gray-300 bg-gray-100 text-gray-800" },
};

export function BadgeStatutDocument({ statut }: { statut: StatutDocument }) {
  const s = STYLE_STATUT[statut];
  const Icone = s.icone;
  return (
    <span data-statut-document={statut} title={AIDE_STATUT_DOCUMENT[statut]} className={`${BASE} ${s.classes}`}>
      <Icone aria-hidden="true" className="h-3 w-3 shrink-0" />{LIBELLE_STATUT_DOCUMENT[statut]}
    </span>
  );
}

const STYLE_FONCTION: Record<EtatFonction, { icone: LucideIcon; libelle: string; classes: string }> = {
  DISPONIBLE: { icone: Check, libelle: "Disponible", classes: "border-green-400 bg-green-50 text-green-900" },
  INDISPONIBLE: { icone: TriangleAlert, libelle: "Indisponible", classes: "border-amber-400 bg-amber-50 text-amber-900" },
  NON_LIVREE: { icone: CircleSlash, libelle: "Non livrée", classes: "border-dashed border-gray-400 bg-white text-gray-800" },
};

export function BadgeEtatFonction({ etat }: { etat: EtatFonction }) {
  const s = STYLE_FONCTION[etat];
  const Icone = s.icone;
  return <span data-etat-fonction={etat} className={`${BASE} ${s.classes}`}><Icone aria-hidden="true" className="h-3 w-3 shrink-0" />{s.libelle}</span>;
}
