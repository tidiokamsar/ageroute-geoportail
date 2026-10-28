import { useEffect, useId, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import type { FiltresDecision } from "./types";
import type { Region } from "../../types";
import { Button } from "../ui/Button";
import { ANNEE_MAX, ANNEE_MIN, CLASSES_FILTRE, dateValide, erreurPeriode, ETATS_FILTRE, FILTRES_INDISPONIBLES, nombreFiltresActifs } from "../../lib/decision";
import { libelleEtat } from "../../features/geoportail/map/symbology";

/**
 * Filtres GLOBAUX de la page (contrat paragraphe 3) : region, classe, etat, periode. Ils s'appliquent aux indicateurs
 * et sont transmis aux onglets. Les filtres que les donnees ne permettent pas (prefecture, axe, bailleur, gravite,
 * type d'intervention) sont affiches DESACTIVES avec leur raison : un filtre retire en silence laisse croire qu'il
 * n'a jamais existe.
 */

const CHAMP = "mt-1 block min-h-[44px] w-full rounded-md border border-gray-400 bg-white px-2 text-sm text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-9 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-700";

function basculer(liste: string[] | undefined, valeur: string): string[] | undefined {
  const l = liste ?? [];
  const suite = l.includes(valeur) ? l.filter((v) => v !== valeur) : [...l, valeur];
  return suite.length > 0 ? suite : undefined;
}

export type RegionsLues = { etat: "chargement" } | { etat: "erreur" } | { etat: "ok"; regions: Region[] };

/**
 * Champ de date a BROUILLON local. Un champ date natif rend `value === ""` tant que la saisie est INCOMPLETE (jour sans
 * annee, annee a trois chiffres) : le traiter comme « filtre vide » enverrait une requete sans date a chaque touche, et
 * une annee en cours de frappe (0002, 0020, 0202...) ferait demander au serveur une date qu'il refuse (400, hors
 * 2000-2100). Seule une date COMPLETE et acceptee par le serveur, ou un champ explicitement vide, remonte aux filtres.
 */
function ChampDate({ id, libelle, valeur, onValeur, invalide, decritPar }: {
  id: string; libelle: string; valeur: string | undefined; onValeur: (v: string | undefined) => void; invalide: boolean; decritPar?: string;
}) {
  const [brouillon, setBrouillon] = useState(valeur ?? "");
  // Un changement venu d'ailleurs (Reinitialiser, URL, onglet) remplace le brouillon.
  useEffect(() => setBrouillon(valeur ?? ""), [valeur]);
  return (
    <div>
      <label htmlFor={id} className="text-xs text-gray-700">{libelle}</label>
      <input
        id={id}
        type="date"
        min={`${ANNEE_MIN}-01-01`}
        max={`${ANNEE_MAX}-12-31`}
        className={CHAMP.replace("mt-1 ", "")}
        value={brouillon}
        aria-invalid={invalide ? true : undefined}
        aria-describedby={decritPar}
        onChange={(e) => {
          const v = e.target.value;
          setBrouillon(v);
          if (e.target.validity.badInput) return; // saisie incomplete : on attend
          if (v === "") onValeur(undefined);
          else if (dateValide(v)) onValeur(v);
        }}
      />
    </div>
  );
}

/** Ouvert sur tablette et ordinateur, replie sur telephone (le panneau occupe alors plus d'un ecran) ; ouvert si l'API de media n'existe pas. */
function ouvertSurCetEcran(): boolean {
  return typeof window === "undefined" || typeof window.matchMedia !== "function" ? true : window.matchMedia("(min-width: 768px)").matches;
}

export function PanneauFiltres({ filtres, onFiltres, regions, ouvertParDefaut }: {
  filtres: FiltresDecision;
  onFiltres: (f: FiltresDecision) => void;
  regions: RegionsLues;
  ouvertParDefaut?: boolean;
}) {
  const id = useId();
  const [ouvert, setOuvert] = useState(ouvertParDefaut ?? ouvertSurCetEcran);
  const actifs = nombreFiltresActifs(filtres);
  const incoherence = erreurPeriode(filtres);

  const maj = (patch: Partial<FiltresDecision>) => {
    const suite: FiltresDecision = { ...filtres, ...patch };
    // Une cle a undefined est retiree : `regionId: undefined` ne doit pas survivre dans l'objet.
    for (const k of Object.keys(suite) as (keyof FiltresDecision)[]) if (suite[k] === undefined) delete suite[k];
    onFiltres(suite);
  };

  const listeRegions = regions.etat === "ok" ? regions.regions : [];
  const regionInconnue = filtres.regionId !== undefined && !listeRegions.some((r) => r.id === filtres.regionId);

  return (
    <section aria-labelledby={`${id}-titre`} className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${id}-titre`} className="text-sm font-semibold text-navy">Filtres de la page</h2>
        <span className="text-xs text-gray-700" data-testid="nb-filtres">{actifs === 0 ? "aucun filtre actif" : `${actifs} filtre${actifs > 1 ? "s" : ""} actif${actifs > 1 ? "s" : ""}`}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={actifs === 0} onClick={() => onFiltres({})}>
            <RotateCcw aria-hidden="true" />
            Réinitialiser
          </Button>
          <Button type="button" size="sm" variant="ghost" className="min-h-[44px] xl:min-h-8" aria-expanded={ouvert} aria-controls={`${id}-corps`} onClick={() => setOuvert((o) => !o)}>
            {ouvert ? "Masquer les filtres" : "Afficher les filtres"}
            <ChevronDown aria-hidden="true" className={ouvert ? "rotate-180" : ""} />
          </Button>
        </div>
      </div>

      <div id={`${id}-corps`} hidden={!ouvert} className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <label htmlFor={`${id}-region`} className="text-xs font-medium text-gray-800">Région</label>
            <select
              id={`${id}-region`}
              className={CHAMP}
              value={filtres.regionId === undefined ? "" : String(filtres.regionId)}
              disabled={regions.etat !== "ok"}
              aria-describedby={regions.etat === "erreur" ? `${id}-region-note` : undefined}
              onChange={(e) => maj({ regionId: e.target.value === "" ? undefined : Number(e.target.value) })}
            >
              <option value="">{regions.etat === "chargement" ? "Chargement des régions…" : "Toutes les régions"}</option>
              {regionInconnue && <option value={String(filtres.regionId)}>Région n° {filtres.regionId}</option>}
              {listeRegions.map((r) => <option key={r.id} value={String(r.id)}>{r.nom}</option>)}
            </select>
            {regions.etat === "erreur" && <p id={`${id}-region-note`} className="mt-1 text-xs text-amber-900">La liste des régions est indisponible : le filtre ne peut pas être changé.</p>}
          </div>

          <fieldset className="min-w-0">
            <legend className="text-xs font-medium text-gray-800">Période</legend>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <ChampDate id={`${id}-depuis`} libelle="Du" valeur={filtres.depuis} onValeur={(v) => maj({ depuis: v })} invalide={!!incoherence} decritPar={incoherence ? `${id}-periode-erreur` : undefined} />
              <ChampDate id={`${id}-jusqua`} libelle="Au" valeur={filtres.jusqua} onValeur={(v) => maj({ jusqua: v })} invalide={!!incoherence} decritPar={incoherence ? `${id}-periode-erreur` : undefined} />
            </div>
            {incoherence && <p id={`${id}-periode-erreur`} role="alert" className="mt-1 text-xs font-medium text-red-900">{incoherence} Les indicateurs ne sont pas recalculés tant que la période est incohérente.</p>}
          </fieldset>

          <fieldset className="min-w-0">
            <legend className="text-xs font-medium text-gray-800">Classe de route</legend>
            <div className="mt-1 flex flex-wrap gap-x-3">
              {CLASSES_FILTRE.map((c) => (
                <label key={c.code} className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-8">
                  <input type="checkbox" className="h-4 w-4" checked={filtres.classe?.includes(c.code) ?? false} onChange={() => maj({ classe: basculer(filtres.classe, c.code) })} />
                  {c.libelle}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="min-w-0">
            <legend className="text-xs font-medium text-gray-800">État du réseau</legend>
            <div className="mt-1 flex flex-wrap gap-x-3">
              {ETATS_FILTRE.map((e) => (
                <label key={e} className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-8">
                  <input type="checkbox" className="h-4 w-4" checked={filtres.etat?.includes(e) ?? false} onChange={() => maj({ etat: basculer(filtres.etat, e) })} />
                  {libelleEtat(e)}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div>
          <h3 className="text-xs font-medium text-gray-800">Filtres indisponibles (données non structurées)</h3>
          <div className="mt-1 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {FILTRES_INDISPONIBLES.map((f) => (
              <div key={f.cle}>
                <label htmlFor={`${id}-${f.cle}`} className="text-xs text-gray-700">{f.libelle}</label>
                <select id={`${id}-${f.cle}`} disabled aria-describedby={`${id}-${f.cle}-raison`} className={CHAMP} defaultValue="">
                  <option value="">Indisponible</option>
                </select>
                <p id={`${id}-${f.cle}-raison`} className="mt-1 text-xs text-gray-700">Indisponible : {f.raison}.</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
