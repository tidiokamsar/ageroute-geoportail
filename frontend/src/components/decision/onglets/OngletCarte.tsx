import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COUCHES_PAR_DEFAUT, arrondirBbox, bboxAutour, bboxDeLignes, etatZoom, lireInterventionsGeo, lireTroncature,
  type Bbox, type CouchesCarte, type ModeVue,
} from "../../../lib/aideDecisionCarte";
import { classerErreur } from "../../../lib/aideDecisionInterventions";
import {
  acquitterCentrage, definirVueListe, selectionner, useChangerOnglet, useFicheIntervention, useInterventionsGeo, useListeInterventions,
  useRegions, useSelection, useValeurDifferee,
} from "../../../lib/aideDecisionInterventionsHooks";
import { CarteDecision } from "../carte/CarteDecision";
import { FicheIntervention } from "../carte/FicheIntervention";
import { FOND_PAR_DEFAUT, type CleFond } from "../carte/fonds";
import { GardeCarte } from "../carte/GardeCarte";
import { LegendeCarte } from "../carte/LegendeCarte";
import { PanneauFiltresCarte } from "../carte/PanneauFiltresCarte";
import { PanneauInsights } from "../carte/PanneauInsights";
import { useBboxTroncon, useCouchesContexte } from "../carte/useCouchesContexte";
import { usePleinEcran } from "../carte/usePleinEcran";
import type { PropsOnglet } from "../types";

/**
 * Onglet « Carte et priorisation » : la carte du Geoportail (etat du reseau, couches de contexte) a laquelle s'ajoute une couche de PRIORITES
 * distincte, le panneau « Filtres de la carte », la fiche d'une intervention et le panneau « Insights et recommandations » (constats calcules).
 *
 * UNE SEULE REQUETE POUR LA CARTE ET LA LISTE (AD-11) : les filtres partages (`filtres`) sont serialises par la meme fonction pour la liste,
 * l'emprise de la carte et la fiche ; l'onglet « Liste » lit la meme cle de cache que les constats d'ici.
 *
 * SELECTION BIDIRECTIONNELLE SANS BOUCLE : le choix d'une intervention vit dans un magasin partage (`useSelection`). Un clic sur un marqueur ou sur
 * la liste alternative ecrit l'identifiant SANS demande de centrage ; un clic sur une ligne de l'onglet Liste (ou « voir sur la carte ») y ajoute une
 * demande de centrage que la carte acquitte des qu'elle l'a executee. La carte ne recentre donc jamais sur sa propre selection.
 *
 * PLEIN ECRAN : c'est tout l'onglet (filtres, carte, fiche, constats) qui passe en couche fixe ; le fond de page devient `inert`.
 */

