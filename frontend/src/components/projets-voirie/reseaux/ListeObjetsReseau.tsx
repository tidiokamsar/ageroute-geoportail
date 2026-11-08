import { useId, useState } from "react";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, RotateCcw, Search } from "lucide-react";
import { Button } from "../../ui/Button";
import { Input, Select } from "../../ui/Input";
import { EtatErreur, EtatVide } from "../EtatsPv";
import { CLASSES_BASCULE_ACTIF, CLASSES_BASCULE_INACTIF } from "../ListeConflits";
import { nomDuJeu } from "../PanneauCouches";
import { BadgeClasse, BadgeNature } from "./BadgesReseau";
import type { JeuProjet } from "../../../lib/projetsVoirieApi";
import type { ObjetReseau, PageObjetsReseau } from "../../../lib/projetsVoirieReseauxApi";
import {
  FILTRES_OBJETS_VIDES, LIBELLE_NATURE_COURT, LIBELLE_STATUT_QUALITE, NATURES_FILTRE, RECHERCHE_OBJET_MAX, ROLES_JEU_QUALIFIABLES, TOUS_TYPES_OBJET,
  classerErreurReseau, libelleTypeObjet, nbFiltresObjets, texteMetres, type FiltresObjets,
} from "../../../lib/projetsVoirieReseaux";
import { formaterNombre } from "../../../lib/projetsVoirie";

/**
 * Liste des objets des reseaux : nature (infrastructure physique, circuit logique, equipement, inconnue), classe de precision declaree (A a E, ou
 * « non renseignee », jamais inventee), qualite, profondeur et altitude SEULEMENT si le serveur les fournit. Filtres : nature, jeu, type, recherche.
 * Pagination par curseur. Aucune geometrie n'est chargee par cette liste.
 */

export type RequeteObjets = UseInfiniteQueryResult<InfiniteData<PageObjetsReseau>, unknown>;

export interface PropsListeObjets {
  requete: RequeteObjets;
  filtres: FiltresObjets;
  onFiltres: (f: FiltresObjets) => void;
  objets: ObjetReseau[];
  ignores: number;
  jeux: JeuProjet[];
  selectionId: string | null;
  onOuvrir: (o: ObjetReseau) => void;
}

function Qualite({ o }: { o: ObjetReseau }) {
  const q = o.qualite;
  const v = o.vertical;
  const morceaux = [
    q.statutQualite && q.statutQualite !== "INCONNU" ? `Qualité : ${LIBELLE_STATUT_QUALITE[q.statutQualite].toLowerCase()}` : null,
    q.precisionHorizontaleM !== null ? `précision horizontale ${texteMetres(q.precisionHorizontaleM)}` : null,
    v.profondeurM !== null ? `profondeur ${texteMetres(v.profondeurM)}` : null,
    v.altitudeM !== null ? `altitude ${texteMetres(v.altitudeM)}` : null,
  ].filter(Boolean);
  return <>{morceaux.length > 0 ? morceaux.join(" · ") : "Qualité, profondeur et altitude non renseignées"}</>;
}

function LigneObjet({ o, actif, onOuvrir }: { o: ObjetReseau; actif: boolean; onOuvrir: (o: ObjetReseau) => void }) {
  const s = o.source;
  return (
    <li>
      <button
        type="button" onClick={() => onOuvrir(o)} aria-current={actif ? "true" : undefined} data-objet-reseau-id={o.id}
        className={`flex min-h-[44px] w-full flex-col gap-1 rounded border p-2 text-left text-xs hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy ${actif ? "border-2 border-navy bg-blue-50" : "border-gray-300 bg-white"}`}
      >
        <span className="flex flex-wrap items-center gap-1">
          <BadgeNature nature={o.nature} origine={o.origineNature} />
          <span className="rounded border border-gray-400 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-gray-900">{libelleTypeObjet(o.typeObjet)}</span>
          <BadgeClasse classe={o.qualite.classePrecision} />
        </span>
        <span className="break-words font-medium text-gray-900">{o.nom ?? "Objet sans nom"}</span>
        <span className="break-words text-[11px] text-gray-700"><Qualite o={o} /></span>
        <span className="break-words text-[11px] text-gray-700">
          {s ? `${s.concessionnaire?.nom ?? s.nomFichier ?? "Jeu sans nom"}${s.version !== null ? `, version ${s.version}` : ""}` : "Source masquée ou non fournie"}
          {o.longueurM !== null ? ` · longueur ${texteMetres(o.longueurM)}` : ""}
        </span>
      </button>
    </li>
  );
}

