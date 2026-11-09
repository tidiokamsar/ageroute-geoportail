import { useEffect, useMemo, useState } from "react";
import { GeoJSON, MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { Feature, Geometry } from "geojson";
import { FONDS } from "../../decision/carte/fonds";
import { rectangleDepuisCoins, rectangleVersEmprise, type EmpriseGeoJson } from "../../../lib/projetsVoirieTerritoires";
import type { Bbox } from "../../../lib/projetsVoirie";

/**
 * Dessin SIMPLE d'une emprise approximative : deux clics (un coin, puis le coin oppose) donnent un rectangle WGS 84. L'emprise actuelle (fiche) et
 * celle du parent sont affichees en repere. Aucune donnee n'est envoyee d'ici : le rectangle remonte au formulaire, qui l'envoie a l'enregistrement.
 * La voie clavier equivalente est la saisie des quatre bornes ou du GeoJSON (formulaire). Aucun nom de lieu : la vue part de l'emprise connue,
 * sinon de l'emprise nationale configuree, sinon d'une vue du monde.
 */

const STYLE_ACTUELLE = { color: "#374151", weight: 2, dashArray: "6 4", fillOpacity: 0.05 };
const STYLE_PARENT = { color: "#6b7280", weight: 1, dashArray: "2 4", fillOpacity: 0 };
const STYLE_DESSIN = { color: "#0b2545", weight: 3, fillOpacity: 0.12 };

function feature(g: EmpriseGeoJson | null): Feature<Geometry> | null {
  return g ? { type: "Feature", properties: {}, geometry: g as Geometry } : null;
}

function Cadrage({ bbox }: { bbox: Bbox | null }) {
  const map = useMap();
  useEffect(() => {
    if (bbox) map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], { maxZoom: 14 });
  }, [map, bbox]);
  return null;
}

function Clics({ onCoin }: { onCoin: (p: { lat: number; lng: number }) => void }) {
  useMapEvents({ click: (e: { latlng: { lat: number; lng: number } }) => onCoin(e.latlng) });
  return null;
}

export function CarteEmprise({ actuelle, parent, cadrage, dessin, onDessin }: {
  actuelle: EmpriseGeoJson | null; parent: Bbox | null; cadrage: Bbox | null; dessin: Bbox | null; onDessin: (b: Bbox) => void;
}) {
  const [premier, setPremier] = useState<{ lat: number; lng: number } | null>(null);
  const fActuelle = useMemo(() => feature(actuelle), [actuelle]);
  const fParent = useMemo(() => (parent ? feature(rectangleVersEmprise(parent)) : null), [parent]);
  const fDessin = useMemo(() => (dessin ? feature(rectangleVersEmprise(dessin)) : null), [dessin]);
  const fond = FONDS.clair;

  function surCoin(p: { lat: number; lng: number }) {
    if (!premier) { setPremier(p); return; }
    onDessin(rectangleDepuisCoins(premier, p));
    setPremier(null);
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-gray-800" aria-live="polite">
        {premier ? "Premier coin posé : cliquez le coin opposé du rectangle." : dessin ? "Rectangle dessiné. Cliquez deux nouveaux coins pour le remplacer." : "Cliquez un premier coin de l'emprise sur la carte, puis le coin opposé."}
      </p>
      <div className="relative isolate z-0 h-72 overflow-hidden rounded border border-gray-300" data-testid="carte-emprise">
        <MapContainer center={[0, 0]} zoom={2} className="h-full w-full" attributionControl>
          <TileLayer url={fond.url} attribution={fond.attribution} maxNativeZoom={fond.maxNativeZoom} />
          <Cadrage bbox={dessin ?? cadrage} />
          <Clics onCoin={surCoin} />
          {fParent && <GeoJSON key={`p-${parent?.join(",")}`} data={fParent} style={() => STYLE_PARENT} interactive={false} />}
          {fActuelle && <GeoJSON key="actuelle" data={fActuelle} style={() => STYLE_ACTUELLE} interactive={false} />}
          {fDessin && <GeoJSON key={`d-${dessin?.join(",")}`} data={fDessin} style={() => STYLE_DESSIN} interactive={false} />}
        </MapContainer>
      </div>
      <ul className="flex flex-wrap gap-x-4 text-xs text-gray-800" aria-label="Légende de la carte d'emprise">
        {fDessin && <li>Rectangle dessiné : trait bleu nuit plein</li>}
        {fActuelle && <li>Emprise actuelle : trait gris en tirets</li>}
        {fParent && <li>Emprise du parent : trait gris pointillé</li>}
      </ul>
    </div>
  );
}
