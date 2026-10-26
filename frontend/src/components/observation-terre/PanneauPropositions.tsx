import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { Camera, Filter, Loader2, MapPinOff, Search } from "lucide-react";
import {
  classerErreur, type PagePropositions, type Proposition, type SourceObservation, type StatutProposition, type Synthese,
} from "../../lib/teledetectionApi";
import {
  affichageConfianceDetection, affichageRattachement, affichageTotaux, formaterDate, libelleType, ONGLETS_STATUT,
} from "../../lib/teledetectionAffichage";
import { filtresHorsSynthese, nombreFiltresActifs, type FiltresEcran } from "../../lib/teledetectionFiltres";
import { Button } from "../ui/Button";
import { BandeauPerime, EtatChargement, EtatErreur, EtatVide } from "./EtatsPanneau";
import { PanneauFiltres } from "./PanneauFiltres";
import { PastillePriorite } from "./Pastilles";

/**
 * Panneau « Propositions » : onglets de statut avec compteurs, recherche, filtres, liste paginee
 * par curseur (« Charger plus »). Chaque ligne dit CE QUE LE CHANGEMENT EST, OU il est (ou
 * « Anomalie non rattachee »), QUAND, PAR QUELLE source et methode, sa priorite et sa confiance
 * AVEC sa nature (indice non calibre ou probabilite calibree).
 */

type Liste = UseInfiniteQueryResult<InfiniteData<PagePropositions>, unknown>;

