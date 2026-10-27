import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { useAuth } from "../../lib/auth";
import { classerErreur, type Emprise, type Proposition, type StatutProposition } from "../../lib/teledetectionApi";
import {
  useCoherence, usePropositionDetail, usePropositionsGeo, usePropositionsListe, useQualiteMethodes, useRegions, useSources, useSynthese, useValeurDifferee,
} from "../../lib/teledetectionHooks";
import { FILTRES_VIDES, versFiltresPropositions, versFiltresSynthese, type FiltresEcran } from "../../lib/teledetectionFiltres";
import { arrondirEmprise, empriseAutour, peutGererSources } from "../../lib/teledetectionAffichage";
import { etatZoom, lireTroncature } from "../../lib/teledetectionCarte";
import { Button } from "../ui/Button";
import { CarteObservationTerre } from "./CarteObservationTerre";
import { EtatVide } from "./EtatsPanneau";
import { GardeCarte } from "./GardeCarte";
import { IndicateursSynthese } from "./IndicateursSynthese";
import { PanneauDetail } from "./PanneauDetail";
import { PanneauPropositions } from "./PanneauPropositions";
import { QualiteMethodes } from "./QualiteMethodes";
import { PanneauCoherence } from "./PanneauCoherence";
import { TableauSources } from "./TableauSources";
import type { CouchesCarte } from "./types";
import { WidgetTauxConfirmation } from "./WidgetTauxConfirmation";

/**
 * Ecran Observation de la Terre : en-tete, indicateurs, carte, propositions, detail, sources, taux.
 *
 * Disposition : l'ordre du DOM est l'ordre de lecture ET de tabulation (carte, liste, detail, taux et qualite, sources) ; il ne
 * change JAMAIS d'un point de rupture a l'autre (pas de `order`, pas de `contents` : ils separaient l'ordre visuel de l'ordre du focus).
 * En dessous de 1280 px : une seule colonne, la liste OU le detail (retour clair). A partir de 1280 px : une grille de trois colonnes,
 * les panneaux sont PLACES (carte et taux en colonne 1, liste en colonne 2, detail en colonne 3, sources sur toute la largeur).
 *
 * Chaque panneau a ses etats propres (chargement, vide, erreur, permission, perime) : la panne
 * d'un appel n'efface pas les autres et n'est jamais rendue comme un zero ou comme un vide.
 */

const COUCHES_PAR_DEFAUT: CouchesCarte = {
  reseau: true, limites: true, propositions: true, observationsTerrain: false, chantiers: false, ouvrages: false,
};

