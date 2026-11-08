import { useCallback, useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { PropsOnglet } from "../types";
import { CLES, lireContractuel, lireFicheMarche } from "../../../lib/aideDecisionContractuelApi";
import {
  STATUTS_MARCHE, classerErreur, estErreurAutorisation, libelleStatutMarche, type MarcheVue, type ReponseContractuel, type StatutMarche,
} from "../../../lib/aideDecisionContractuel";
import { Button } from "../../ui/Button";
import { BandeauActualisationEchouee, EtatChargement, EtatErreur, EtatVide } from "../contractuel/EtatsContractuel";
import { BandeauDonneesPartielles } from "../contractuel/BandeauDonneesPartielles";
import { SyntheseContractuelle } from "../contractuel/SyntheseContractuelle";
import { ControlesCoherence } from "../contractuel/ControlesCoherence";
import { TableauMarches } from "../contractuel/TableauMarches";
import { FicheMarche } from "../contractuel/FicheMarche";

/**
 * Onglet « Suivi contractuel » de l'aide a la decision (AD-LOT-5, cahier 8). Lecture seule : l'ecran ne modifie aucune donnee
 * contractuelle (la page Marches reste le lieu de la saisie de la copie gelee).
 *
 * CE QUE L'ECRAN NE FAIT JAMAIS : confondre marche recense et marche actif, contractuel et engage, engage et decaisse,
 * avancement declare et constate, etat physique et avancement financier ; calculer un montant (il affiche ceux du serveur) ;
 * afficher 0 pour une absence ; presenter la copie gelee comme la verite (DigitalRoad n'est pas integre : bandeau permanent).
 * Un refus de droit (403) est un etat a part, distinct d'un vide et d'une panne.
 */

const PAGE = 25;

function retenter(echecs: number, e: unknown): boolean {
  // Un refus de droit ou une entree invalide ne se retente pas : la rejouer ne change rien et retarde le message.
  if (estErreurAutorisation(e) || classerErreur(e).genre === "entree") return false;
  return echecs < 1;
}

export function OngletContractuel({ filtres }: PropsOnglet) {
  const [statuts, setStatuts] = useState<StatutMarche[]>([]);
  const [idOuvert, setIdOuvert] = useState<string | null>(null);

  const liste = useInfiniteQuery({
    queryKey: CLES.liste(filtres, statuts),
    queryFn: ({ pageParam }) => lireContractuel(filtres, { statutMarche: statuts, limite: PAGE, curseur: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (derniere: ReponseContractuel) => derniere.page.curseurSuivant,
    retry: retenter,
    retryDelay: 300,
  });

  const marches = useMemo<MarcheVue[]>(() => liste.data?.pages.flatMap((p) => p.marches) ?? [], [liste.data]);
  const premiere = liste.data?.pages[0];

  const fiche = useQuery({
    queryKey: CLES.fiche(idOuvert ?? ""),
    queryFn: () => lireFicheMarche(idOuvert!),
    enabled: idOuvert !== null,
    retry: retenter,
    retryDelay: 300,
  });

  // Un changement de filtre ou de statut change la liste : la fiche ouverte pouvait ne plus en faire partie.
  const cleFiltres = JSON.stringify([filtres, statuts]);
  useEffect(() => { setIdOuvert(null); }, [cleFiltres]);

  // Base de la fiche : la ligne de la liste, ou, si le marche vient d'un controle et n'est pas encore charge, la reponse de fiche.
  const marcheOuvert = idOuvert === null ? null : marches.find((m) => m.id === idOuvert) ?? fiche.data?.marche ?? null;

  const ouvrir = useCallback((id: string) => setIdOuvert(id), []);
  const fermer = useCallback(() => {
    const id = idOuvert;
    setIdOuvert(null);
    if (id) setTimeout(() => document.querySelector<HTMLButtonElement>(`[data-marche-id="${id}"] button`)?.focus(), 0);
  }, [idOuvert]);

  const basculerStatut = (s: StatutMarche) => setStatuts((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const erreur = liste.isError ? classerErreur(liste.error) : null;

  return (
    <section aria-labelledby="titre-contractuel" className="space-y-4">
      <header>
        <h2 id="titre-contractuel" className="text-lg font-bold text-navy">Suivi contractuel</h2>
        <p className="text-xs text-gray-700">
          Marchés, décomptes et avancement tels que saisis dans la copie locale gelée. Lecture seule : cet écran ne modifie rien et ne remplace pas DigitalRoad.
        </p>
      </header>

      <fieldset className="rounded-md border border-gray-200 p-2">
        <legend className="px-1 text-xs font-semibold text-gray-800">Statut du marché (tel que saisi)</legend>
        <div className="flex flex-wrap gap-x-4">
          {STATUTS_MARCHE.map((s) => (
            <label key={s} className="flex min-h-[44px] items-center gap-2 text-sm xl:min-h-0">
              <input type="checkbox" checked={statuts.includes(s)} onChange={() => basculerStatut(s)} className="h-4 w-4" />
              {libelleStatutMarche(s)}
            </label>
          ))}
        </div>
      </fieldset>

      {liste.isPending && <EtatChargement libelle="Chargement du suivi contractuel…" />}
      {erreur && !premiere && <EtatErreur panneau="Suivi contractuel" erreur={erreur} onReessayer={() => void liste.refetch()} reessaiEnCours={liste.isFetching} />}
      {erreur && premiere && !liste.isFetchNextPageError && <BandeauActualisationEchouee panneau="Suivi contractuel" misAJourLe={liste.dataUpdatedAt} onReessayer={() => void liste.refetch()} />}

      {premiere && (
        <>
          <BandeauDonneesPartielles partielles={premiere.donneesPartielles} fraicheur={premiere.fraicheur} perimetre={premiere.perimetre} />
          {!premiere.droitFinancier && (
            <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
              Votre compte n&apos;a pas le droit de consulter les données financières : aucun montant n&apos;est affiché.
            </p>
          )}
          {premiere.plafond.tronque && (
            <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
              Plus de {premiere.plafond.plafond} marchés : la synthèse et les contrôles portent sur les {premiere.plafond.plafond} plus récents.
            </p>
          )}
          <SyntheseContractuelle synthese={premiere.synthese} />
          <ControlesCoherence controles={premiere.controles} onOuvrirMarche={ouvrir} />

          <div className={idOuvert !== null ? "grid gap-4 xl:grid-cols-[minmax(0,1fr)_30rem]" : "grid gap-4"}>
            <section aria-labelledby="titre-liste-marches" className="min-w-0 space-y-2">
              <h3 id="titre-liste-marches" className="text-sm font-semibold text-navy">Marchés recensés</h3>
              {marches.length === 0 ? (
                <EtatVide
                  titre="Aucun marché recensé pour ce périmètre et ces filtres"
                  detail="Ce n'est pas la preuve qu'aucun marché n'existe : la copie est gelée et partielle. Élargissez les filtres ou vérifiez votre périmètre."
                />
              ) : (
                <TableauMarches marches={marches} total={premiere.page.total} idSelectionne={idOuvert} onOuvrir={ouvrir} />
              )}
              {liste.isFetchNextPageError && <EtatErreur panneau="Marchés suivants" erreur={classerErreur(liste.error)} onReessayer={() => void liste.fetchNextPage()} reessaiEnCours={liste.isFetchingNextPage} />}
              {liste.hasNextPage && (
                <div className="flex items-center gap-3">
                  <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-0" disabled={liste.isFetchingNextPage} onClick={() => void liste.fetchNextPage()}>
                    Afficher les marchés suivants
                  </Button>
                  <span role="status" className="text-xs text-gray-700">
                    {liste.isFetchingNextPage ? "Chargement des marchés suivants…" : `${marches.length} affiché(s) sur ${premiere.page.total}`}
                  </span>
                </div>
              )}
            </section>

            {idOuvert !== null && (
              <div className="min-w-0 xl:sticky xl:top-2 xl:self-start">
                {marcheOuvert
                  ? <FicheMarche marche={marcheOuvert} detail={fiche} onFermer={fermer} />
                  : fiche.isError
                    ? <EtatErreur panneau="Fiche du marché" erreur={classerErreur(fiche.error)} onReessayer={() => void fiche.refetch()} reessaiEnCours={fiche.isFetching} />
                    : <EtatChargement libelle="Chargement de la fiche du marché…" />}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
