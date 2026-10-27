import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListFilter } from "lucide-react";
import {
  TRIS_LISTE, VUES_LISTE, filtrerParVue, resumeFiltres, statutScoreServeur, trierInterventions, vueListeValide,
  type TriListe,
} from "../../../lib/aideDecisionCarte";
import { classerErreur } from "../../../lib/aideDecisionInterventions";
import {
  definirVueListe, selectionner, useChangerOnglet, useFicheIntervention, useListeInterventions, useRegions, useSelection,
} from "../../../lib/aideDecisionInterventionsHooks";
import { nombreFiltresActifs } from "../../../lib/decision";
import { EtatChargement, EtatErreur, EtatVide } from "../carte/EtatsCarte";
import { FicheIntervention } from "../carte/FicheIntervention";
import { TableauInterventions, identifiantLigne } from "../carte/TableauInterventions";
import type { PropsOnglet } from "../types";

/**
 * Onglet « Liste des interventions » : le MEME perimetre que la carte (AD-11 : memes filtres partages, meme serialisation, meme cle de requete),
 * en tableau accessible, avec pagination par curseur (« Charger plus »).
 *
 * HONNETETE SUR LES FILTRES LOCAUX ET LE TRI : le serveur pagine par curseur dans l'ordre du rang. Le tri et le filtre de vue (score incomplet, sans
 * localisation...) portent donc sur les lignes DEJA CHARGEES : l'ecran le dit, avec le total du perimetre quand le serveur le donne. Rien n'est
 * presente comme exhaustif tant qu'il reste une page.
 *
 * SYNCHRONISATION AVEC LA CARTE : choisir une ligne ouvre la fiche et surligne la ligne ; « Voir sur la carte » (localisation valide seulement)
 * demande a la carte de se centrer et ouvre l'onglet Carte. Une selection faite sur la carte surligne la ligne ici (magasin partage).
 */

