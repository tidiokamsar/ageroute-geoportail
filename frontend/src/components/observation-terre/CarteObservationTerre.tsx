// La feuille de style de Leaflet vient du paquet, pas d'un CDN : index.html ne la charge plus, et une carte montee sans elle est un fouillis
// (panneaux empiles, controles hors place). Sans cet import, /teledetection ouvert directement s'affichait non mis en page tant qu'une autre
// page de carte n'avait pas ete visitee (defaut revele par le bout en bout reel apres la fusion).
import "leaflet/dist/leaflet.css";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GeoJSON, MapContainer, Marker, Polygon, Polyline, ScaleControl, TileLayer, Tooltip, ZoomControl, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import axios from "axios";
import type { FeatureCollection } from "geojson";
import { ChevronDown, ChevronUp, Layers, List, Maximize2, Minimize2 } from "lucide-react";
import { api } from "../../lib/api";
import { messageErreur } from "../../lib/exploitation";
import {
  CENTRE_GUINEE, DELAI_EMPRISE_MS, PLAFOND_MARQUEURS, STATUTS, ZOOM_INITIAL,
  bboxDepuisLimites, bboxTropLarge, zoomOuverture, bboxVersLimitesLeaflet, chantierLisible, cleIcone, empriseARecharger, etatZoom, libelleMarqueur, libellePriorite, libelleStatut,
  ligneVersLatLng, limiterMarqueurs, lireGeoJsonCouche, lirePropositions, lireTableauCouche, messageCoucheInvalide, messageIgnores,
  messageIllisibles, messagePlafond, messageTroncature, pointLatLonLisible, styleMarqueur, svgMarqueur, syntheseAffichage,
  type Bbox, type LectureCouche, type PropositionCarte,
} from "../../lib/teledetectionCarte";
import { RechercheZoneTroncon } from "../../pages/geoportail/RechercheZoneTroncon";
import { ecranEtroit } from "../../pages/geoportail/affichageTroncon";
import { chantierApproxIcon, ouvrageIcon, TYPE_OUVRAGE_LABEL } from "../../pages/geoportail/symbols";
import { CHANTIER_COLORS, CREDIT_DONNEES, ETAT_LABELS, type ChantierGeoFeature, type OuvrageGeoPoint } from "../../pages/geoportail/types";
import type { CarteObservationTerreProps, CouchesCarte } from "./types";

/**
 * Carte des propositions de l'observation de la Terre.
 *
 * ELLE REUTILISE LE SYSTEME CARTOGRAPHIQUE DU GEOPORTAIL, elle n'en cree pas un second : memes fonds de plan (Esri et
 * OpenStreetMap, aucun fournisseur ajoute, voir nginx.conf), meme centrage sur la Guinee, memes icones d'ouvrages et de
 * chantiers (`pages/geoportail/symbols`), meme recherche (`RechercheZoneTroncon`, branchee sur la liste des chefs-lieux
 * et `/v2/troncons-recherche`), meme principe de couche chargee par emprise avec zoom minimal (`PortionsDateLayer`).
 *
 * CE QU'ELLE DESSINE : ce qui est dans les donnees recues, rien d'autre. Une feature sans geometrie lisible est
 * ecartee ET comptee (« N propositions illisibles ignorees »). Au-dela du plafond, le nombre de propositions non
 * dessinees est dit. Une erreur n'est jamais rendue comme une carte vide : `role="alert"`, et les marqueurs, qui
 * pourraient ne plus correspondre a l'emprise, ne sont pas dessines.
 *
 * LISIBLE SANS LA COULEUR : le fond du marqueur porte le STATUT (couleur et glyphe), la forme porte la PRIORITE
 * (triangle haute, losange moyenne, cercle faible, carre non etablie), un anneau pointille signale une proposition
 * NON RATTACHEE a un tronçon. La legende, sous la carte, le dit.
 *
 * CLAVIER : les marqueurs ne sont pas des arrets de tabulation (300 d'un coup rendraient la page inutilisable) ; la
 * liste alternative, sous la carte, donne a chaque proposition affichee un bouton et reflechit la selection.
 *
 * COUCHES OPTIONNELLES : reseau (fond statique `osm-routes.geojson`), limites (`/v2/geo/contour`), ouvrages et
 * chantiers (`/ouvrages/geo`, `/chantiers/geo`) sont chargees a la premiere activation, avec leur etat dit dans le
 * panneau. « Observations terrain » n'a pas de source reutilisable par emprise : la case est desactivee et le dit.
 */

// ---------------------------------------------------------------------------------------------------------------
// Fonds de plan : les memes fournisseurs que le geoportail (GeoportailPage.tsx, BASEMAPS).
// ---------------------------------------------------------------------------------------------------------------

