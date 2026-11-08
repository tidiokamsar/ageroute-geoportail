import { useEffect, useMemo } from "react";
import { GeoJSON, MapContainer, ScaleControl, TileLayer, ZoomControl, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { FONDS, ZOOM_MAX } from "../../decision/carte/fonds";
import { ElementsCarteHorsTabulation } from "../../carte/ElementsCarteHorsTabulation";
import { bboxDeGeometrie } from "../../../lib/projetsVoirieConflits";
import type { ObjetEchantillon } from "../../../lib/projetsVoirieImport";

/**
 * Apercu cartographique de l'ECHANTILLON de l'assistant (au plus 20 objets, borne par le serveur) : jamais le fichier entier, jamais un jeu enregistre.
 * L'aperçu est une aide visuelle COMPLEMENTAIRE du tableau, qui donne les memes objets au clavier et aux lecteurs d'ecran.
 *
 * AUCUN HTML D'UN FICHIER : l'infobulle est un element construit avec `textContent`. Aucune popup Leaflet. Rien n'est stocke localement.
 * Les traces ne sont pas des arrets de tabulation (`ElementsCarteHorsTabulation`) : la voie clavier est le bouton « Voir sur la carte » du tableau.
 */

const CENTRE_GUINEE: [number, number] = [10.5, -10.8];
const COULEUR_ECHANTILLON = "#0b2545";
const COULEUR_PROBLEME = "#b91c1c";
const COULEUR_SELECTION = "#f5a623";

function infobulle(texte: string): HTMLElement {
  const el = document.createElement("span");
  el.textContent = texte;
  return el;
}

function Cadrage({ objets, cle }: { objets: readonly ObjetEchantillon[]; cle: string }) {
  const map = useMap();
  const emprise = useMemo(() => {
    let b: [number, number, number, number] | null = null;
    for (const o of objets) {
      const e = bboxDeGeometrie(o.geometrie);
      if (e) b = b ? [Math.min(b[0], e[0]), Math.min(b[1], e[1]), Math.max(b[2], e[2]), Math.max(b[3], e[3])] : e;
    }
    return b;
  }, [objets]);
  useEffect(() => {
    const c = map.getContainer?.();
    if (c) { c.setAttribute("role", "region"); c.setAttribute("aria-label", "Carte de l'échantillon du fichier"); }
  }, [map]);
  useEffect(() => {
    if (emprise) map.fitBounds([[emprise[1], emprise[0]], [emprise[3], emprise[2]]], { padding: [24, 24], maxZoom: 18 });
  }, [map, cle]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export function ApercuCarte({ objets, selection, problemes, onSelect }: {
  objets: readonly ObjetEchantillon[]; selection: number | null; problemes: ReadonlySet<number>; onSelect: (ordre: number) => void;
}) {
  const collection = useMemo<FeatureCollection>(() => ({
    type: "FeatureCollection",
    features: objets.map((o): Feature<Geometry> => ({ type: "Feature", geometry: o.geometrie, properties: { ordre: o.ordre, nom: o.nom } })),
  }), [objets]);
  const choisi = useMemo(() => objets.find((o) => o.ordre === selection) ?? null, [objets, selection]);
  const cle = objets.map((o) => o.ordre).join(",");
  const f = FONDS.osm;
  return (
    <MapContainer center={CENTRE_GUINEE} zoom={7} zoomControl={false} preferCanvas maxZoom={ZOOM_MAX} className="h-full w-full" scrollWheelZoom>
      <TileLayer url={f.url} attribution={f.attribution} maxNativeZoom={f.maxNativeZoom} maxZoom={ZOOM_MAX} />
      <ZoomControl position="bottomleft" />
      <ScaleControl position="bottomright" metric imperial={false} />
      <ElementsCarteHorsTabulation />
      <Cadrage objets={objets} cle={cle} />
      <GeoJSON
        key={`echantillon-${cle}`}
        data={collection}
        style={(feat) => {
          const probleme = problemes.has(Number((feat?.properties as { ordre?: number } | undefined)?.ordre));
          return { color: probleme ? COULEUR_PROBLEME : COULEUR_ECHANTILLON, weight: 3, opacity: 0.95, dashArray: probleme ? "6 4" : undefined, fill: false };
        }}
        pointToLayer={(feat, latlng) => L.circleMarker(latlng, { radius: 5, color: "#ffffff", weight: 1.5, fillColor: problemes.has(Number((feat.properties as { ordre?: number }).ordre)) ? COULEUR_PROBLEME : COULEUR_ECHANTILLON, fillOpacity: 1 })}
        onEachFeature={(feat, layer) => {
          const p = feat.properties as { ordre: number; nom: string | null };
          layer.on("click", () => onSelect(p.ordre));
          layer.bindTooltip(infobulle(`${p.nom ?? "Objet sans nom"} (n° ${p.ordre + 1})`), { sticky: true });
        }}
      />
      {choisi && (
        <GeoJSON
          key={`selection-${choisi.ordre}`}
          data={{ type: "Feature", geometry: choisi.geometrie, properties: {} } as Feature<Geometry>}
          interactive={false}
          style={() => ({ color: COULEUR_SELECTION, weight: 9, opacity: 0.85, fill: false })}
          pointToLayer={(_f, latlng) => L.circleMarker(latlng, { radius: 10, color: COULEUR_SELECTION, weight: 3, fillColor: "#ffffff", fillOpacity: 0.6, interactive: false })}
        />
      )}
    </MapContainer>
  );
}