export function OngletListe({ filtres, onFiltres }: PropsOnglet) {
  const sel = useSelection();
  const vue = vueListeValide(sel.vue) ? sel.vue : "toutes";
  const liste = useListeInterventions(filtres, vue);
  const regions = useRegions();
  const fiche = useFicheIntervention(sel.id);
  const changerOnglet = useChangerOnglet();
  const [tri, setTri] = useState<TriListe>("rang");
  const refTitreFiche = useRef<HTMLHeadingElement>(null);
  const derniereLigne = useRef<string | null>(null);
  const aujourdhui = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const pages = liste.data?.pages ?? null;
  const chargees = useMemo(() => pages?.flatMap((p) => p.items) ?? [], [pages]);
  const total = pages ? (pages[0].totalAffiche ?? pages[0].total) : null;
  const nonAppliques = pages ? pages[0].filtresNonAppliques : [];
  const ignorees = pages?.reduce((n, p) => n + p.ignorees, 0) ?? 0;
  const nomRegion = filtres.regionId === undefined ? null : (regions.data?.find((r) => r.id === filtres.regionId)?.nom ?? null);
  const resume = resumeFiltres(filtres, nomRegion);
  const visibles = useMemo(() => trierInterventions(filtrerParVue(chargees, vue), tri), [chargees, vue, tri]);
  const reste = liste.hasNextPage;

  // Sous 1280 px, la fiche prend la place du tableau (retour clair) : le focus suit, pour le clavier et les lecteurs d'ecran. Au retour,
  // il revient sur la ligne qu'on avait ouverte.
  useEffect(() => {
    const grand = typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1280px)").matches;
    if (sel.id) {
      derniereLigne.current = sel.id;
      if (!grand) { refTitreFiche.current?.focus(); refTitreFiche.current?.scrollIntoView?.({ block: "start" }); }
    } else if (derniereLigne.current) {
      document.getElementById(identifiantLigne(derniereLigne.current))?.focus();
    }
  }, [sel.id]);

  const ouvrirFiche = useCallback((id: string) => selectionner(id), []);
  const voirSurCarte = useCallback((id: string) => { selectionner(id, { centrer: true }); changerOnglet("carte"); }, [changerOnglet]);

  const legende = `Interventions classées par rang : ${visibles.length.toLocaleString("fr-FR")} ligne${visibles.length > 1 ? "s" : ""} affichée${visibles.length > 1 ? "s" : ""}, ${chargees.length.toLocaleString("fr-FR")} chargée${chargees.length > 1 ? "s" : ""}${total === null ? "" : ` sur ${total.toLocaleString("fr-FR")} au total`}.`;

  return (
    <div className="space-y-3">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-navy">Liste des interventions</h2>
        <p className="text-sm text-gray-800">
          Interventions candidates classées par priorité calculée. <strong>Consultatif, non engageant</strong> : le rang est un classement reproductible, pas une décision.
        </p>
        <p className="text-xs text-gray-700" data-filtres={resume ? "actifs" : "aucun"}>
          {resume ? `Filtres partagés actifs : ${resume}.` : "Aucun filtre actif : tout le périmètre auquel votre compte a droit."}{" "}
          {nombreFiltresActifs(filtres) > 0 && (
            <button type="button" onClick={() => onFiltres({})} className="min-h-11 font-medium text-navy underline xl:min-h-0" aria-label="Réinitialiser les filtres partagés">Réinitialiser</button>
          )}
        </p>
        {nonAppliques.map((n) => (
          <p key={n.filtre} role="note" data-filtre-non-applique={n.filtre} className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
            Filtre « {n.filtre} » non appliqué aux interventions : {n.raison}.
          </p>
        ))}
      </header>

      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_26rem] xl:items-start xl:gap-4">
        <div className={`space-y-3 ${sel.id ? "max-xl:hidden" : ""}`}>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="ad-liste-vue" className="mb-0.5 flex items-center gap-1 text-xs font-medium text-gray-800"><ListFilter className="h-3.5 w-3.5" aria-hidden="true" />Afficher</label>
              <select id="ad-liste-vue" className="h-11 rounded-md border border-gray-300 bg-white px-2 text-sm xl:h-9" value={vue} onChange={(e) => definirVueListe(vueListeValide(e.target.value) ? e.target.value : "toutes")}>
                {VUES_LISTE.map((v) => <option key={v.id} value={v.id}>{v.libelle}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="ad-liste-tri" className="mb-0.5 block text-xs font-medium text-gray-800">Trier</label>
              <select id="ad-liste-tri" className="h-11 rounded-md border border-gray-300 bg-white px-2 text-sm xl:h-9" value={tri} onChange={(e) => setTri(e.target.value as TriListe)}>
                {TRIS_LISTE.map((t) => <option key={t.id} value={t.id}>{t.libelle}</option>)}
              </select>
            </div>
          </div>
          {((vue !== "toutes" && statutScoreServeur(vue) === undefined) || tri !== "rang") && reste && (
            <p role="note" className="rounded-md bg-gray-50 p-2 text-xs text-gray-800">
              Le filtre « Afficher » et le tri portent sur les {chargees.length.toLocaleString("fr-FR")} interventions déjà chargées{total === null ? "" : ` (sur ${total.toLocaleString("fr-FR")} au total)`} : chargez la suite pour les étendre.
            </p>
          )}

          {liste.isPending ? (
            <EtatChargement libelle="Chargement des interventions…" />
          ) : liste.isError && !pages ? (
            <EtatErreur panneau="Liste des interventions" erreur={classerErreur(liste.error)} onReessayer={() => { void liste.refetch(); }} reessaiEnCours={liste.isFetching} />
          ) : chargees.length === 0 && !reste ? (
            <EtatVide
              titre="Aucune intervention dans ce périmètre"
              detail={resume ? "Aucune intervention ne correspond aux filtres actifs. Réinitialisez-les pour élargir le périmètre." : "Le serveur ne renvoie aucune intervention : ce n'est pas une erreur, il n'y en a pas à classer."}
            />
          ) : (
            <>
              {ignorees > 0 && (
                <p role="status" className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
                  {ignorees === 1 ? "1 ligne illisible ignorée" : `${ignorees} lignes illisibles ignorées`} (identifiant absent ou en double).
                </p>
              )}
              {visibles.length === 0 ? (
                <EtatVide
                  titre="Aucune intervention chargée ne correspond à cette vue"
                  detail={reste ? "Chargez la suite de la liste : d'autres lignes peuvent correspondre." : "Toutes les interventions du périmètre sont chargées et aucune ne correspond."}
                />
              ) : (
                <TableauInterventions items={visibles} selectionId={sel.id} aujourdhui={aujourdhui} legende={legende} onOuvrirFiche={ouvrirFiche} onVoirSurCarte={voirSurCarte} />
              )}
              {liste.isError && (
                <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-900">
                  La suite de la liste n&apos;a pas pu être chargée : {classerErreur(liste.error).message}{" "}
                  <button type="button" onClick={() => { void liste.fetchNextPage(); }} aria-label="Réessayer : suite de la liste" className="min-h-11 font-medium underline xl:min-h-0">Réessayer</button>
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                {reste && (
                  <button
                    type="button"
                    onClick={() => { void liste.fetchNextPage(); }}
                    disabled={liste.isFetchingNextPage}
                    aria-label={liste.isFetchingNextPage ? undefined : "Charger plus d'interventions"}
                    className="min-h-11 rounded-md border border-navy bg-white px-4 text-sm font-medium text-navy hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 disabled:opacity-60"
                  >
                    {liste.isFetchingNextPage ? "Chargement…" : "Charger plus"}
                  </button>
                )}
                <p role="status" className="text-xs text-gray-800">
                  {reste
                    ? `${chargees.length.toLocaleString("fr-FR")} interventions chargées${total === null ? "" : ` sur ${total.toLocaleString("fr-FR")}`} : la liste n'est pas complète.`
                    : `Liste complète : ${chargees.length.toLocaleString("fr-FR")} intervention${chargees.length > 1 ? "s" : ""}.`}
                </p>
              </div>
            </>
          )}
        </div>

        {sel.id && (
          <div className="xl:sticky xl:top-2">
            <FicheIntervention
              key={sel.id}
              ref={refTitreFiche}
              requete={fiche}
              aujourdhui={aujourdhui}
              onFermer={() => selectionner(null)}
              onVoirSurCarte={voirSurCarte}
            />
          </div>
        )}
      </div>
    </div>
  );
}