export function OngletCarte({ filtres, onFiltres }: PropsOnglet) {
  const racine = useRef<HTMLDivElement>(null);
  const boutonPleinEcran = useRef<HTMLButtonElement>(null);
  const { pleinEcran, basculer } = usePleinEcran(racine, boutonPleinEcran);
  const [mode, setMode] = useState<ModeVue>("etat");
  const [couches, setCouches] = useState<CouchesCarte>(COUCHES_PAR_DEFAUT);
  const [fond, setFond] = useState<CleFond>(FOND_PAR_DEFAUT);
  const [emprise, setEmprise] = useState<{ bbox: Bbox; zoom: number } | null>(null);
  const [focus, setFocus] = useState<{ bbox: Bbox; cle: number } | null>(null);
  const [messageCentrage, setMessageCentrage] = useState<string | null>(null);
  const cleFocus = useRef(0);
  const refTitreFiche = useRef<HTMLHeadingElement>(null);
  const aujourdhui = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const sel = useSelection();
  const changerOnglet = useChangerOnglet();
  const regions = useRegions();
  const contexte = useCouchesContexte(couches);
  const bboxDuTroncon = useBboxTroncon();
  const liste = useListeInterventions(filtres);
  const fiche = useFicheIntervention(sel.id);

  // Une frappe ou un deplacement de carte ne declenche pas une requete a chaque evenement.
  const empriseDiff = useValeurDifferee(emprise, 350);
  const geo = useInterventionsGeo(
    filtres,
    empriseDiff ? empriseDiff.bbox : null,
    couches.priorites && !!empriseDiff && etatZoom(empriseDiff.zoom, empriseDiff.bbox).suffisant,
  );
  // `tronque` et `total` du geojson : la carte le dit et recharge a chaque zoom, la troncature n'est jamais silencieuse.
  const troncature = useMemo(() => lireTroncature(geo.data), [geo.data]);
  const lectureGeo = useMemo(() => lireInterventionsGeo(geo.data as { features?: unknown } | null | undefined), [geo.data]);

  // La carte n'annonce PAS chaque deplacement : seulement quand la vue sort de l'emprise deja chargee, quand le zoom change de cote du minimum,
  // ou sur « Reessayer ». L'onglet garde la derniere emprise annoncee ; elle est arrondie, c'est la cle stable de la requete.
  const empriseCourante = useRef<{ bbox: Bbox; zoom: number } | null>(null);
  const onEmpriseChange = useCallback((bbox: Bbox, zoom: number) => {
    const b = arrondirBbox(bbox);
    const e = empriseCourante.current;
    if (e && e.zoom === zoom && e.bbox.every((v, i) => v === b[i])) return;
    empriseCourante.current = { bbox: b, zoom };
    setEmprise(empriseCourante.current);
  }, []);

  const items = useMemo(() => liste.data?.pages.flatMap((p) => p.items) ?? null, [liste.data]);
  const total = liste.data ? liste.data.pages[0].total : null;
  const erreurGeo = geo.isError ? classerErreur(geo.error) : null;
  const regionsEnErreur = regions.isError && !regions.data;

  // Une autre selection efface le message de centrage de la precedente. DECLARE AVANT l'effet de centrage : dans un meme rendu, l'effacement passe d'abord,
  // puis le centrage peut poser son message (l'ordre inverse l'effacait aussitot).
  useEffect(() => { setMessageCentrage(null); }, [sel.id]);

  // ---- Centrage demande depuis la liste ---------------------------------------------------------------------------
  useEffect(() => {
    if (!sel.centrageEnAttente || !sel.id) return;
    const id = sel.id;
    const surCarte = lectureGeo.interventions.find((i) => i.id === id);
    const ligne = items?.find((i) => i.id === id) ?? (fiche.data?.id === id ? fiche.data : undefined);
    // Ni dans l'emprise chargee ni dans la liste, et la fiche arrive encore : on attend sa reponse avant de conclure.
    if (!surCarte && !ligne && fiche.isPending) return;
    let annule = false;
    void (async () => {
      let bbox: Bbox | null = null;
      if (surCarte) bbox = surCarte.lignes ? bboxDeLignes(surCarte.lignes) : bboxAutour(surCarte.position[0], surCarte.position[1], 0.02);
      else if (ligne?.troncon?.id) {
        try { bbox = await bboxDuTroncon(ligne.troncon.id); } catch { bbox = null; }
      }
      if (annule) return;
      acquitterCentrage();
      if (bbox) { cleFocus.current += 1; setFocus({ bbox, cle: cleFocus.current }); setMessageCentrage(null); }
      else setMessageCentrage("Position introuvable : cette intervention n'est ni dans l'emprise chargée ni sur un tronçon du réseau de référence. La carte n'est pas recentrée, la fiche reste consultable.");
    })();
    return () => { annule = true; };
  }, [sel.centrageEnAttente, sel.id, lectureGeo, items, fiche.data, fiche.isPending, bboxDuTroncon]);

  // Sous 1280 px, la fiche s'ouvre SOUS la carte : le focus la suit (clavier, lecteurs d'ecran) et elle est amenee a l'ecran.
  useEffect(() => {
    const grand = typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1280px)").matches;
    if (sel.id && !grand) { refTitreFiche.current?.focus(); refTitreFiche.current?.scrollIntoView?.({ block: "start" }); }
  }, [sel.id]);

  const voirSurCarte = useCallback((id: string) => selectionner(id, { centrer: true }), []);
  const voirListe = useCallback((vue: Parameters<typeof definirVueListe>[0]) => { definirVueListe(vue); changerOnglet("liste"); }, [changerOnglet]);
  const annonceFiche = fiche.data && sel.id === fiche.data.id
    ? `Fiche ouverte : ${fiche.data.troncon ? `${fiche.data.troncon.code} ` : ""}${fiche.data.rang === null ? "rang non établi" : `rang ${fiche.data.rang}`}.`
    : "";

  return (
    <div ref={racine} className={pleinEcran ? "fixed inset-0 z-50 overflow-y-auto bg-white p-2 sm:p-3" : ""}>
      <p role="status" className="sr-only">{annonceFiche}</p>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        <div className="xl:col-start-2 xl:row-start-2">
          <PanneauFiltresCarte
            mode={mode} onMode={setMode}
            couches={couches} onCouches={setCouches}
            filtres={filtres} onFiltres={onFiltres}
            regions={regions.data} regionsEnErreur={regionsEnErreur}
            fond={fond} onFond={setFond}
            contexte={contexte}
          />
        </div>

        {/* Disposition xl : la FICHE s'ouvre en tete de la colonne de droite (ligne 1), au-dessus des filtres : sinon elle apparaitrait sous un panneau
            de filtres de plus de 1 000 px, hors de l'ecran. L'ordre du DOM reste filtres, carte, fiche, constats (ordre de lecture et de Tab). */}
        <section aria-label="Carte et priorisation" className="space-y-2 xl:sticky xl:top-2 xl:col-start-1 xl:row-span-3 xl:row-start-1 xl:self-start">
          {messageCentrage && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{messageCentrage}</p>}
          <GardeCarte className="min-h-[340px] rounded-xl" onReessayer={() => { setCouches(COUCHES_PAR_DEFAUT); setMode("etat"); }}>
            <CarteDecision
              mode={mode}
              couches={couches}
              filtres={filtres}
              regions={regions.data}
              fond={fond}
              contexte={contexte}
              interventions={geo.data ?? null}
              troncature={troncature}
              chargement={geo.isFetching}
              erreur={erreurGeo}
              onReessayer={() => { void geo.refetch(); }}
              selectionId={sel.id}
              onSelect={(id) => selectionner(id)}
              onEmpriseChange={onEmpriseChange}
              focus={focus}
              bboxDuTroncon={bboxDuTroncon}
              pleinEcran={pleinEcran}
              onBasculerPleinEcran={basculer}
              boutonPleinEcranRef={boutonPleinEcran}
            />
          </GardeCarte>
          <LegendeCarte mode={mode} couches={couches} />
        </section>

        {sel.id && (
          <div className="xl:col-start-2 xl:row-start-1">
            <FicheIntervention
              key={sel.id}
              ref={refTitreFiche}
              requete={fiche}
              aujourdhui={aujourdhui}
              onFermer={() => selectionner(null)}
              onVoirSurCarte={voirSurCarte}
              libelleBoutonCarte="Centrer la carte sur cette intervention"
            />
          </div>
        )}

        <div className="xl:col-start-2 xl:row-start-3">
          <PanneauInsights
            items={items}
            total={total}
            resume={liste.data ? liste.data.pages[0].resume : null}
            suivantExiste={liste.hasNextPage}
            chargement={liste.isPending}
            erreur={liste.isError && !liste.data ? classerErreur(liste.error) : null}
            onReessayer={() => { void liste.refetch(); }}
            onVoirListe={voirListe}
            onChargerPlus={() => { void liste.fetchNextPage(); }}
            chargementSuite={liste.isFetchingNextPage}
          />
        </div>
      </div>
    </div>
  );
}
