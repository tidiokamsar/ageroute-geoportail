import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GeoJSON, MapContainer, Marker, Polyline, ScaleControl, TileLayer, Tooltip, ZoomControl, useMap, useMapEvents } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ChevronDown, ChevronUp, List, Maximize2, Minimize2 } from "lucide-react";
import {
  CENTRE_GUINEE, DELAI_EMPRISE_MS, PLAFOND_MARQUEURS, ZOOM_INITIAL,
  bboxDepuisLimites, bboxTropLarge, bboxVersLimitesLeaflet, cleIcone, empriseARecharger, etatZoom, filtrerReseau, lireInterventionsGeo, libelleIntervention,
  ligneVersLatLng, limiterMarqueurs, lireMetaGeo, messageHorsGeometrie, messageIllisibles, messagePlafond, messageTroncature, modeStyleReseau, pointLatLonLisible,
  reseauEnFeatureCollection, styleLigneIntervention, styleMarqueurIntervention, styleReseau, svgMarqueurIntervention, syntheseAffichage, zoomOuverture,
  type Bbox, type CouchesCarte, type InterventionCarte, type ModeVue, type Troncature, type TronconReseau,
} from "../../../lib/aideDecisionCarte";
import type { ErreurAD } from "../../../lib/aideDecisionInterventions";
import { libelleTroncon } from "../../../lib/libelleTroncon";
import { symbole } from "../../../features/geoportail/map/symbology";
import { chantierApproxIcon, ouvrageIcon, pointNoirIcon, TYPE_OUVRAGE_LABEL } from "../../../pages/geoportail/symbols";
import { CHANTIER_COLORS, CREDIT_DONNEES } from "../../../pages/geoportail/types";
import type { FiltresDecision } from "../../decision/types";
import { FONDS, ZOOM_CADRAGE_MAX, ZOOM_MAX, type CleFond } from "./fonds";
import { RechercheZoneTroncon } from "./RechercheZoneTroncon";
import type { CouchesContexte } from "./useCouchesContexte";

/**
 * Carte de l'Aide a la decision : l'ETAT PHYSIQUE du reseau, les PRIORITES des interventions, et le contexte (chantiers, ouvrages, points noirs, contour).
 *
 * ELLE REUTILISE LE SYSTEME CARTOGRAPHIQUE DU GEOPORTAIL, elle n'en cree pas un second : memes fonds de plan (`fonds.ts`), meme centrage sur la
 * Guinee, memes icones d'ouvrages, de points noirs et de chantiers (`pages/geoportail/symbols`), meme echelle d'etat (`symbology.ts`), meme
 * recherche (`RechercheZoneTroncon`), meme principe de couche chargee par emprise avec zoom minimal (`PortionsDateLayer`). Le geoportail lui-meme
 * (GeoportailPage.tsx, 1 782 lignes) n'est ni importe ni modifie : on en reprend les memes sources et les memes symboles.
 *
 * DEUX ECHELLES QUI NE SE MELANGENT JAMAIS : le reseau est peint par l'ETAT (vert a rouge, pointille = etat declare) dans la vue « Etat actuel »,
 * et reste un fond GRIS dans la vue « Priorites ». Les interventions sont des hexagones VIOLETS portant leur rang ; un score incomplet a le contour
 * pointille et le signe « ? ». Une priorite ne prend jamais la couleur d'un etat.
 *
 * CE QU'ELLE DESSINE : ce qui est dans les donnees recues, rien d'autre. Une feature illisible est ecartee ET comptee. Au-dela du plafond ou si le
 * serveur a tronque (`tronque`, `total`), la carte le DIT. Une erreur n'est jamais rendue comme une carte vide : `role="alert"`.
 *
 * CLAVIER : les marqueurs ne sont pas des arrets de tabulation (300 d'un coup rendraient la page inutilisable, mesure faite sur Observation de la
 * Terre) ; la liste alternative, sous la carte, donne a chaque intervention affichee un bouton et reflechit la selection.
 */