export function LignePropositions({ p, selectionne, onSelect }: { p: Proposition; selectionne: boolean; onSelect: (p: Proposition) => void }) {
  const r = affichageRattachement(p);
  const c = affichageConfianceDetection(p.confianceDetection);
  return (
    <li>
      <button
        type="button"
        id={`proposition-${p.id}`}
        aria-current={selectionne ? "true" : undefined}
        onClick={() => onSelect(p)}
        className={`flex min-h-[44px] w-full items-start gap-3 rounded-md border p-2 text-left transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy ${selectionne ? "border-navy bg-sky-50" : "border-gray-200 bg-white"}`}
      >
        <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-navy/10 text-navy">
          {p.apercuDisponible ? <Camera className="h-5 w-5" /> : <MapPinOff className="h-5 w-5 opacity-60" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-2">
            <span className="text-sm font-semibold text-gray-900">{libelleType(p.type)}</span>
            <time dateTime={p.dateObservation} className="shrink-0 text-xs text-gray-600">{formaterDate(p.dateObservation)}</time>
          </span>
          <span className="block text-xs text-gray-700">
            {r.fiable ? <>{r.titre}{r.zone ? <span className="text-gray-600"> · {r.zone}</span> : null}</> : <span className="font-medium text-amber-800">{r.titre}</span>}
          </span>
          {r.reserve && <span className="block text-xs text-gray-600">{r.reserve}</span>}
          <span className="block text-xs text-gray-600">{p.source.nom} · méthode {p.methode.nom} v{p.methode.version}</span>
          {p.synthetique && <span className="block text-xs font-semibold text-amber-800">Donnée synthétique (démonstration)</span>}
          <span className="mt-1 flex items-center justify-between gap-2">
            <span className="text-xs text-gray-600">Détection : {c.texte}{!c.calibree && p.confianceDetection.valeur !== null ? " (non calibré)" : ""}</span>
            <PastillePriorite niveau={p.priorite.niveau} />
          </span>
        </span>
      </button>
    </li>
  );
}

export function PanneauPropositions({
  statut, onStatut, comptes, comptesEnErreur, filtres, onFiltres, liste, sources, sourcesIndisponibles, regions, regionsIndisponibles, selectionId, onSelect, className = "",
}: {
  statut: StatutProposition;
  onStatut: (s: StatutProposition) => void;
  comptes: Synthese["propositions"] | null;
  comptesEnErreur: boolean;
  filtres: FiltresEcran;
  onFiltres: (f: FiltresEcran) => void;
  liste: Liste;
  sources: SourceObservation[] | undefined;
  sourcesIndisponibles: boolean;
  regions: { id: number; nom: string }[] | undefined;
  regionsIndisponibles: boolean;
  selectionId: string | null;
  onSelect: (p: Proposition) => void;
  className?: string;
}) {
  const [filtresOuverts, setFiltresOuverts] = useState(false);
  const refOnglets = useRef<Array<HTMLButtonElement | null>>([]);
  const actifs = nombreFiltresActifs(filtres);
  const pages = liste.data?.pages;
  const items = useMemo(() => pages?.flatMap((pg) => pg.items) ?? [], [pages]);
  const total = pages?.[0]?.total ?? null;
  const erreur = liste.isError && !liste.isFetchNextPageError ? classerErreur(liste.error) : null;
  const ongletActif = ONGLETS_STATUT.find((o) => o.statut === statut);
  const libelleOnglet = ongletActif?.libelle ?? "";
  // Compteur d'onglet (synthese : region et periode) et total filtre (liste : tous les filtres) : jamais l'un sans l'autre
  // quand ils different.
  const totaux = total !== null && !erreur && liste.data
    ? affichageTotaux({ total, compteurOnglet: comptes && ongletActif ? comptes[ongletActif.cle] : null, autresFiltres: filtresHorsSynthese(filtres), libelleOnglet })
    : null;

  function surTouche(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let cible = i;
    if (e.key === "ArrowRight") cible = (i + 1) % ONGLETS_STATUT.length;
    else if (e.key === "ArrowLeft") cible = (i - 1 + ONGLETS_STATUT.length) % ONGLETS_STATUT.length;
    else if (e.key === "Home") cible = 0;
    else if (e.key === "End") cible = ONGLETS_STATUT.length - 1;
    else return;
    e.preventDefault();
    onStatut(ONGLETS_STATUT[cible].statut);
    refOnglets.current[cible]?.focus();
  }

  return (
    <section aria-labelledby="titre-propositions" className={`rounded-lg border border-gray-200 bg-white p-3 shadow-sm ${className}`}>
      <h2 id="titre-propositions" tabIndex={-1} className="text-base font-semibold text-navy focus:outline-none">
        Propositions{" "}
        <span className="font-normal text-gray-600">
          {total !== null && !erreur ? `(${total.toLocaleString("fr-FR")})` : "(—)"}
          <span className="sr-only"> {total !== null ? `dans l'onglet ${libelleOnglet}` : "nombre indisponible"}</span>
        </span>
      </h2>

      <div role="tablist" aria-label="Statut des propositions" className="mt-2 flex flex-wrap gap-1">
        {ONGLETS_STATUT.map((o, i) => {
          const choisi = o.statut === statut;
          const n = comptes ? comptes[o.cle] : null;
          return (
            <button
              key={o.statut}
              ref={(el) => { refOnglets.current[i] = el; }}
              type="button"
              role="tab"
              id={`onglet-${o.statut}`}
              aria-selected={choisi}
              aria-controls="panneau-propositions"
              tabIndex={choisi ? 0 : -1}
              onClick={() => onStatut(o.statut)}
              onKeyDown={(e) => surTouche(e, i)}
              className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-2.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-9 ${choisi ? "bg-navy text-white" : "bg-gray-100 text-gray-800 hover:bg-gray-200"}`}
            >
              {o.libelle}
              <span className={`rounded-full px-1.5 text-xs font-bold ${choisi ? "bg-white/20 text-white" : "bg-white text-navy"}`}>
                {n === null ? <>—<span className="sr-only"> (indisponible)</span></> : n.toLocaleString("fr-FR")}
              </span>
            </button>
          );
        })}
      </div>
      {comptesEnErreur && <p className="mt-1 text-xs text-gray-600">Les compteurs des onglets sont indisponibles (voir les indicateurs).</p>}

      <div className="mt-2 flex gap-2">
        <div className="relative min-w-0 flex-1">
          <label htmlFor="recherche-propositions" className="sr-only">Rechercher dans les propositions</label>
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input
            id="recherche-propositions" type="search" value={filtres.q} placeholder="Rechercher une zone, un tronçon…"
            onChange={(e) => onFiltres({ ...filtres, q: e.target.value })}
            className="h-11 w-full rounded-md border border-input bg-white pl-8 pr-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:h-9"
          />
        </div>
        <Button
          type="button" variant="outline" className="min-h-[44px] shrink-0 xl:min-h-9" aria-expanded={filtresOuverts} aria-controls="panneau-filtres"
          onClick={() => setFiltresOuverts((o) => !o)}
        >
          <Filter aria-hidden="true" />
          Filtres
          {actifs > 0 && <span className="rounded-full bg-navy px-1.5 text-xs font-bold text-white">{actifs}<span className="sr-only"> filtres actifs</span></span>}
        </Button>
      </div>
      {filtresOuverts && (
        <PanneauFiltres
          filtres={filtres} onChange={onFiltres} sources={sources} sourcesIndisponibles={sourcesIndisponibles} regions={regions} regionsIndisponibles={regionsIndisponibles}
        />
      )}

      <div role="tabpanel" id="panneau-propositions" aria-labelledby={`onglet-${statut}`} className="mt-3 xl:max-h-[640px] xl:overflow-y-auto xl:pr-1">
        {liste.isPending && <EtatChargement libelle="Chargement des propositions…" />}
        {erreur && !liste.data && <EtatErreur panneau="Propositions" erreur={erreur} onReessayer={() => void liste.refetch()} reessaiEnCours={liste.isFetching} />}
        {liste.isError && liste.data && !liste.isFetchNextPageError && <div className="mb-2"><BandeauPerime panneau="Propositions" misAJourLe={liste.dataUpdatedAt} onReessayer={() => void liste.refetch()} /></div>}
        {liste.data && items.length === 0 && (
          <EtatVide
            titre={`Aucune proposition « ${libelleOnglet} »`}
            detail={actifs > 0 ? "Aucune proposition ne correspond à ces filtres. Réinitialisez-les pour élargir la recherche." : "Il n'y a rien à traiter dans cette catégorie."}
          />
        )}
        {items.length > 0 && (
          <>
            <ul className="space-y-2" aria-label={`Propositions ${libelleOnglet}`}>
              {items.map((p) => <LignePropositions key={p.id} p={p} selectionne={p.id === selectionId} onSelect={onSelect} />)}
            </ul>
            <div className="mt-3 flex flex-col items-center gap-2">
              <p className="text-xs text-gray-600" role="status">
                {items.length.toLocaleString("fr-FR")} affichée{items.length > 1 ? "s" : ""}{total !== null ? ` sur ${total.toLocaleString("fr-FR")}` : ""}
              </p>
              {liste.isFetchNextPageError && (
                <p role="alert" className="text-sm text-red-800">Le chargement de la suite a échoué : {classerErreur(liste.error).message}</p>
              )}
              {liste.hasNextPage && (
                <Button type="button" variant="outline" className="min-h-[44px]" disabled={liste.isFetchingNextPage} onClick={() => void liste.fetchNextPage()}>
                  {liste.isFetchingNextPage && <Loader2 aria-hidden="true" className="animate-spin" />}
                  {liste.isFetchingNextPage ? "Chargement…" : "Charger plus"}
                </Button>
              )}
            </div>
          </>
        )}
        {totaux && (
          <div className="mt-2 space-y-1 border-t border-gray-100 pt-2 text-xs text-gray-700">
            <p data-testid="total-filtre">{totaux.totalFiltre}</p>
            {totaux.explication && <p data-testid="ecart-compteurs" className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">{totaux.explication}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
