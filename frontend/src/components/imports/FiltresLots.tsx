import { useId, useRef } from "react";
import { Button } from "../ui/Button";
import { Input, Select } from "../ui/Input";
import { libelleStatut, STATUTS_LOT } from "./imports.noyau";
import type { FiltresLots as ValeursFiltres, SourceConnue, StatutLot } from "./types";

/**
 * Filtres de la liste des lots : statut, source, recherche texte.
 *
 * Le composant est CONTRÔLÉ et ne touche ni à l'URL ni au réseau : l'intégrateur porte `filtres` dans
 * `searchParams` (la sélection d'un lot ne doit pas effacer le filtre en cours, cahier 6.2) et décide
 * d'un éventuel délai de frappe avant d'interroger le serveur. Le nombre de résultats est annoncé en
 * `aria-live` : sans lui, un lecteur d'écran ne saurait pas que la liste a changé.
 */

/**
 * Libellés des statuts pour la liste déroulante : ceux du noyau (`imports.noyau.ts`), source unique. Le badge, la
 * liste et ce filtre disent donc la même chose (« Schéma validé : non appliqué », jamais un mot de réussite) ;
 * un libellé recopié ici finirait par diverger de celui du badge.
 */
export const LIBELLE_STATUT_FILTRE: Record<StatutLot, string> = Object.fromEntries(
  STATUTS_LOT.map((s) => [s, libelleStatut(s)]),
) as Record<StatutLot, string>;

const ORDRE_STATUTS: StatutLot[] = ["RECU", "VALIDE_SCHEMA", "REJETE", "IMPORTE_TEST", "IMPORTE"];

export const FILTRES_LOTS_VIDES: ValeursFiltres = { statut: "", source: "", q: "" };

export function filtresActifs(f: ValeursFiltres): boolean {
  return f.statut !== "" || f.source !== "" || f.q.trim() !== "";
}

export interface FiltresLotsProps {
  filtres: ValeursFiltres;
  /** Sources déjà reçues (`GET /v2/imports/sources`). La source reste un texte libre : jamais un référentiel. */
  sources: SourceConnue[];
  onChange: (suivants: ValeursFiltres) => void;
  /** Nombre de lots correspondant aux filtres (sans la pagination). `undefined` tant qu'il n'est pas connu. */
  total?: number;
}

const CIBLE = "min-h-[44px]";

function phraseTotal(total: number | undefined, actifs: boolean): string {
  if (total === undefined) return "";
  if (total === 0) return actifs ? "Aucun lot ne correspond aux filtres." : "Aucun lot reçu.";
  const lots = `${total.toLocaleString("fr-FR")} ${total > 1 ? "lots" : "lot"}`;
  return actifs ? `${lots} correspondant aux filtres.` : `${lots} reçus.`;
}

export function FiltresLots({ filtres, sources, onChange, total }: FiltresLotsProps) {
  const id = useId();
  const champRecherche = useRef<HTMLInputElement>(null);
  const actifs = filtresActifs(filtres);

  // Une source portée par l'URL peut ne plus figurer dans la liste (lot disparu, liste en cours de
  // chargement) : sans cette option, le <select> contrôlé afficherait « Toutes » alors que le filtre
  // est bien appliqué, et l'écran mentirait sur ce qu'il filtre.
  const valeursSources = sources.map((s) => s.valeur);
  const sourceInconnue = filtres.source !== "" && !valeursSources.includes(filtres.source);

  function effacer() {
    onChange(FILTRES_LOTS_VIDES);
    // Le bouton devient inactif juste après : le focus ne doit pas se perdre avec lui.
    champRecherche.current?.focus();
  }

  return (
    <form
      role="search"
      aria-label="Filtrer les lots reçus"
      className="space-y-2"
      onSubmit={(e) => e.preventDefault()}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_2fr_auto] lg:items-end">
        <div>
          <label htmlFor={`${id}-statut`} className="mb-1 block text-sm font-medium text-slate-800">Statut</label>
          <Select
            id={`${id}-statut`}
            className={CIBLE}
            value={filtres.statut}
            onChange={(e) => onChange({ ...filtres, statut: e.target.value as StatutLot | "" })}
          >
            <option value="">Tous les statuts</option>
            {ORDRE_STATUTS.map((s) => <option key={s} value={s}>{LIBELLE_STATUT_FILTRE[s]}</option>)}
          </Select>
        </div>

        <div>
          <label htmlFor={`${id}-source`} className="mb-1 block text-sm font-medium text-slate-800">Source</label>
          <Select
            id={`${id}-source`}
            className={CIBLE}
            value={filtres.source}
            onChange={(e) => onChange({ ...filtres, source: e.target.value })}
          >
            <option value="">Toutes les sources</option>
            {sourceInconnue && <option value={filtres.source}>{filtres.source}</option>}
            {sources.map((s) => (
              <option key={s.valeur} value={s.valeur}>
                {s.valeur} ({s.nombreLots.toLocaleString("fr-FR")})
              </option>
            ))}
          </Select>
        </div>

        <div>
          <label htmlFor={`${id}-q`} className="mb-1 block text-sm font-medium text-slate-800">Rechercher</label>
          <Input
            id={`${id}-q`}
            ref={champRecherche}
            type="search"
            className={CIBLE}
            placeholder="Référence, nom de fichier ou source"
            autoComplete="off"
            value={filtres.q}
            onChange={(e) => onChange({ ...filtres, q: e.target.value })}
          />
        </div>

        <Button
          type="button"
          variant="outline"
          className={CIBLE}
          disabled={!actifs}
          onClick={effacer}
        >
          Effacer les filtres
        </Button>
      </div>

      <p role="status" aria-live="polite" aria-atomic="true" className="min-h-5 text-sm text-slate-700">
        {phraseTotal(total, actifs)}
      </p>
    </form>
  );
}
