import {
  Ban, Check, CircleDot, ClipboardCheck, Circle, Diamond, Hexagon, Hourglass, Lock, Octagon, Pencil, Pentagon, RotateCcw, Search, ShieldAlert, Square, Triangle, TriangleAlert, X,
  type LucideIcon,
} from "lucide-react";
import {
  CLASSES_STATUT_DECISION, CLASSES_STATUT_REGLE, FORME_STATUT_DECISION, FORME_STATUT_REGLE, FORME_TYPE_CONFLIT, LIBELLE_MOTIF_REEXAMEN, LIBELLE_RISQUE, LIBELLE_STATUT_DECISION,
  LIBELLE_STATUT_REGLE, LIBELLE_TYPE_CONFLIT, STYLE_STATUT_CONFLIT,
  type FormeBadge, type MotifReexamen, type RisqueConflit, type StatutConflit, type StatutDecision, type StatutRegle, type TypeConflit,
} from "../../lib/projetsVoirieConflits";

/**
 * Badges des dossiers de conflit. Chaque badge porte le MOT et une FORME (icone) propre : la couleur ne porte jamais l'information seule
 * (WCAG 1.4.1). Les couleurs de texte respectent docs/accessibilite/CONTRASTE.md (900 sur 50 ou 100).
 */

const ICONES: Record<FormeBadge, LucideIcon> = {
  loupe: Search, triangle: TriangleAlert, bouclier: ShieldAlert, barre: Ban, "presse-papiers": ClipboardCheck, cadenas: Lock,
  carre: Square, losange: Diamond, cercle: Circle, hexagone: Hexagon, pentagone: Pentagon, octogone: Octagon,
  plume: Pencil, croix: X, coche: Check, fleche: Triangle, sablier: Hourglass, point: CircleDot,
};

const BASE = "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold leading-tight";

export function BadgeStatutConflit({ statut }: { statut: StatutConflit }) {
  const s = STYLE_STATUT_CONFLIT[statut];
  const Icone = ICONES[s.forme];
  return (
    <span data-statut-conflit={statut} data-forme={s.forme} className={`${BASE} ${s.classes}`}>
      <Icone aria-hidden="true" className="h-3 w-3 shrink-0" />{s.libelle}
    </span>
  );
}

export function BadgeTypeConflit({ type }: { type: TypeConflit }) {
  const forme = FORME_TYPE_CONFLIT[type];
  const Icone = ICONES[forme];
  return (
    <span data-type-conflit={type} data-forme={forme} className={`${BASE} border-gray-400 bg-white text-gray-900`}>
      <Icone aria-hidden="true" className="h-3 w-3 shrink-0" />{LIBELLE_TYPE_CONFLIT[type]}
    </span>
  );
}

/** Risque : le mot dit le niveau ; « inconnu » est un niveau a part, jamais assimile a « faible » (bordure en tirets). */
export function BadgeRisque({ risque }: { risque: RisqueConflit | null }) {
  if (!risque) return <span className={`${BASE} border-dashed border-gray-400 bg-white text-gray-700`}>Risque non renseigné</span>;
  const classes: Record<RisqueConflit, string> = {
    FAIBLE: "border-gray-400 bg-white text-gray-900",
    MOYEN: "border-amber-400 bg-amber-50 text-amber-900",
    ELEVE: "border-red-400 bg-red-50 text-red-900 border-2",
    INCONNU: "border-dashed border-gray-500 bg-white text-gray-800",
  };
  return <span data-risque={risque} className={`${BASE} ${classes[risque]}`}>{LIBELLE_RISQUE[risque]}</span>;
}

export function BadgeReexamen({ motif }: { motif: MotifReexamen | null }) {
  return (
    <span data-reexamen={motif ?? "oui"} className={`${BASE} border-2 border-purple-400 bg-purple-50 text-purple-900`}>
      <RotateCcw aria-hidden="true" className="h-3 w-3 shrink-0" />À réexaminer{motif ? ` : ${LIBELLE_MOTIF_REEXAMEN[motif].toLowerCase()}` : ""}
    </span>
  );
}

export function BadgeEcheanceDepassee() {
  return <span data-echeance-depassee="oui" className={`${BASE} border-2 border-red-400 bg-red-50 text-red-900`}>Échéance dépassée</span>;
}

export function BadgeStatutDecision({ statut }: { statut: StatutDecision }) {
  const Icone = ICONES[FORME_STATUT_DECISION[statut]];
  return (
    <span data-statut-decision={statut} className={`${BASE} ${CLASSES_STATUT_DECISION[statut]}`}>
      <Icone aria-hidden="true" className="h-3 w-3 shrink-0" />{LIBELLE_STATUT_DECISION[statut]}
    </span>
  );
}

export function BadgeStatutRegle({ statut }: { statut: StatutRegle }) {
  const Icone = ICONES[FORME_STATUT_REGLE[statut]];
  return (
    <span data-statut-regle={statut} className={`${BASE} ${CLASSES_STATUT_REGLE[statut]}`}>
      <Icone aria-hidden="true" className="h-3 w-3 shrink-0" />{LIBELLE_STATUT_REGLE[statut]}
    </span>
  );
}