const FONDS = {
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "&copy; Esri",
    // Au-dela, Esri renvoie une tuile grise en HTTP 200 : on cesse de la demander (voir GeoportailPage).
    maxNativeZoom: 18,
  },
  clair: {
    label: "Plan clair",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: "&copy; Esri, HERE, Garmin, &copy; OpenStreetMap",
    maxNativeZoom: 16,
  },
  osm: {
    label: "OpenStreetMap",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap",
    maxNativeZoom: 19,
  },
} as const;
type CleFond = keyof typeof FONDS;
const ZOOM_MAX = 20;
const ZOOM_CADRAGE_MAX = 15;

// ---------------------------------------------------------------------------------------------------------------
// Icones (memoisees : un DivIcon par apparence, pas un par marqueur)
// ---------------------------------------------------------------------------------------------------------------

const echapper = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const TAILLE_CIBLE = 44; // zone cliquable (px) : un doigt, pas un pixel

const icones = new Map<string, L.DivIcon>();
// Le nom du marqueur est PREFIXE : l'entree de la liste alternative porte le libelle nu (c'est son texte visible, WCAG 2.5.3),
// et deux elements de meme nom pour la meme proposition seraient lus deux fois sans qu'on sache lequel est la carte.
function iconeProposition(p: PropositionCarte, selectionne: boolean): L.DivIcon {
  const cle = `${cleIcone(p, selectionne)}|${p.type}`;
  let icone = icones.get(cle);
  if (!icone) {
    const svg = svgMarqueur(styleMarqueur(p.statut, p.priorite, p.rattachee), { selectionne });
    icone = L.divIcon({
      className: "bdri-proposition-eo",
      iconSize: [TAILLE_CIBLE, TAILLE_CIBLE],
      iconAnchor: [TAILLE_CIBLE / 2, TAILLE_CIBLE / 2],
      html: `<span role="img" aria-label="${echapper(`Marqueur : ${libelleMarqueur(p)}`)}" style="display:flex;width:${TAILLE_CIBLE}px;height:${TAILLE_CIBLE}px;align-items:center;justify-content:center;cursor:pointer">${svg}</span>`,
    });
    icones.set(cle, icone);
  }
  return icone;
}

// ---------------------------------------------------------------------------------------------------------------
// Chargement unique des couches optionnelles
// ---------------------------------------------------------------------------------------------------------------

interface EtatCouche<T> {
  statut: "inactif" | "chargement" | "pret" | "erreur";
  donnees: T | null;
  message: string | null;
  /** Elements recus mais illisibles, ecartes (compteur d'anomalie). */
  ignores: number;
  /** Vrai si la REPONSE est invalide (couche ecartee), faux pour une panne de reseau ou un refus. */
  invalide: boolean;
}

/** La reponse d'une couche n'est pas exploitable : la couche est ecartee, la page continue. */
class CoucheInvalide extends Error {}

const RIEN = { donnees: null, message: null, ignores: 0, invalide: false } as const;

/**
 * Charge une couche a sa PREMIERE activation, une seule fois ; une erreur est gardee et la couche se recharge a la
 * reactivation suivante. Sans react-query : la carte doit fonctionner meme montee hors d'un QueryClientProvider.
 */
function useCoucheDistante<T>(actif: boolean, charger: () => Promise<{ donnees: T; ignores: number }>): EtatCouche<T> {
  const [etat, setEtat] = useState<EtatCouche<T>>({ statut: "inactif", ...RIEN });
  const statut = useRef<EtatCouche<T>["statut"]>("inactif");
  const monte = useRef(true);
  const chargerRef = useRef(charger);
  chargerRef.current = charger;
  useEffect(() => { monte.current = true; return () => { monte.current = false; }; }, []);
  useEffect(() => {
    if (!actif || statut.current === "chargement" || statut.current === "pret") return;
    statut.current = "chargement";
    setEtat({ statut: "chargement", ...RIEN });
    chargerRef.current().then(
      ({ donnees, ignores }) => { statut.current = "pret"; if (monte.current) setEtat({ statut: "pret", donnees, message: null, ignores, invalide: false }); },
      (e: unknown) => {
        statut.current = "erreur";
        if (monte.current) setEtat({ statut: "erreur", donnees: null, message: texteErreur(e), ignores: 0, invalide: e instanceof CoucheInvalide });
      },
    );
  }, [actif]);
  return etat;
}

/**
 * Le texte d'une erreur de chargement : celui du serveur s'il en a donne un, celui d'une `Error` levee ici (deja en
 * francais), un message de reseau pour une requete sans reponse. Jamais le texte anglais d'axios.
 */