const echapper = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const TAILLE_CIBLE = 46; // zone cliquable (px) : un doigt, pas un pixel

const icones = new Map<string, L.DivIcon>();
// Le nom du marqueur est PREFIXE : l'entree de la liste alternative porte le libelle nu (son texte visible, WCAG 2.5.3), et deux elements de meme nom
// pour la meme intervention seraient lus deux fois sans qu'on sache lequel est la carte.
function iconeIntervention(i: InterventionCarte, selectionne: boolean): L.DivIcon {
  const cle = cleIcone(i, selectionne);
  let icone = icones.get(cle);
  if (!icone) {
    const svg = svgMarqueurIntervention(styleMarqueurIntervention(i), { selectionne });
    icone = L.divIcon({
      className: "bdri-intervention-ad",
      iconSize: [TAILLE_CIBLE, TAILLE_CIBLE],
      iconAnchor: [TAILLE_CIBLE / 2, TAILLE_CIBLE / 2],
      html: `<span role="img" aria-label="${echapper(`Marqueur : ${libelleIntervention(i)}`)}" style="display:flex;width:${TAILLE_CIBLE}px;height:${TAILLE_CIBLE}px;align-items:center;justify-content:center;cursor:pointer">${svg}</span>`,
    });
    icones.set(cle, icone);
  }
  return icone;
}

const Pastille = ({ html }: { html: string }) => <span aria-hidden="true" className="inline-flex shrink-0" dangerouslySetInnerHTML={{ __html: html }} />;

function empriseVisible(map: L.Map): Bbox | null {
  const b = map.getBounds();
  return bboxDepuisLimites({ ouest: b.getWest(), sud: b.getSouth(), est: b.getEast(), nord: b.getNorth() });
}

/**
 * VUE D'OUVERTURE NATIONALE HONNETE : centree sur la Guinee, au zoom le plus eloigne dont l'emprise visible reste admise par le serveur. Jamais une
 * vue sur laquelle on affiche « Zoomez » avant meme que l'agent ait touche la carte. Conteneur sans taille (masque, test) : vue initiale conservee.
 */
function ouvrirSurLaGuinee(map: L.Map) {
  const taille = map.getSize?.();
  if (!taille || !(taille.x > 0) || !(taille.y > 0)) return;
  const zoom = zoomOuverture((z) => {
    map.setView(CENTRE_GUINEE, z, { animate: false });
    const b = empriseVisible(map);
    return !b || bboxTropLarge(b);
  });
  map.setView(CENTRE_GUINEE, zoom, { animate: false });
}

