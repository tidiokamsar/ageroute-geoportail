import { memo, useEffect } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from "react-leaflet";
// Feuille de style de Leaflet servie par l'application elle-meme (precachee par le service worker) : plus de CDN tiers, la carte garde sa mise en forme hors ligne.
import "leaflet/dist/leaflet.css";
import type { PointCarte } from "../lib/releveVue";

/**
 * Carte de l'enregistrement en roulant : la position actuelle et la trace deja collectee.
 *
 * UNE POLYLIGNE PAR SEGMENT : deux segments ne sont jamais relies, un trou de signal reste un trou a l'ecran.
 * La carte est memoisee et ne se redessine que si la trace ou la position changent ; le recentrage suit la position
 * tant que `suivre` est vrai (l'agent le coupe pour explorer la carte).
 */

interface Props {
  segments: readonly (readonly PointCarte[])[];
  position: PointCarte | null;
  /** Precision annoncee, en metres, ou `null`. Dessinee en cercle, jamais inventee. */
  precisionM: number | null;
  suivre: boolean;
}

const CONAKRY: PointCarte = [9.64, -13.6];

function Recentrage({ position, suivre }: { position: PointCarte | null; suivre: boolean }) {
  const carte = useMap();
  const lat = position?.[0];
  const lon = position?.[1];
  useEffect(() => {
    if (suivre && lat !== undefined && lon !== undefined) carte.setView([lat, lon], Math.max(carte.getZoom(), 16), { animate: false });
  }, [carte, suivre, lat, lon]);
  return null;
}

function CarteTraceRoulageBase({ segments, position, precisionM, suivre }: Props) {
  return (
    <div className="h-64 w-full overflow-hidden rounded-lg border border-gray-300 sm:h-80" role="img" aria-label="Carte de la position actuelle et de la trace enregistrée">
      <MapContainer center={position ?? CONAKRY} zoom={position ? 16 : 7} scrollWheelZoom className="h-full w-full">
        <TileLayer
          attribution='&copy; les contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={20}
          maxNativeZoom={19}
        />
        {segments.filter((s) => s.length >= 2).map((s, i) => (
          <Polyline key={i} positions={s as PointCarte[]} pathOptions={{ color: "#1d4ed8", weight: 5, opacity: 0.9 }} />
        ))}
        {position && (
          <>
            {precisionM !== null && precisionM > 0 && <CircleMarker center={position} radius={Math.min(40, Math.max(6, precisionM / 2))} pathOptions={{ color: "#1d4ed8", weight: 1, fillOpacity: 0.1 }} />}
            <CircleMarker center={position} radius={7} pathOptions={{ color: "#ffffff", weight: 2, fillColor: "#dc2626", fillOpacity: 1 }} />
          </>
        )}
        <Recentrage position={position} suivre={suivre} />
      </MapContainer>
    </div>
  );
}

export const CarteTraceRoulage = memo(CarteTraceRoulageBase);
