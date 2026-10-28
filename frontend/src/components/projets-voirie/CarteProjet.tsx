import { useCallback, useEffect, useMemo } from "react";
import { GeoJSON, MapContainer, ScaleControl, TileLayer, ZoomControl, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { FONDS, ZOOM_MAX } from "../decision/carte/fonds";
import { ElementsCarteHorsTabulation } from "../carte/ElementsCarteHorsTabulation";
import type { Analyse, CoucheCarte, JeuProjet, ObjetCarte } from "../../lib/projetsVoirieApi";
import { lireObjetCarte } from "../../lib/projetsVoirieApi";
import { STYLE_CONFLIT, arrondirBbox, lireBbox, styleJeu, type Bbox, type CleConflit } from "../../lib/projetsVoirie";
import { nomDuJeu } from "./PanneauCouches";

/**
 * Carte du projet : fond plan (OpenStreetMap) ou satellite (Esri) via les memes fournisseurs que le geoportail (`fonds.ts`, CSP de nginx.conf),
 * echelle, reseaux colores par secteur ET traces par un motif, couches de conflit, selection d'un objet.
 *
 * AUCUN HTML D'UN FICHIER : l'infobulle est un element construit avec `textContent`, la fiche s'ouvre dans le panneau (React, texte). Aucune popup
 * Leaflet a contenu HTML. Rien n'est stocke localement.
 *
 * CLAVIER : les traces ne sont pas des arrets de tabulation (`ElementsCarteHorsTabulation`) ; la voie clavier vers un objet est la liste de
 * l'onglet « Couches ». Le rendu est en canvas (`preferCanvas`) : des dizaines de milliers de traces ne creent pas autant de noeuds DOM.
 */

export const CENTRE_GUINEE: [number, number] = [10.5, -10.8];
export const ZOOM_GUINEE = 7;
export const ZOOM_CADRAGE_MAX = 18;

const identites = new WeakMap<object, number>();
let compteur = 0;
/** Identite stable d'un tableau ou d'un objet recu : change a chaque nouvelle reponse, ce qui recree la couche Leaflet (qui ne suit pas ses props). */
function identite(o: object): number {
  let n = identites.get(o);
  if (n === undefined) { n = ++compteur; identites.set(o, n); }
  return n;
}

const estSurface = (f?: Feature<Geometry>) => f?.geometry.type === "Polygon" || f?.geometry.type === "MultiPolygon";

function infobulle(texte: string): HTMLElement {
  const el = document.createElement("span");
  el.textContent = texte;
  return el;
}

function CoucheJeu({ couche, jeu, onSelect }: { couche: CoucheCarte; jeu: JeuProjet | undefined; onSelect: (o: ObjetCarte) => void }) {
  const s = styleJeu(couche.role ?? jeu?.role ?? null, couche.typeReseau ?? jeu?.typeReseau ?? couche.concessionnaire?.typeReseau ?? null);
  const nom = jeu ? nomDuJeu(jeu) : couche.concessionnaire?.nom ?? "Jeu de données";
  // Jeu non autorise (quarantaine, affiche a la demande) : trace attenuee ET nomme « non autorise » dans l'infobulle et la fiche.
  const nonAutorise = couche.nonAutorise || (jeu?.nonAutorise ?? false);
  const data = useMemo<FeatureCollection>(() => ({ type: "FeatureCollection", features: couche.features }), [couche.features]);
  return (
    <GeoJSON
      key={`${couche.jeuId}-${identite(couche.features)}-${s.couleur}-${nonAutorise}`}
      data={data}
      style={(f) => ({ color: s.couleur, weight: s.epaisseur, opacity: nonAutorise ? 0.45 : 0.95, dashArray: s.motif || undefined, fill: estSurface(f), fillOpacity: 0.08, lineCap: "butt" })}
      pointToLayer={(_f, latlng) => L.circleMarker(latlng, { radius: 5, color: "#ffffff", weight: 1.5, fillColor: s.couleur, fillOpacity: 1 })}
      onEachFeature={(f, layer) => {
        const objet = { ...lireObjetCarte(couche.jeuId, f), nonAutorise };
        layer.on("click", () => onSelect(objet));
        layer.bindTooltip(infobulle(`${nonAutorise ? "Non autorisé · " : ""}${objet.nom ?? "Objet sans nom"} · ${nom}`), { sticky: true });
      }}
    />
  );
}

function Selection({ objet }: { objet: ObjetCarte }) {
  return (
    <GeoJSON
      key={`sel-${objet.jeuId}-${objet.id ?? identite(objet.feature)}`}
      data={objet.feature}
      interactive={false}
      style={() => ({ color: "#f5a623", weight: 9, opacity: 0.85, fill: false })}
      pointToLayer={(_f, latlng) => L.circleMarker(latlng, { radius: 10, color: "#f5a623", weight: 3, fillColor: "#ffffff", fillOpacity: 0.6, interactive: false })}
    />
  );
}

function ZoneConflit({ cle, geometrie }: { cle: Exclude<CleConflit, "croisements">; geometrie: Geometry }) {
  const s = STYLE_CONFLIT[cle];
  const feature = useMemo<Feature<Geometry>>(() => ({ type: "Feature", geometry: geometrie, properties: {} }), [geometrie]);
  return (
    <GeoJSON
      key={`zone-${cle}-${identite(geometrie)}`}
      data={feature}
      interactive={false}
      style={() => ({ color: s.couleur, weight: s.epaisseur, opacity: 0.8, dashArray: s.motif || undefined, lineCap: "butt" })}
    />
  );
}

function Croisements({ collection }: { collection: FeatureCollection }) {
  return (
    <GeoJSON
      key={`croisements-${identite(collection)}`}
      data={collection}
      interactive={false}
      pointToLayer={(_f, latlng) => L.circleMarker(latlng, { radius: 6, color: "#ffffff", weight: 2, fillColor: "#000000", fillOpacity: 1, interactive: false })}
    />
  );
}

function Capteur({ bbox, cadrageCle, onVue }: { bbox: Bbox | null; cadrageCle: number; onVue: (bbox: Bbox, zoom: number) => void }) {
  const map = useMap();
  const lire = useCallback(() => {
    const b = map.getBounds();
    const e = lireBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    if (e) onVue(arrondirBbox(e), map.getZoom());
  }, [map, onVue]);
  useMapEvents({ moveend: lire, zoomend: lire });

  useEffect(() => {
    const c = map.getContainer?.();
    if (c) { c.setAttribute("role", "region"); c.setAttribute("aria-label", "Carte du projet de voirie et réseaux"); }
    lire();
  }, [map]); // eslint-disable-line react-hooks/exhaustive-deps

  const cleBbox = bbox ? bbox.join(",") : "";
  useEffect(() => {
    if (!bbox) return;
    map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { padding: [24, 24], maxZoom: ZOOM_CADRAGE_MAX });
  }, [map, cleBbox, cadrageCle]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export interface PropsCarteProjet {
  fond: "osm" | "satellite";
  bbox: Bbox | null;
  cadrageCle: number;
  couches: CoucheCarte[];
  jeux: JeuProjet[];
  analyse: Analyse | undefined;
  conflitsVisibles: Record<CleConflit, boolean>;
  selection: ObjetCarte | null;
  onSelect: (o: ObjetCarte) => void;
  onVue: (bbox: Bbox, zoom: number) => void;
  className?: string;
}

export function CarteProjet({ fond, bbox, cadrageCle, couches, jeux, analyse, conflitsVisibles, selection, onSelect, onVue, className = "h-full w-full" }: PropsCarteProjet) {
  const f = FONDS[fond];
  const jeuParId = useMemo(() => new Map(jeux.map((j) => [j.id, j])), [jeux]);
  const zones = analyse?.conflits.zones;
  return (
    <MapContainer center={CENTRE_GUINEE} zoom={ZOOM_GUINEE} zoomControl={false} preferCanvas maxZoom={ZOOM_MAX} className={className} scrollWheelZoom>
      <TileLayer key={fond} url={f.url} attribution={f.attribution} maxNativeZoom={f.maxNativeZoom} maxZoom={ZOOM_MAX} />
      <ZoomControl position="bottomleft" />
      <ScaleControl position="bottomright" metric imperial={false} />
      <ElementsCarteHorsTabulation />
      <Capteur bbox={bbox} cadrageCle={cadrageCle} onVue={onVue} />
      {couches.map((c) => <CoucheJeu key={c.jeuId} couche={c} jeu={jeuParId.get(c.jeuId)} onSelect={onSelect} />)}
      {zones?.hors && conflitsVisibles.hors && <ZoneConflit cle="hors" geometrie={zones.hors} />}
      {zones?.emprise && conflitsVisibles.emprise && <ZoneConflit cle="emprise" geometrie={zones.emprise} />}
      {zones?.chaussee && conflitsVisibles.chaussee && <ZoneConflit cle="chaussee" geometrie={zones.chaussee} />}
      {analyse?.conflits.croisements && conflitsVisibles.croisements && <Croisements collection={analyse.conflits.croisements} />}
      {selection && <Selection objet={selection} />}
    </MapContainer>
  );
}