export function EcranObservationTerre() {
  const { user } = useAuth();
  const role = user?.role;
  const [statut, setStatut] = useState<StatutProposition>("A_VERIFIER");
  const [filtres, setFiltres] = useState<FiltresEcran>(FILTRES_VIDES);
  const [selectionId, setSelectionId] = useState<string | null>(null);
  const [couches, setCouches] = useState<CouchesCarte>(COUCHES_PAR_DEFAUT);
  const [emprise, setEmprise] = useState<{ bbox: Emprise; zoom: number } | null>(null);
  const [focus, setFocus] = useState<{ bbox: Emprise } | null>(null);
  const refTitreDetail = useRef<HTMLHeadingElement>(null);
  const refTitreSources = useRef<HTMLHeadingElement>(null);
  const derniereSelection = useRef<string | null>(null);

  // Une frappe ou un deplacement de carte ne declenche pas une requete a chaque evenement.
  const filtresDiff = useValeurDifferee(filtres, 300);
  const empriseDiff = useValeurDifferee(emprise, 350);

  const synthese = useSynthese(versFiltresSynthese(filtresDiff));
  const sources = useSources();
  const qualite = useQualiteMethodes();
  const coherence = useCoherence();
  const regions = useRegions();
  const liste = usePropositionsListe(versFiltresPropositions(filtresDiff, statut));
  const detail = usePropositionDetail(selectionId);

  // Une seule regle de zoom, celle de la carte (`ZOOM_MINIMUM_PROPOSITIONS`, emprise maximale) : l'ecran n'en garde pas
  // de copie. Tant que la carte n'a rien annonce, on ne bloque rien (elle dit elle-meme « Zoomez »).
  const zoomSuffisant = emprise ? etatZoom(emprise.zoom, emprise.bbox).suffisant : true;
  const geo = usePropositionsGeo(
    empriseDiff ? empriseDiff.bbox : null,
    { statut, type: filtresDiff.type, priorite: filtresDiff.priorite },
    couches.propositions && !!empriseDiff && etatZoom(empriseDiff.zoom, empriseDiff.bbox).suffisant,
  );
  // `tronque` et `total` du geojson : la carte le dit et recharge a chaque zoom, la troncature n'est jamais silencieuse.
  const troncature = useMemo(() => lireTroncature(geo.data), [geo.data]);

  // La carte n'annonce PAS chaque deplacement : seulement quand la vue sort de l'emprise deja chargee (vue elargie de
  // 10 %), quand le zoom change de cote du minimum, ou sur « Reessayer ». L'ecran garde donc la derniere emprise annoncee
  // et la rejoue seul quand le statut ou un filtre change ; elle est arrondie, c'est la cle stable de la requete.
  const empriseCourante = useRef<{ bbox: Emprise; zoom: number } | null>(null);
  const requeteGeo = useRef({ enErreur: false, recharger: () => {} });
  requeteGeo.current = { enErreur: geo.isError, recharger: () => { void geo.refetch(); } };
  const onEmpriseChange = useCallback((bbox: [number, number, number, number], zoom: number) => {
    const b = arrondirEmprise(bbox);
    const e = empriseCourante.current;
    if (e && e.zoom === zoom && e.bbox.every((v, i) => v === b[i])) {
      // Meme emprise redemandee : c'est le « Reessayer » de la carte. Sans changement d'etat, rien ne repartirait.
      if (requeteGeo.current.enErreur) requeteGeo.current.recharger();
      return;
    }
    empriseCourante.current = { bbox: b, zoom };
    setEmprise(empriseCourante.current);
  }, []);

  const choisir = useCallback((p: Proposition) => {
    setSelectionId(p.id);
    if (p.centre) setFocus({ bbox: empriseAutour(p.centre) });
  }, []);

  // En dessous de 1280 px, le detail prend la place de la liste : le focus suit, pour le clavier
  // et les lecteurs d'ecran. Au retour, il revient sur la ligne qu'on avait ouverte.
  useEffect(() => {
    const grand = typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1280px)").matches;
    if (selectionId) {
      derniereSelection.current = selectionId;
      if (!grand) refTitreDetail.current?.focus();
    } else if (derniereSelection.current && !grand) {
      // La proposition choisie sur la carte n'est pas forcement dans la liste : le focus retombe alors sur son titre.
      (document.getElementById(`proposition-${derniereSelection.current}`) ?? document.getElementById("titre-propositions"))?.focus();
    }
  }, [selectionId]);

  function aller() {
    refTitreSources.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    refTitreSources.current?.focus();
  }

  const comptes = synthese.data?.propositions ?? null;
  const erreurGeo = geo.isError ? classerErreur(geo.error).message : null;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-navy">Observation de la Terre</h1>
          <p className="text-sm text-gray-600">Imagerie satellite et détection de changements sur le réseau routier</p>
          <p className="mt-1 text-xs text-gray-600">
            Ces détections sont des <strong>propositions</strong>, jamais des données officielles : seul le terrain les confirme ou les infirme, et aucune ne modifie le référentiel.
          </p>
        </div>
        {peutGererSources(role) && (
          // Ce bouton ne configure RIEN : il mene au tableau d'etat des sources (la configuration se fait cote serveur).
          <Button type="button" className="min-h-[44px] xl:min-h-9" onClick={aller}>
            <Settings2 aria-hidden="true" />
            État des sources
          </Button>
        )}
      </header>

      <IndicateursSynthese synthese={synthese} />

      <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)] xl:grid-rows-[auto_1fr_auto] xl:items-start">
        <section aria-label="Zone cartographique" className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm xl:col-start-1 xl:row-start-1">
          <h2 id="titre-carte" className="sr-only">Carte des propositions satellite</h2>
          <a href="#titre-propositions" className="sr-only focus:not-sr-only focus:absolute focus:z-panneau focus:m-2 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded focus:bg-white focus:p-2 focus:text-sm">
            Passer la carte et aller à la liste des propositions
          </a>
          <div className="p-2">
            <GardeCarte className="min-h-[340px] rounded-xl" onReessayer={() => setCouches(COUCHES_PAR_DEFAUT)}>
              <CarteObservationTerre
                hauteur="h-[460px] md:h-[440px]"
                couchesRepliees
                propositions={geo.data ?? null}
                troncature={troncature}
                chargement={geo.isFetching}
                erreur={erreurGeo}
                zoomSuffisant={zoomSuffisant}
                selectionId={selectionId}
                onSelect={setSelectionId}
                onEmpriseChange={onEmpriseChange}
                couches={couches}
                onCouchesChange={setCouches}
                focus={focus}
              />
            </GardeCarte>
          </div>
        </section>

        <div className={`${selectionId ? "max-xl:hidden" : ""} xl:col-start-2 xl:row-span-2 xl:row-start-1`}>
          <PanneauPropositions
            statut={statut} onStatut={setStatut} comptes={comptes} comptesEnErreur={synthese.isError && !comptes}
            filtres={filtres} onFiltres={setFiltres} liste={liste}
            sources={sources.data} sourcesIndisponibles={sources.isError && !sources.data}
            regions={regions.data} regionsIndisponibles={regions.isError && !regions.data}
            selectionId={selectionId} onSelect={choisir}
          />
        </div>

        <div className={`${selectionId ? "" : "max-xl:hidden"} xl:col-start-3 xl:row-span-2 xl:row-start-1`}>
          {selectionId ? (
            <PanneauDetail key={selectionId} ref={refTitreDetail} detail={detail} role={role} onFermer={() => setSelectionId(null)} />
          ) : (
            <section aria-labelledby="titre-detail-vide" className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
              <h2 id="titre-detail-vide" className="text-base font-semibold text-navy">Détail de la proposition</h2>
              <div className="mt-2"><EtatVide titre="Aucune proposition sélectionnée" detail="Choisissez une proposition dans la liste ou sur la carte pour voir sa provenance, ses limites et les décisions possibles." /></div>
            </section>
          )}
        </div>

        <div className="flex flex-col gap-4 xl:col-start-1 xl:row-start-2">
          <WidgetTauxConfirmation synthese={synthese} />
          <QualiteMethodes qualite={qualite} />
          <PanneauCoherence coherence={coherence} />
        </div>

        <div className="xl:col-span-3 xl:row-start-3">
          <TableauSources ref={refTitreSources} sources={sources} peutVerifier={peutGererSources(role)} />
        </div>
      </div>
    </div>
  );
}
