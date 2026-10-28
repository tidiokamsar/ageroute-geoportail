import { useEffect } from "react";
import { MapContainer, TileLayer, Polyline, GeoJSON, Tooltip, useMap } from "react-leaflet";
// Feuille de style de Leaflet servie par l'application elle-meme (precachee par le service worker) : plus de CDN tiers, la carte garde sa mise en forme hors ligne.
import "leaflet/dist/leaflet.css";
import { latLngBounds } from "leaflet";
import { decouperEnFragments, type AnalyseTrace } from "../lib/releve";

/**
 * Carte du resultat d'analyse d'une trace : le parcours rattache au reseau en bleu, la partie que le
 * reseau n'explique pas en rouge pointille, et la portion de chaque troncon parcouru en vert.
 *
 * La couleur n'est jamais le seul signal : la legende et le tableau sous la carte portent la meme
 * information en texte.
 */

function Cadrage({ trace }: { trace: [number, number][] }) {
  const carte = useMap();
  useEffect(() => {
    if (trace.length === 0) return;
    carte.fitBounds(latLngBounds(trace.map(([lon, lat]) => [lat, lon] as [number, number])), { padding: [24, 24], maxZoom: 17 });
  }, [carte, trace]);
  return null;
}

export function CarteReleve({ analyse }: { analyse: AnalyseTrace }) {
  const fragments = decouperEnFragments(analyse.trace, analyse.rattache);
  const premier = analyse.trace[0];
  return (
    <div className="space-y-2">
      <div
        role="img"
        aria-label={`Carte du parcours analyse : ${analyse.passages.length} passage(s) sur le reseau, ${analyse.horsReferentiel.length} suite(s) hors referentiel`}
        className="h-[420px] overflow-hidden rounded-lg border border-border"
      >
        <MapContainer
          center={premier ? [premier[1], premier[0]] : [9.6, -13.6]}
          zoom={12}
          style={{ height: "100%", width: "100%" }}
          keyboard
        >
          <TileLayer
            attribution='&copy; les contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={20}
            maxNativeZoom={19}
          />
          <Cadrage trace={analyse.trace} />
          {analyse.passages.filter((p) => p.geojson).map((p) => (
            <GeoJSON key={`${p.tronconId}-${p.indexDebut}`} data={p.geojson as never} style={{ color: "#15803d", weight: 8, opacity: 0.45 }}>
              <Tooltip sticky>{p.code}{p.nom ? ` - ${p.nom}` : ""}</Tooltip>
            </GeoJSON>
          ))}
          {fragments.map((f, i) => (
            <Polyline
              key={i}
              positions={f.points}
              pathOptions={f.rattache ? { color: "#1d4ed8", weight: 3 } : { color: "#dc2626", weight: 4, dashArray: "6 6" }}
            />
          ))}
        </MapContainer>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legende de la carte">
        <li><span className="mr-1 inline-block h-0.5 w-5 bg-[#1d4ed8] align-middle" aria-hidden="true" />Parcours rattache au reseau</li>
        <li><span className="mr-1 inline-block h-0.5 w-5 border-t-2 border-dashed border-[#dc2626] align-middle" aria-hidden="true" />Parcours hors referentiel</li>
        <li><span className="mr-1 inline-block h-2 w-5 bg-[#15803d] opacity-45 align-middle" aria-hidden="true" />Portion du troncon parcourue</li>
      </ul>
    </div>
  );
}