function CapteCarte({ onMap, onVue }: { onMap: (m: L.Map) => void; onVue: (bbox: Bbox | null, zoom: number) => void }) {
  const map = useMap();
  const lire = useCallback(() => { onVue(empriseVisible(map), map.getZoom()); }, [map, onVue]);
  useMapEvents({ moveend: lire, zoomend: lire });
  useEffect(() => {
    onMap(map);
    const c = map.getContainer?.();
    if (c) { c.setAttribute("role", "region"); c.setAttribute("aria-label", "Carte de l'état du réseau et des priorités d'intervention"); }
    ouvrirSurLaGuinee(map);
    lire();
  }, [map]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/**
 * ARRETS DE TABULATION DE LA CARTE. Mesure faite dans Chromium (verification du lot, plein ecran puis Tab) : chaque trace SVG interactif de Leaflet
 * (`path.leaflet-interactive`) est un arret de Tab, sans attribut tabindex ; avec le reseau classe (environ 1 700 troncons) et 300 interventions, la
 * page serait inutilisable au clavier. Les icones de groupe de `react-leaflet-cluster` sont des arrets de Tab aussi (`keyboard: true` de L.Marker). Aucun de
 * ces elements n'a d'action clavier : tous sont retires de la tabulation (`tabindex="-1"`) a chaque ajout de calque. Le clavier dispose de la
 * carte elle-meme (fleches, + et -, un seul arret), de la recherche et de la liste alternative des interventions.
 */
function ElementsCarteHorsTabulation() {
  const map = useMap();
  useEffect(() => {
    const c = map.getContainer?.();
    if (!c || typeof MutationObserver === "undefined") return;
    const corriger = () => c.querySelectorAll<Element>(".leaflet-marker-icon:not([tabindex='-1']), path.leaflet-interactive:not([tabindex='-1'])").forEach((e) => e.setAttribute("tabindex", "-1"));
    corriger();
    const o = new MutationObserver(corriger);
    o.observe(c, { childList: true, subtree: true });
    return () => o.disconnect();
  }, [map]);
  return null;
}

export interface PropsCarteDecision {
  mode: ModeVue;
  couches: CouchesCarte;
  filtres: FiltresDecision;
  regions: { id: number; nom: string }[] | undefined;
  fond: CleFond;
  contexte: CouchesContexte;
  /** FeatureCollection brute de `interventions.geojson` (ou null : pas encore recue). La carte la lit et la valide. */
  interventions: unknown | null;
  troncature: Troncature | null;
  chargement: boolean;
  erreur: ErreurAD | null;
  onReessayer: () => void;
  selectionId: string | null;
  onSelect: (id: string | null) => void;
  /** Annonce de l'emprise a charger (quand la vue sort de l'emprise deja chargee, change de cote du zoom minimal, ou sur « Reessayer »). */
  onEmpriseChange: (bbox: Bbox, zoom: number) => void;
  /** Demande de recadrage (selection d'une ligne de liste) ; `cle` change a chaque demande, meme sur la meme cible. */
  focus: { bbox: Bbox; cle: number } | null;
  bboxDuTroncon: (id: string) => Promise<Bbox | null>;
  pleinEcran: boolean;
  onBasculerPleinEcran: () => void;
  boutonPleinEcranRef: React.RefObject<HTMLButtonElement>;
  hauteur?: string;
}

export function CarteDecision(p: PropsCarteDecision) {
  const { mode, couches, filtres, regions, fond, contexte, interventions, troncature, chargement, erreur, selectionId, onSelect, onEmpriseChange, focus, pleinEcran } = p;

  const [map, setMap] = useState<L.Map | null>(null);
  const [vue, setVue] = useState<{ bbox: Bbox | null; zoom: number }>({ bbox: null, zoom: ZOOM_INITIAL });
  const [listeOuverte, setListeOuverte] = useState(false);
  const surVue = useCallback((bbox: Bbox | null, zoom: number) => setVue({ bbox, zoom }), []);

  // ---- Annonce de l'emprise au parent -----------------------------------------------------------------------
  const surEmprise = useRef(onEmpriseChange);
  surEmprise.current = onEmpriseChange;
  const chargee = useRef<Bbox | null>(null);
  const dernierZoomAnnonce = useRef<number | null>(null);
  // Une reponse tronquee n'est pas « l'emprise chargee » : zoomer dedans ferait manquer des interventions. Une ref, et non une dependance de
  // `annoncer` : l'arrivee d'une reponse ne doit pas, a elle seule, relancer une demande.
  const tronquee = useRef(false);
  tronquee.current = troncature?.tronque === true;

  const annoncer = useCallback((forcer: boolean) => {
    const { bbox, zoom } = vue;
    if (!bbox) return;
    const etat = etatZoom(zoom, bbox);
    // Emprise trop large malgre un zoom suffisant (grand ecran) : on ne la demande pas, la carte le dit.
    if (etat.raison === "emprise") return;
    if (etat.raison === "zoom") {
      chargee.current = null;
      if (forcer || dernierZoomAnnonce.current !== zoom) { dernierZoomAnnonce.current = zoom; surEmprise.current(bbox, zoom); }
      return;
    }
    dernierZoomAnnonce.current = zoom;
    if (forcer) chargee.current = null;
    const aCharger = empriseARecharger({ chargee: chargee.current, courante: bbox, zoom, tronquee: tronquee.current });
    if (!aCharger) return;
    chargee.current = aCharger;
    surEmprise.current(aCharger, zoom);
  }, [vue]);

  useEffect(() => {
    if (!vue.bbox) return;
    const t = setTimeout(() => annoncer(false), DELAI_EMPRISE_MS);
    return () => clearTimeout(t);
  }, [vue, annoncer]);

  // Une erreur du parent invalide ce qu'on croyait charge : le prochain deplacement relance la demande.
  useEffect(() => { if (erreur) chargee.current = null; }, [erreur]);
  // Rallumer la couche des priorites relance la demande de l'emprise visible.
  const etaitActive = useRef(couches.priorites);
  useEffect(() => {
    if (couches.priorites && !etaitActive.current) annoncer(true);
    etaitActive.current = couches.priorites;
  }, [couches.priorites, annoncer]);
  // Un changement de filtre ou de fournisseur invalide aussi l'emprise memorisee : le parent re-interroge lui-meme (cle de requete), la memoire est remise a zero.
  const cleFiltres = JSON.stringify(filtres);
  useEffect(() => { chargee.current = null; }, [cleFiltres]);

  // ---- Recadrage : demande du parent, recherche --------------------------------------------------------------
  const cadrer = useCallback((bbox: Bbox) => {
    map?.fitBounds(bboxVersLimitesLeaflet(bbox), { padding: [24, 24], maxZoom: ZOOM_CADRAGE_MAX });
  }, [map]);
  useEffect(() => {
    if (map && focus) cadrer(focus.bbox);
  }, [focus?.cle, map]); // eslint-disable-line react-hooks/exhaustive-deps

  // Le conteneur change de taille au plein ecran : Leaflet ne le sait pas tout seul.
  useEffect(() => {
    if (!map) return;
    const t = setTimeout(() => map.invalidateSize(), 50);
    return () => clearTimeout(t);
  }, [pleinEcran, map]);

  // ---- Interventions ----------------------------------------------------------------------------------------
  const lecture = useMemo(() => lireInterventionsGeo(interventions as { features?: unknown } | null), [interventions]);
  const { affichees, nonAffichees } = useMemo(() => limiterMarqueurs(lecture.interventions, PLAFOND_MARQUEURS, selectionId), [lecture, selectionId]);
  const meta = useMemo(() => lireMetaGeo(interventions), [interventions]);
  const etat = etatZoom(vue.zoom, vue.bbox);
  const assezZoome = etat.suffisant;
  const dessiner = couches.priorites && assezZoome && !erreur;
  const collectionVide = interventions !== null && Array.isArray((interventions as { features?: unknown })?.features) && (interventions as { features: unknown[] }).features.length === 0;

  const choisirDansListe = (i: InterventionCarte) => {
    onSelect(i.id);
    if (map && !map.getBounds().contains(i.position)) map.panTo(i.position);
  };

  // ---- Reseau -----------------------------------------------------------------------------------------------
  const nomRegion = filtres.regionId === undefined ? null : (regions?.find((r) => r.id === filtres.regionId)?.nom ?? null);
  const reseauFiltre = useMemo(
    () => (contexte.reseau.donnees ? filtrerReseau(contexte.reseau.donnees, filtres, nomRegion) : null),
    [contexte.reseau.donnees, filtres, nomRegion],
  );
  const styleMode = modeStyleReseau(mode);
  const reseauParId = useMemo(() => new Map((reseauFiltre?.troncons ?? []).map((t) => [t.id, t])), [reseauFiltre]);
  const reseauFC = useMemo(() => reseauEnFeatureCollection(reseauFiltre?.troncons ?? []), [reseauFiltre]);

  const anomalies = [contexte.reseau, contexte.limites, contexte.ouvrages, contexte.chantiers, contexte.pointsNoirs].reduce((n, c) => n + (c.invalide ? 1 : 0) + c.ignores, 0);
  const f = FONDS[fond];
  const traitLimites = fond === "satellite" ? "#fde68a" : "#1a2942";

  const filtreRegion = <T extends { region: string | null }>(l: T[] | null): T[] => (l ?? []).filter((x) => nomRegion === null || filtres.regionId === undefined || x.region === nomRegion);
  const chantiers = filtreRegion(contexte.chantiers.donnees).filter((c) => !filtres.statutChantier?.length || filtres.statutChantier.includes(c.statut));
  const ouvrages = filtreRegion(contexte.ouvrages.donnees).filter((o) => !filtres.etat?.length || filtres.etat.includes(o.etat));
  const pointsNoirs = filtreRegion(contexte.pointsNoirs.donnees);

  return (
    <div className="space-y-2">
      <div
        className={`${pleinEcran ? "h-[62vh] min-h-[340px]" : (p.hauteur ?? "h-[min(70vh,600px)] min-h-[340px]")} relative isolate overflow-hidden rounded-xl border border-gray-200 bg-gray-100 max-xl:[&_.leaflet-control-zoom_a]:!h-11 max-xl:[&_.leaflet-control-zoom_a]:!w-11 max-xl:[&_.leaflet-control-zoom_a]:!leading-[44px] max-xl:[&_.leaflet-bottom.leaflet-left]:mb-11`}
      >
        {/* Rangee du haut : recherche a gauche, plein ecran a droite. */}
        <div className="pointer-events-none absolute inset-3 z-[1000] flex items-start justify-between gap-2">
          <div className="pointer-events-auto w-[min(21rem,calc(100%-3.5rem))]">
            <RechercheZoneTroncon className="shrink-0" onCentrer={(bbox) => cadrer(bbox)} bboxDuTroncon={p.bboxDuTroncon} />
          </div>
          <button
            ref={p.boutonPleinEcranRef}
            type="button"
            onClick={p.onBasculerPleinEcran}
            aria-pressed={pleinEcran}
            aria-label={pleinEcran ? "Quitter le plein écran" : "Plein écran"}
            title={pleinEcran ? "Quitter le plein écran" : "Plein écran"}
            className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-lg border border-gray-300 bg-white text-navy shadow-md hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            {pleinEcran ? <Minimize2 className="h-5 w-5" aria-hidden="true" /> : <Maximize2 className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>

        <MapContainer center={CENTRE_GUINEE} zoom={ZOOM_INITIAL} maxZoom={ZOOM_MAX} zoomControl={false} style={{ height: "100%", width: "100%" }}>
          <ZoomControl position="bottomleft" />
          <ScaleControl position="bottomleft" imperial={false} />
          <TileLayer key={fond} attribution={`${f.attribution} · ${CREDIT_DONNEES}`} url={f.url} maxZoom={ZOOM_MAX} maxNativeZoom={f.maxNativeZoom} />
          <CapteCarte onMap={setMap} onVue={surVue} />
          <ElementsCarteHorsTabulation />

          {couches.limites && contexte.limites.donnees && (
            <GeoJSON key={`limites-${fond}`} data={contexte.limites.donnees} interactive={false} style={{ color: traitLimites, weight: 2, opacity: 0.9, dashArray: "8 5", fill: false }} />
          )}

          {couches.reseau && reseauFiltre && reseauFiltre.troncons.length > 0 && (
            <GeoJSON
              key={`reseau-${styleMode}-${fond}-${reseauFiltre.troncons.length}-${JSON.stringify(filtres)}`}
              data={reseauFC}
              style={(feature) => {
                const t = feature?.properties?.id ? reseauParId.get(feature.properties.id) : undefined;
                return t ? styleReseau(t, styleMode) : { color: "#848992", weight: 2.6 };
              }}
              onEachFeature={(feature, layer) => {
                const t: TronconReseau | undefined = reseauParId.get(feature.properties?.id);
                if (!t) return;
                const lib = libelleTroncon(t.code, t.nom);
                layer.bindTooltip(styleMode === "etat" ? `${lib} : ${symbole(t.etat).libelle}${t.etatDeclare ? " (état déclaré)" : ""}` : lib, { sticky: true });
              }}
            />
          )}

          {couches.chantiers && chantiers.filter((c) => !c.approximate).map((c) => {
            const pos = ligneVersLatLng(c.geometry);
            if (pos.length < 2) return null;
            return (
              <Polyline key={`ch-${c.id}`} positions={pos} pathOptions={{ color: CHANTIER_COLORS[c.statut] ?? "#9ca3af", weight: 5, dashArray: c.statut === "TERMINE" ? undefined : "6 6" }}>
                <Tooltip sticky>{c.intitule}</Tooltip>
              </Polyline>
            );
          })}

          <MarkerClusterGroup chunkedLoading maxClusterRadius={50}>
            {couches.chantiers && chantiers.filter((c) => c.approximate).map((c) => {
              // Position absente ou illisible : rien n'est dessine (un Marker sans position leve dans le rendu).
              if (!pointLatLonLisible({ id: c.id, lat: c.lat, lon: c.lon })) return null;
              return (
                <Marker key={`cha-${c.id}`} position={[c.lat as number, c.lon as number]} icon={chantierApproxIcon(CHANTIER_COLORS[c.statut] ?? "#9ca3af")} keyboard={false}>
                  <Tooltip>{c.intitule} (position approximative, région {c.region ?? "inconnue"})</Tooltip>
                </Marker>
              );
            })}
            {couches.ouvrages && ouvrages.map((o) => (
              <Marker key={`ou-${o.id}`} position={[o.lat, o.lon]} icon={ouvrageIcon(o.type, o.etat, o.repris)} keyboard={false}>
                <Tooltip>{TYPE_OUVRAGE_LABEL[o.type] ?? o.type} : {o.nom} ({symbole(o.etat).libelle})</Tooltip>
              </Marker>
            ))}
            {couches.pointsNoirs && pointsNoirs.map((pn) => (
              <Marker key={`pn-${pn.id}`} position={[pn.lat, pn.lon]} icon={pointNoirIcon(pn.gravite)} keyboard={false}>
                <Tooltip>Point noir ({pn.gravite.toLowerCase()}) : {pn.description}</Tooltip>
              </Marker>
            ))}
          </MarkerClusterGroup>

          {dessiner && affichees.map((i) => {
            const choisie = i.id === selectionId;
            return (
              <Fragment key={i.id}>
                {i.lignes?.map((l, k) => (
                  <Polyline
                    key={`${i.id}-${k}`}
                    positions={l}
                    pathOptions={{ ...styleLigneIntervention(choisie, i.scoreIncomplet), bubblingMouseEvents: false }}
                    eventHandlers={{ click: () => onSelect(i.id) }}
                  />
                ))}
                <Marker
                  position={i.position}
                  icon={iconeIntervention(i, choisie)}
                  keyboard={false}
                  zIndexOffset={choisie ? 1000 : 0}
                  eventHandlers={{ click: () => onSelect(i.id) }}
                >
                  <Tooltip direction="top" offset={[0, -14]}>{libelleIntervention(i)}</Tooltip>
                </Marker>
              </Fragment>
            );
          })}
        </MapContainer>

        {/* Etats : toujours un texte, jamais une carte muette. */}
        <div className="pointer-events-none absolute inset-x-16 bottom-12 z-[1000] flex flex-col items-center gap-1.5 text-center xl:bottom-9">
          {couches.priorites && erreur && (
            erreur.genre === "permission" ? (
              <p role="status" className="pointer-events-auto rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow">
                Interventions non affichées : accès refusé. {erreur.message}
              </p>
            ) : (
              <div role="alert" className="pointer-events-auto rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 shadow">
                <p>Interventions non affichées : {erreur.message}</p>
                <button
                  type="button"
                  onClick={p.onReessayer}
                  aria-label="Réessayer : interventions de la carte"
                  className="mt-1 min-h-11 rounded-md border border-red-300 bg-white px-3 text-sm font-medium text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  Réessayer
                </button>
              </div>
            )
          )}
          {couches.priorites && !erreur && !assezZoome && (
            <p role="status" className="pointer-events-auto rounded-md bg-white/95 px-3 py-1.5 text-sm font-medium text-gray-900 shadow">Zoomez pour afficher les interventions</p>
          )}
          {couches.priorites && !erreur && assezZoome && chargement && (
            <p role="status" className="pointer-events-auto rounded-md bg-white/95 px-3 py-1.5 text-sm text-gray-900 shadow">Chargement des interventions…</p>
          )}
          {couches.priorites && !erreur && assezZoome && !chargement && interventions === null && (
            <p role="status" className="pointer-events-auto rounded-md bg-white/95 px-3 py-1.5 text-sm text-gray-900 shadow">Interventions de cette emprise pas encore chargées.</p>
          )}
          {couches.priorites && !erreur && assezZoome && !chargement && collectionVide && (
            <p role="status" className="pointer-events-auto rounded-md bg-white/95 px-3 py-1.5 text-sm font-medium text-gray-900 shadow">Aucune intervention dans cette emprise, avec ces filtres.</p>
          )}
          {dessiner && troncature?.tronque === true && (
            <p role="status" className="pointer-events-auto rounded-md bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900 shadow">{messageTroncature(troncature, affichees.length)}</p>
          )}
          {dessiner && meta.horsGeometrie !== null && meta.horsGeometrie > 0 && (
            <p role="status" className="pointer-events-auto rounded-md bg-amber-50 px-3 py-1.5 text-sm text-amber-900 shadow">{messageHorsGeometrie(meta.horsGeometrie)}</p>
          )}
          {anomalies > 0 && (
            <p role="status" className="pointer-events-auto rounded-md bg-amber-50 px-3 py-1.5 text-sm text-amber-900 shadow">
              {anomalies === 1 ? "1 anomalie dans les données des couches" : `${anomalies} anomalies dans les données des couches`} : voir le panneau des filtres.
            </p>
          )}
          {dessiner && nonAffichees > 0 && (
            <p role="status" className="pointer-events-auto rounded-md bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900 shadow">{messagePlafond(nonAffichees)}</p>
          )}
          {dessiner && lecture.ignorees > 0 && (
            <p role="status" className="pointer-events-auto rounded-md bg-amber-50 px-3 py-1.5 text-sm text-amber-900 shadow">{messageIllisibles(lecture.ignorees)}</p>
          )}
        </div>
      </div>

      {dessiner && <p className="text-xs text-gray-700" aria-live="polite">{syntheseAffichage(affichees)}</p>}

      {/* Liste ALTERNATIVE aux marqueurs : un bouton par intervention affichee, au clavier et au lecteur d'ecran. */}
      <div className="rounded-lg border border-gray-200 bg-white text-sm">
        <button
          type="button"
          aria-expanded={listeOuverte}
          aria-controls="decision-liste-affichees"
          onClick={() => setListeOuverte((o) => !o)}
          className="flex min-h-11 w-full items-center gap-2 px-3 text-left font-medium text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        >
          <List className="h-4 w-4" aria-hidden="true" />
          <span className="flex-1">Interventions affichées sur la carte ({dessiner ? affichees.length : 0})</span>
          {listeOuverte ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
        </button>
        {listeOuverte && (
          <div id="decision-liste-affichees" className="border-t border-gray-100">
            {dessiner && affichees.length > 0 ? (
              <ul className="max-h-64 overflow-y-auto" aria-label="Interventions affichées sur la carte">
                {affichees.map((i) => (
                  <li key={i.id}>
                    <button
                      type="button"
                      aria-pressed={i.id === selectionId}
                      onClick={() => choisirDansListe(i)}
                      className={`flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/60 ${i.id === selectionId ? "bg-amber-50 font-semibold" : ""}`}
                    >
                      <Pastille html={svgMarqueurIntervention(styleMarqueurIntervention(i), { taille: 26 })} />
                      <span>{libelleIntervention(i)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2 text-gray-700">Aucune intervention affichée sur la carte.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