export function ListeObjetsReseau(p: PropsListeObjets) {
  const idQ = useId();
  const idJeu = useId();
  const idType = useId();
  const [avances, setAvances] = useState(false);
  const f = p.filtres;
  const maj = (partiel: Partial<FiltresObjets>) => p.onFiltres({ ...f, ...partiel });
  const actifs = nbFiltresObjets(f);
  const erreur = p.requete.isError ? classerErreurReseau(p.requete.error) : null;
  const aSuite = p.requete.hasNextPage === true;
  const jeuxReseau = p.jeux.filter((j) => ROLES_JEU_QUALIFIABLES.includes(j.role) && j.statut !== "RETIRE");

  return (
    <section aria-labelledby="pv-titre-liste-objets-reseau" className="space-y-3">
      <h3 id="pv-titre-liste-objets-reseau" className="text-sm font-semibold text-navy">Objets des réseaux</h3>

      <div role="group" aria-label="Filtrer par nature" className="flex flex-wrap gap-1">
        <button type="button" aria-pressed={f.nature === ""} onClick={() => maj({ nature: "" })}
          className={`min-h-[44px] rounded border px-2 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-8 ${f.nature === "" ? CLASSES_BASCULE_ACTIF : CLASSES_BASCULE_INACTIF}`}>
          Toutes les natures
        </button>
        {NATURES_FILTRE.map((n) => {
          const on = f.nature === n;
          return (
            <button key={n} type="button" aria-pressed={on} onClick={() => maj({ nature: on ? "" : n })} data-nature-filtre={n}
              className={`min-h-[44px] rounded border px-2 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-8 ${on ? CLASSES_BASCULE_ACTIF : CLASSES_BASCULE_INACTIF}`}>
              {LIBELLE_NATURE_COURT[n]}
            </button>
          );
        })}
      </div>

      <div>
        <label htmlFor={idQ} className="block text-xs font-medium text-gray-800">Rechercher dans le nom de l&apos;objet</label>
        <div className="relative mt-1">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
          <Input id={idQ} type="search" value={f.q} onChange={(e) => maj({ q: e.target.value })} autoComplete="off" maxLength={RECHERCHE_OBJET_MAX} className="border-gray-300 pl-9" />
        </div>
      </div>

      <div>
        <button type="button" aria-expanded={avances} aria-controls="pv-filtres-objets-reseau" onClick={() => setAvances((v) => !v)}
          className="inline-flex min-h-[44px] items-center gap-1 rounded text-xs font-medium text-navy underline focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-8">
          {avances ? <ChevronDown aria-hidden="true" className="h-4 w-4" /> : <ChevronRight aria-hidden="true" className="h-4 w-4" />}
          Filtres avancés{actifs > 0 ? ` (${actifs} actif${actifs > 1 ? "s" : ""})` : ""}
        </button>
        <div id="pv-filtres-objets-reseau" hidden={!avances} className={avances ? "mt-1 grid gap-2 rounded border border-gray-200 bg-white p-2" : "hidden"}>
          <div>
            <label htmlFor={idJeu} className="block text-xs font-medium text-gray-800">Jeu de données</label>
            <Select id={idJeu} value={f.jeuId} onChange={(e) => maj({ jeuId: e.target.value })} className="border-gray-300">
              <option value="">Tous les jeux</option>
              {jeuxReseau.map((j) => <option key={j.id} value={j.id}>{nomDuJeu(j)}, version {j.version}{j.nonAutorise ? " (non autorisé)" : ""}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor={idType} className="block text-xs font-medium text-gray-800">Type d&apos;objet</label>
            <Select id={idType} value={f.typeObjet} onChange={(e) => maj({ typeObjet: e.target.value })} className="border-gray-300">
              <option value="">Tous les types</option>
              {TOUS_TYPES_OBJET.map((t) => <option key={t} value={t}>{libelleTypeObjet(t)}</option>)}
            </Select>
          </div>
        </div>
      </div>

      {actifs > 0 && (
        <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" onClick={() => p.onFiltres(FILTRES_OBJETS_VIDES)}>
          <RotateCcw aria-hidden="true" /> Réinitialiser les filtres
        </Button>
      )}

      {p.requete.isPending && (
        <p role="status" className="flex items-center gap-2 p-2 text-sm text-gray-700"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Chargement des objets…</p>
      )}
      {erreur && <EtatErreur erreur={erreur} sujet="Objets des réseaux" onReessayer={() => void p.requete.refetch()} enCours={p.requete.isFetching} />}

      {p.requete.isSuccess && (
        <>
          <p role="status" className="text-xs text-gray-700" data-testid="etat-liste-objets-reseau">
            {p.objets.length === 0 ? "Aucun objet à afficher." : `${formaterNombre(p.objets.length, 0)} objet(s) chargé(s)${aSuite ? ", d'autres restent à charger" : ""}.`}
          </p>
          {p.ignores > 0 && (
            <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              {p.ignores} élément(s) de la réponse du serveur n&apos;ont pas pu être lus (nature inconnue de cette version de l&apos;interface) et ne sont pas affichés.
            </p>
          )}
          {p.objets.length === 0 ? (
            actifs > 0 ? (
              <EtatVide titre="Aucun objet ne correspond à ces filtres"><p>Modifiez ou réinitialisez les filtres.</p></EtatVide>
            ) : (
              <EtatVide titre="Aucun objet de réseau lisible pour ce projet">
                <p>Les objets viennent des réseaux de concessionnaires déposés. Un fichier reçu n&apos;alimente le projet qu&apos;après autorisation, et un jeu retiré n&apos;est montré à personne.</p>
              </EtatVide>
            )
          ) : (
            <ul aria-label="Liste des objets des réseaux" className="space-y-1.5">
              {p.objets.map((o) => <LigneObjet key={o.id} o={o} actif={p.selectionId === o.id} onOuvrir={p.onOuvrir} />)}
            </ul>
          )}
          {aSuite && (
            <Button type="button" variant="outline" className="min-h-[44px] w-full xl:min-h-9" disabled={p.requete.isFetchingNextPage} onClick={() => void p.requete.fetchNextPage()}>
              {p.requete.isFetchingNextPage ? "Chargement…" : "Charger les objets suivants"}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
