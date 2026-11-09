import { CheckCircle2, Info } from "lucide-react";
import { STYLE_RESEAU, type TypeReseau } from "../../../lib/projetsVoirie";
import {
  AIDE_SOURCE_UNIQUE, CLASSES_STATUT_RESULTAT, FORME_STATUT_RESULTAT, LIBELLE_STATUT_RESEAU, LIBELLE_STATUT_RESULTAT,
  type StatutReseauSources, type StatutResultat,
} from "../../../lib/projetsVoirieSources";
import { libelleDeCode, type ValeurReferentiel } from "../../../lib/projetsVoirieTerritoires";

/** Badge d'un statut de resultat : forme repetee + texte + couleur (l'information ne passe jamais par la couleur seule). */
export function BadgeResultat({ statut }: { statut: StatutResultat }) {
  return (
    <span data-statut={statut} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-semibold ${CLASSES_STATUT_RESULTAT[statut]}`}>
      <span aria-hidden="true" className="font-mono">{FORME_STATUT_RESULTAT[statut]}</span>{LIBELLE_STATUT_RESULTAT[statut]}
    </span>
  );
}

/**
 * Statut d'un reseau. Une SOURCE UNIQUE est l'etat normal : ton neutre (information), jamais une alerte ni une erreur.
 */
export function StatutReseau({ statut }: { statut: StatutReseauSources }) {
  if (statut === "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE") {
    return (
      <div data-testid="source-unique" className="flex items-start gap-1.5 rounded border border-gray-300 bg-gray-50 p-2 text-xs text-gray-800">
        <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-navy" />
        <p><strong>{LIBELLE_STATUT_RESEAU[statut]}.</strong> {AIDE_SOURCE_UNIQUE}</p>
      </div>
    );
  }
  return (
    <p className="flex items-center gap-1.5 text-xs font-semibold text-green-900">
      <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />{LIBELLE_STATUT_RESEAU[statut]}
    </p>
  );
}

/** Libelle d'un type de reseau : le type CONFIGURABLE (referentiel, meme desactive) s'il est connu, sinon la famille technique du contrat. */
export function libelleTypeReseau(code: string | null, famille: string | null, types: readonly ValeurReferentiel[] | undefined): string {
  if (code) return libelleDeCode(code, types);
  if (famille && famille in STYLE_RESEAU) return STYLE_RESEAU[famille as TypeReseau].libelle;
  return famille ?? "Type non renseigné";
}