function texteErreur(e: unknown): string {
  if (axios.isAxiosError(e)) return e.response ? messageErreur(e, "Chargement impossible.") : "Réseau indisponible : chargement impossible.";
  return e instanceof Error && e.message ? e.message : "Chargement impossible.";
}

/**
 * Une reponse qui n'est pas ce qu'on attend (`{}`, `null`, une page HTML de repli, un objet sans `features`) ne doit
 * jamais atteindre Leaflet ni un `.map` : elle leverait dans le rendu et emporterait la page. Ici elle devient une
 * couche en erreur, avec son message et son compteur, comme une panne de reseau.
 */
function exiger<T>(libelle: string, lecture: LectureCouche<T>): { donnees: T; ignores: number } {
  if (!lecture.ok) throw new CoucheInvalide(messageCoucheInvalide(libelle, lecture.raison));
  return { donnees: lecture.donnees, ignores: lecture.ignores };
}

/** Noms des couches optionnelles : ceux du panneau, repris dans les messages d'anomalie. */
const LIBELLE_COUCHE = { reseau: "Réseau routier", limites: "Limites administratives", ouvrages: "Ouvrages d'art", chantiers: "Chantiers" } as const;

const chargerReseau = async () => exiger(LIBELLE_COUCHE.reseau, lireGeoJsonCouche((await axios.get<unknown>("/osm-routes.geojson")).data));
const chargerLimites = async () => {
  let reponse: unknown;
  try {
    reponse = (await api.get<unknown>("/v2/geo/contour")).data;
  } catch (e) {
    const http = (e as { response?: { status?: number } })?.response?.status;
    if (http === 404) throw new Error("Aucune limite administrative en base : rien n'est tracé.");
    if (http === 401 || http === 403) throw new Error("Accès refusé : cette couche demande le module Géoportail.");
    throw e;
  }
  return exiger(LIBELLE_COUCHE.limites, lireGeoJsonCouche(reponse));
};
const chargerOuvrages = async () => exiger(LIBELLE_COUCHE.ouvrages, lireTableauCouche<OuvrageGeoPoint>((await api.get<unknown>("/ouvrages/geo")).data, pointLatLonLisible));
const chargerChantiers = async () => exiger(LIBELLE_COUCHE.chantiers, lireTableauCouche<ChantierGeoFeature>((await api.get<unknown>("/chantiers/geo")).data, chantierLisible));


// ---------------------------------------------------------------------------------------------------------------
// Petits composants de carte
// ---------------------------------------------------------------------------------------------------------------

/** Emprise visible de la carte, en bbox (null si elle n'est pas lisible). */
function empriseVisible(map: L.Map): Bbox | null {
  const b = map.getBounds();
  return bboxDepuisLimites({ ouest: b.getWest(), sud: b.getSouth(), est: b.getEast(), nord: b.getNorth() });
}

/**
 * VUE D'OUVERTURE NATIONALE HONNETE : centree sur la Guinee, au zoom le plus eloigne dont l'emprise visible reste admise par le
 * serveur (`EMPRISE_MAX_DEGRES`, `ZOOM_MINIMUM_PROPOSITIONS`). Selon la taille du conteneur c'est donc la Guinee entiere ou, sur un grand
 * ecran, sa partie centrale : jamais une vue sur laquelle on affiche « Zoomez » avant meme que l'agent ait touche la carte.
 * Conteneur sans taille (masque, test) : la vue initiale est conservee.
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

function CapteCarte({ onMap, onVue, onFond }: { onMap: (m: L.Map) => void; onVue: (bbox: Bbox | null, zoom: number) => void; onFond: () => void }) {
  const map = useMap();
  const lire = useCallback(() => {
    onVue(empriseVisible(map), map.getZoom());
  }, [map, onVue]);
  useMapEvents({ moveend: lire, zoomend: lire, click: onFond });
  useEffect(() => {
    onMap(map);
    const c = map.getContainer?.();
    if (c) { c.setAttribute("role", "region"); c.setAttribute("aria-label", "Carte des propositions d'observation de la Terre"); }
    ouvrirSurLaGuinee(map);
    lire();
  }, [map]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Dessin decoratif : le texte voisin porte le sens. `html` vient de `svgMarqueur`, jamais d'une donnee saisie. */
function Pastille({ html }: { html: string }) {
  return <span aria-hidden="true" className="inline-flex shrink-0" dangerouslySetInnerHTML={{ __html: html }} />;
}

const NEUTRE = (priorite: PropositionCarte["priorite"]) => styleMarqueur("", priorite, true);

function Legende() {
  return (
    <details className="group rounded-lg border border-gray-200 bg-white text-sm">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 font-medium text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60">
        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
        Légende des marqueurs
      </summary>
      <div className="grid gap-4 px-3 pb-3 sm:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-700">Statut : couleur et signe</h3>
          <ul className="space-y-1">
            {STATUTS.map((s) => (
              <li key={s} className="flex items-center gap-2"><Pastille html={svgMarqueur(styleMarqueur(s, "FAIBLE", true), { taille: 24 })} /> {libelleStatut(s)}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-700">Priorité : forme</h3>
          <ul className="space-y-1">
            {(["HAUTE", "MOYENNE", "FAIBLE", null] as const).map((p) => (
              <li key={p ?? "aucune"} className="flex items-center gap-2"><Pastille html={svgMarqueur(NEUTRE(p), { taille: 24 })} /> {libellePriorite(p)[0].toUpperCase() + libellePriorite(p).slice(1)}</li>
            ))}
          </ul>
          <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-gray-700">Rattachement et sélection</h3>
          <ul className="space-y-1">
            <li className="flex items-center gap-2"><Pastille html={svgMarqueur(styleMarqueur("A_VERIFIER", "MOYENNE", false), { taille: 24 })} /> Anneau pointillé : non rattachée à un tronçon</li>
            <li className="flex items-center gap-2"><Pastille html={svgMarqueur(styleMarqueur("A_VERIFIER", "MOYENNE", true), { selectionne: true, taille: 24 })} /> Halo doré : proposition sélectionnée</li>
          </ul>
        </div>
        <p className="text-xs text-gray-700 sm:col-span-2">
          La couleur n'est jamais seule : chaque statut a son signe, chaque priorité sa forme. Le repère d'une ligne (route, coupure) est placé à mi-longueur du tracé, celui d'un polygone au centre de son
          emprise ; le tracé et le contour sont dessinés tels que reçus.
        </p>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Composant
// ---------------------------------------------------------------------------------------------------------------

const LIGNES_COUCHES: { cle: Exclude<keyof CouchesCarte, "observationsTerrain">; libelle: string }[] = [
  { cle: "reseau", libelle: LIBELLE_COUCHE.reseau },
  { cle: "propositions", libelle: "Propositions (satellite)" },
  { cle: "chantiers", libelle: LIBELLE_COUCHE.chantiers },
  { cle: "ouvrages", libelle: LIBELLE_COUCHE.ouvrages },
  { cle: "limites", libelle: LIBELLE_COUCHE.limites },
];

const CLASSES_COMMANDE = "flex h-11 w-11 items-center justify-center rounded-lg border border-gray-300 bg-white text-navy shadow-md hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60";

export function CarteObservationTerre(p: CarteObservationTerreProps) {
  const { propositions, troncature, chargement, erreur, zoomSuffisant: zoomParent, selectionId, onSelect, onEmpriseChange, couches, onCouchesChange, focus, className, hauteur, couchesRepliees } = p;

  const [map, setMap] = useState<L.Map | null>(null);
  const [vue, setVue] = useState<{ bbox: Bbox | null; zoom: number }>({ bbox: null, zoom: ZOOM_INITIAL });
  const [fond, setFond] = useState<CleFond>("satellite");
  const surSelection = useRef(onSelect);
  surSelection.current = onSelect;
  const surVue = useCallback((bbox: Bbox | null, zoom: number) => setVue({ bbox, zoom }), []);
  const surFond = useCallback(() => surSelection.current(null), []);
  const [panneauOuvert, setPanneauOuvert] = useState(() => !couchesRepliees && !ecranEtroit());
  const [listeOuverte, setListeOuverte] = useState(false);
  const [pleinEcran, setPleinEcran] = useState(false);
  const racine = useRef<HTMLElement>(null);
  const boutonPleinEcran = useRef<HTMLButtonElement>(null);
  const etaitPleinEcran = useRef(false);

  // ---- Couches optionnelles --------------------------------------------------------------------------------
  const reseau = useCoucheDistante(couches.reseau, chargerReseau);
  const limites = useCoucheDistante(couches.limites, chargerLimites);
  const ouvrages = useCoucheDistante(couches.ouvrages, chargerOuvrages);
  const chantiers = useCoucheDistante(couches.chantiers, chargerChantiers);

  // ---- Annonce de l'emprise au parent ----------------------------------------------------------------------
  const surEmprise = useRef(onEmpriseChange);
  surEmprise.current = onEmpriseChange;
  const chargee = useRef<Bbox | null>(null);
  const dernierZoomAnnonce = useRef<number | null>(null);
  // Une reponse tronquee n'est pas « l'emprise chargee » : zoomer dedans ferait manquer des propositions. Une ref, et non
  // une dependance de `annoncer` : l'arrivee d'une reponse ne doit pas, a elle seule, relancer une demande.
  const tronquee = useRef(false);
  tronquee.current = troncature?.tronque === true;

  const annoncer = useCallback((forcer: boolean) => {
    const { bbox, zoom } = vue;
    if (!bbox) return;
    const etat = etatZoom(zoom, bbox);
    // Emprise trop large malgre un zoom suffisant (grand ecran) : on ne la demande pas, la carte le dit.
    if (etat.raison === "emprise") return;
    if (etat.raison === "zoom") {
      // Le parent doit savoir que le zoom est insuffisant ; une fois par niveau de zoom suffit.
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
  // Rallumer la couche des propositions relance la demande de l'emprise visible.
  const propositionsActives = couches.propositions;
  const etaitActive = useRef(propositionsActives);
  useEffect(() => {
    if (propositionsActives && !etaitActive.current) annoncer(true);
    etaitActive.current = propositionsActives;
  }, [propositionsActives, annoncer]);

  // ---- Recadrage : focus du parent, recherche --------------------------------------------------------------
  const cadrer = useCallback((bbox: Bbox) => {
    map?.fitBounds(bboxVersLimitesLeaflet(bbox), { padding: [24, 24], maxZoom: ZOOM_CADRAGE_MAX });
  }, [map]);
  const cleFocus = focus?.bbox ? focus.bbox.join(",") : "";
  useEffect(() => {
    if (map && focus?.bbox) cadrer(focus.bbox);
  }, [cleFocus, map]); // eslint-disable-line react-hooks/exhaustive-deps

  // Le conteneur change de taille au plein ecran : Leaflet ne le sait pas tout seul.
  useEffect(() => {
    if (!map) return;
    const t = setTimeout(() => map.invalidateSize(), 50);
    return () => clearTimeout(t);
  }, [pleinEcran, map]);
  useEffect(() => {
    if (!pleinEcran) return;
    const surTouche = (e: KeyboardEvent) => { if (e.key === "Escape") setPleinEcran(false); };
    window.addEventListener("keydown", surTouche);
    return () => window.removeEventListener("keydown", surTouche);
  }, [pleinEcran]);
  // Plein ecran = couche FIXE posee sur la page, pas une fenetre : sans precaution, Tab en sort (mesure : 18 arrets sur 25 hors de la
  // couche) et le fond reste atteignable au clavier et au lecteur d'ecran. Tout ce qui entoure la carte, a chaque niveau de l'arbre,
  // devient `inert` (ni focalisable ni lu) ; l'attribut est retire a la sortie, y compris au demontage.
  useEffect(() => {
    if (!pleinEcran) return;
    const rendus: Element[] = [];
    for (let n: Element | null = racine.current; n && n.parentElement; n = n.parentElement) {
      for (const frere of Array.from(n.parentElement.children)) {
        if (frere !== n && !frere.hasAttribute("inert")) { frere.setAttribute("inert", ""); rendus.push(frere); }
      }
    }
    return () => { for (const e of rendus) e.removeAttribute("inert"); };
  }, [pleinEcran]);
  // Au retour (Echap ou bouton), le focus revient sur le bouton qui a ouvert le plein ecran, jamais sur le corps de la page.
  useEffect(() => {
    if (etaitPleinEcran.current && !pleinEcran) boutonPleinEcran.current?.focus();
    etaitPleinEcran.current = pleinEcran;
  }, [pleinEcran]);

  // ---- Propositions ---------------------------------------------------------------------------------------
  const lecture = useMemo(() => lirePropositions(propositions), [propositions]);
  const { affichees, nonAffichees } = useMemo(() => limiterMarqueurs(lecture.propositions, PLAFOND_MARQUEURS, selectionId), [lecture, selectionId]);
  const etat = etatZoom(vue.zoom, vue.bbox);
  const assezZoome = zoomParent && etat.suffisant;
  const dessiner = couches.propositions && assezZoome && !erreur;
  const collectionVide = propositions !== null && Array.isArray(propositions.features) && propositions.features.length === 0;

  const choisirDansListe = (prop: PropositionCarte) => {
    onSelect(prop.id);
    if (map && !map.getBounds().contains(prop.position)) map.panTo(prop.position);
  };

  const basculer = (cle: keyof CouchesCarte) => onCouchesChange({ ...couches, [cle]: !couches[cle] });
  // Anomalies de donnees : couches dont la reponse est invalide (ecartees) + elements illisibles ecartes dans les autres.
  const anomalies = [reseau, limites, ouvrages, chantiers].reduce((n, c) => n + (c.invalide ? 1 : 0) + c.ignores, 0);
  const f = FONDS[fond];
  const traitReseau = fond === "satellite" ? "#f8fafc" : "#475569";
  const traitLimites = fond === "satellite" ? "#fde68a" : "#1a2942";

  const ligneStatut = (cle: (typeof LIGNES_COUCHES)[number]["cle"]): React.ReactNode => {
    if (!couches[cle] || cle === "propositions") return null;
    const e = ({ reseau, limites, ouvrages, chantiers } as Record<string, EtatCouche<unknown>>)[cle];
    if (e.statut === "chargement") return <span className="text-xs text-gray-700">Chargement…</span>;
    if (e.statut === "erreur") return <span role="alert" className="text-xs text-red-700">{e.message ?? "Chargement impossible."}</span>;
    if (e.statut !== "pret") return null;
    const ignores = e.ignores > 0 ? <span className="block text-xs font-medium text-amber-900">{messageIgnores(e.ignores)}</span> : null;
    const n = Array.isArray(e.donnees) ? e.donnees.length : Array.isArray((e.donnees as FeatureCollection | null)?.features) ? (e.donnees as FeatureCollection).features.length : null;
    if (cle === "reseau") return <><span className="text-xs text-gray-700">{n} tracés d&apos;un fond statique : sans état de chaussée</span>{ignores}</>;
    if (cle === "limites") return <><span className="text-xs text-gray-700">Contour simplifié, pas une frontière officielle</span>{ignores}</>;
    return n === 0
      ? <span className="text-xs text-gray-700">Aucun élément en base</span>
      : <><span className="text-xs text-gray-700">{n} éléments</span>{ignores}</>;
  };

  return (
    <section
      ref={racine}
      aria-label="Carte des propositions"
      className={`${pleinEcran ? "fixed inset-0 z-50 flex flex-col gap-2 overflow-y-auto bg-white p-2" : "relative space-y-2"} ${className ?? ""}`}
    >
      <div
        className={`${pleinEcran ? "min-h-[60vh] flex-1" : (hauteur ?? "h-[min(70vh,600px)] min-h-[340px]")} relative isolate overflow-hidden rounded-xl border border-gray-200 bg-gray-100 max-xl:[&_.leaflet-control-zoom_a]:!h-11 max-xl:[&_.leaflet-control-zoom_a]:!w-11 max-xl:[&_.leaflet-control-zoom_a]:!leading-[44px] max-xl:[&_.leaflet-bottom.leaflet-left]:mb-11`}
      >
        {/* Rangee du haut : recherche et couches a gauche, plein ecran a droite. */}
        <div className="pointer-events-none absolute inset-3 z-[1000] flex items-start justify-between gap-2">
          {/* La colonne laisse libre le bas gauche (echelle et zoom, environ 7 rem) : le panneau y defile au lieu de les recouvrir. */}
          <div className="pointer-events-auto flex max-h-[calc(100%-10rem)] w-[min(21rem,calc(100%-3.5rem))] flex-col gap-2 xl:max-h-[calc(100%-7rem)]">
            <RechercheZoneTroncon className="shrink-0" onCentrer={(bbox) => cadrer(bbox)} />
            <div className="flex min-h-0 flex-col rounded-lg border border-gray-200 bg-white/95 shadow-md backdrop-blur">
              <button
                type="button"
                aria-expanded={panneauOuvert}
                aria-controls="eo-panneau-couches"
                onClick={() => setPanneauOuvert((o) => !o)}
                className="flex min-h-11 w-full shrink-0 items-center gap-2 px-3 text-left text-sm font-semibold text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                <Layers className="h-4 w-4" aria-hidden="true" />
                <span className="flex-1">Couches d&apos;affichage</span>
                <span className="text-xs font-normal text-gray-700">{panneauOuvert ? "Déplié" : "Replié"}</span>
                {panneauOuvert ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
              </button>
              {panneauOuvert && (
                <div id="eo-panneau-couches" role="group" aria-label="Couches d'affichage" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto border-t border-gray-100 px-3 py-2 text-sm text-gray-900">
                  {LIGNES_COUCHES.map(({ cle, libelle }) => (
                    <div key={cle}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-2 xl:min-h-8">
                        <input type="checkbox" className="h-5 w-5 shrink-0 accent-navy" checked={couches[cle]} onChange={() => basculer(cle)} />
                        {libelle}
                      </label>
                      <div className="pl-7" aria-live="polite">{ligneStatut(cle)}</div>
                    </div>
                  ))}
                  <div>
                    <label className="flex min-h-11 cursor-not-allowed items-center gap-2 text-gray-700 xl:min-h-8">
                      <input type="checkbox" className="h-5 w-5 shrink-0" checked={false} disabled aria-describedby="eo-obs-indispo" onChange={() => undefined} />
                      Observations terrain
                    </label>
                    <p id="eo-obs-indispo" className="pl-7 text-xs text-gray-700">non disponible dans cette vue</p>
                  </div>
                  <fieldset className="mt-2 border-t border-gray-100 pt-2">
                    <legend className="text-xs font-semibold uppercase tracking-wide text-gray-700">Fond de carte</legend>
                    <div className="mt-1 grid grid-cols-3 gap-1.5">
                      {(Object.keys(FONDS) as CleFond[]).map((k) => (
                        <button
                          key={k}
                          type="button"
                          aria-pressed={fond === k}
                          onClick={() => setFond(k)}
                          className={`min-h-11 rounded-md border px-1.5 text-center text-xs leading-tight xl:min-h-9 ${fond === k ? "border-navy bg-navy text-white" : "border-gray-300 text-gray-800 hover:bg-gray-50"}`}
                        >
                          {FONDS[k].label}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </div>
              )}
            </div>
          </div>
          <button
            ref={boutonPleinEcran}
            type="button"
            onClick={() => setPleinEcran((v) => !v)}
            aria-pressed={pleinEcran}
            aria-label={pleinEcran ? "Quitter le plein écran" : "Plein écran"}
            title={pleinEcran ? "Quitter le plein écran" : "Plein écran"}
            className={`pointer-events-auto ${CLASSES_COMMANDE}`}
          >
            {pleinEcran ? <Minimize2 className="h-5 w-5" aria-hidden="true" /> : <Maximize2 className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>

        <MapContainer center={CENTRE_GUINEE} zoom={ZOOM_INITIAL} maxZoom={ZOOM_MAX} zoomControl={false} style={{ height: "100%", width: "100%" }}>
          <ZoomControl position="bottomleft" />
          <ScaleControl position="bottomleft" imperial={false} />
          <TileLayer key={fond} attribution={`${f.attribution} · ${CREDIT_DONNEES}`} url={f.url} maxZoom={ZOOM_MAX} maxNativeZoom={f.maxNativeZoom} />
          <CapteCarte onMap={setMap} onVue={surVue} onFond={surFond} />

          {couches.reseau && reseau.donnees && (
            <GeoJSON key={`reseau-${fond}`} data={reseau.donnees} interactive={false} style={{ color: traitReseau, weight: 2, opacity: 0.8 }} />
          )}
          {couches.limites && limites.donnees && (
            <GeoJSON key={`limites-${fond}`} data={limites.donnees} interactive={false} style={{ color: traitLimites, weight: 2, opacity: 0.9, dashArray: "8 5", fill: false }} />
          )}

          {couches.chantiers && (chantiers.donnees ?? []).map((c) => {
            if (c.approximate) {
              // Position absente ou illisible : rien n'est dessine (un Marker sans position leverait dans le rendu).
              if (!pointLatLonLisible({ id: c.id, lat: c.lat, lon: c.lon })) return null;
              return (
                <Marker key={`ch-${c.id}`} position={[c.lat as number, c.lon as number]} icon={chantierApproxIcon(CHANTIER_COLORS[c.statut])} keyboard={false}>
                  <Tooltip>{c.intitule} (position approximative, région {c.region ?? "inconnue"})</Tooltip>
                </Marker>
              );
            }
            const pos = ligneVersLatLng(c.geometry);
            if (pos.length < 2) return null;
            return (
              <Polyline key={`ch-${c.id}`} positions={pos} pathOptions={{ color: CHANTIER_COLORS[c.statut], weight: 5, dashArray: c.statut === "TERMINE" ? undefined : "6 6" }}>
                <Tooltip sticky>{c.intitule}</Tooltip>
              </Polyline>
            );
          })}

          {couches.ouvrages && (ouvrages.donnees ?? []).map((o) => (
            <Marker key={`ou-${o.id}`} position={[o.lat, o.lon]} icon={ouvrageIcon(o.type, o.etat, o.repris)} keyboard={false}>
              <Tooltip>{TYPE_OUVRAGE_LABEL[o.type] ?? o.type} : {o.nom} ({ETAT_LABELS[o.etat] ?? o.etat})</Tooltip>
            </Marker>
          ))}

          {dessiner && affichees.map((prop) => {
            const choisie = prop.id === selectionId;
            return (
              <Fragment key={prop.id}>
                {prop.surfaces.map((contour, i) => (
                  <Polygon
                    key={`s${i}`}
                    positions={contour}
                    pathOptions={{
                      color: styleMarqueur(prop.statut, prop.priorite, prop.rattachee).remplissage,
                      weight: choisie ? 4 : 2,
                      dashArray: prop.rattachee === true ? undefined : "6 4",
                      fillOpacity: 0.18,
                      bubblingMouseEvents: false,
                    }}
                    eventHandlers={{ click: () => onSelect(prop.id) }}
                  />
                ))}
                {prop.lignes.map((trait, i) => (
                  <Polyline
                    key={`l${i}`}
                    positions={trait}
                    pathOptions={{
                      color: styleMarqueur(prop.statut, prop.priorite, prop.rattachee).remplissage,
                      weight: choisie ? 6 : 4,
                      dashArray: prop.rattachee === true ? undefined : "6 4",
                      bubblingMouseEvents: false,
                    }}
                    eventHandlers={{ click: () => onSelect(prop.id) }}
                  />
                ))}
                <Marker
                  position={prop.position}
                  icon={iconeProposition(prop, choisie)}
                  keyboard={false}
                  zIndexOffset={choisie ? 1000 : 0}
                  eventHandlers={{ click: () => onSelect(prop.id) }}
                >
                  <Tooltip direction="top" offset={[0, -14]}>{libelleMarqueur(prop)}</Tooltip>
                </Marker>
              </Fragment>
            );
          })}
        </MapContainer>

        {/* Etats : toujours un texte, jamais une carte muette. */}
        <div className="pointer-events-none absolute inset-x-16 bottom-12 z-[1000] xl:bottom-9 flex flex-col items-center gap-1.5 text-center">
          {!couches.propositions && (
            <p role="status" className="pointer-events-auto rounded-md bg-white/95 px-3 py-1.5 text-sm text-gray-900 shadow">Couche « Propositions » masquée.</p>
          )}
          {couches.propositions && erreur && (
            <div role="alert" className="pointer-events-auto rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 shadow">
              <p>Propositions non affichées : {erreur}</p>
              <button
                type="button"
                onClick={() => annoncer(true)}
                aria-label="Réessayer : propositions de la carte"
                className="mt-1 min-h-11 rounded-md border border-red-300 bg-white px-3 text-sm font-medium text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
              >
                Réessayer
              </button>
            </div>
          )}
          {couches.propositions && !erreur && !assezZoome && (
            <p role="status" className="pointer-events-auto rounded-md bg-white/95 px-3 py-1.5 text-sm font-medium text-gray-900 shadow">Zoomez pour afficher les propositions</p>
          )}
          {couches.propositions && !erreur && assezZoome && chargement && (
            <p role="status" className="pointer-events-auto rounded-md bg-white/95 px-3 py-1.5 text-sm text-gray-900 shadow">Chargement des propositions…</p>
          )}
          {couches.propositions && !erreur && assezZoome && !chargement && propositions === null && (
            <p role="status" className="pointer-events-auto rounded-md bg-white/95 px-3 py-1.5 text-sm text-gray-900 shadow">Propositions de cette emprise pas encore chargées.</p>
          )}
          {couches.propositions && !erreur && assezZoome && !chargement && collectionVide && (
            <p role="status" className="pointer-events-auto rounded-md bg-white/95 px-3 py-1.5 text-sm font-medium text-gray-900 shadow">Aucune proposition dans cette emprise</p>
          )}
          {dessiner && troncature?.tronque === true && (
            <p role="status" className="pointer-events-auto rounded-md bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900 shadow">{messageTroncature(troncature, affichees.length)}</p>
          )}
          {anomalies > 0 && (
            <p role="status" className="pointer-events-auto rounded-md bg-amber-50 px-3 py-1.5 text-sm text-amber-900 shadow">
              {anomalies === 1 ? "1 anomalie dans les données des couches" : `${anomalies} anomalies dans les données des couches`} : voir « Couches d&apos;affichage ».
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

      <Legende />

      <div className="rounded-lg border border-gray-200 bg-white text-sm">
        <button
          type="button"
          aria-expanded={listeOuverte}
          aria-controls="eo-liste-propositions"
          onClick={() => setListeOuverte((o) => !o)}
          className="flex min-h-11 w-full items-center gap-2 px-3 text-left font-medium text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
        >
          <List className="h-4 w-4" aria-hidden="true" />
          <span className="flex-1">Liste des propositions affichées ({dessiner ? affichees.length : 0})</span>
          {listeOuverte ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
        </button>
        {listeOuverte && (
          <div id="eo-liste-propositions" className="border-t border-gray-100">
            {dessiner && affichees.length > 0 ? (
              <ul className="max-h-64 overflow-y-auto" aria-label="Propositions affichées sur la carte">
                {affichees.map((prop) => (
                  <li key={prop.id}>
                    <button
                      type="button"
                      aria-pressed={prop.id === selectionId}
                      onClick={() => choisirDansListe(prop)}
                      className={`flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/60 ${prop.id === selectionId ? "bg-amber-50 font-semibold" : ""}`}
                    >
                      <Pastille html={svgMarqueur(styleMarqueur(prop.statut, prop.priorite, prop.rattachee), { taille: 24 })} />
                      <span>{libelleMarqueur(prop)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2 text-gray-700">Aucune proposition affichée sur la carte.</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
