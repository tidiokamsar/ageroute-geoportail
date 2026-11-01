import { memo, useEffect } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import { latLngBounds } from "leaflet";
// Feuille de style de Leaflet servie par l'application elle-meme (precachee par le service worker) : la carte garde sa mise en forme hors ligne.
import "leaflet/dist/leaflet.css";
import type { MarqueurCarte, PointCarte } from "../../lib/roulageEnvoyesVue";

/**
 * Carte d'un releve envoye : la trace telle que le SERVEUR l'a gardee, et les reperes poses pendant le trajet.
 *
 * UNE POLYLIGNE PAR LIGNE DE LA GEOMETRIE : deux lignes ne sont jamais reliees, un trou de signal reste un trou a l'ecran.
 * Un repere dont la position est perimee est dessine en pointille (la couleur n'est jamais le seul signal) : sa position est
 * celle du dernier point GPS connu, pas celle de l'endroit ou il a ete pose. La liste sous la carte porte les memes
 * informations en texte, et c'est elle qu'un lecteur d'ecran lit.
 *
 * Aucune donnee n'est creee ici : sans ligne ni repere, la carte reste centree sur la Guinee et ne dessine rien.
 */

interface Props {
  lignes: readonly (readonly PointCarte[])[];
  marqueurs: readonly MarqueurCarte[];
}

const CONAKRY: PointCarte = [9.64, -13.6];

function Cadrage({ lignes, marqueurs }: Props) {
  const carte = useMap();
  useEffect(() => {
    const points: PointCarte[] = [...lignes.flat() as PointCarte[], ...marqueurs.map((m) => m.position)];
    if (points.length === 0) return;
    carte.fitBounds(latLngBounds(points), { padding: [24, 24], maxZoom: 17 });
  }, [carte, lignes, marqueurs]);
  return null;
}

function CarteReleveEnvoyeBase({ lignes, marqueurs }: Props) {
  return (
    <div className="space-y-2">
      <div
        role="region"
        aria-label={`Carte du relevé : ${lignes.length} ligne(s) de trace, ${marqueurs.length} repère(s) placé(s)`}
        className="h-72 w-full overflow-hidden rounded-lg border border-gray-300 sm:h-96"
      >
        <MapContainer center={CONAKRY} zoom={7} scrollWheelZoom keyboard style={{ height: "100%", width: "100%" }}>
          <TileLayer
            attribution='&copy; les contributeurs <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={20}
            maxNativeZoom={19}
          />
          {lignes.map((l, i) => (
            <Polyline key={i} positions={l as PointCarte[]} pathOptions={{ color: "#1d4ed8", weight: 5, opacity: 0.9 }} />
          ))}
          {marqueurs.map((m) => (
            <CircleMarker
              key={m.marqueur.id}
              center={m.position}
              radius={8}
              pathOptions={m.approximative
                ? { color: "#b45309", weight: 3, dashArray: "3 3", fillColor: "#ffffff", fillOpacity: 0.9 }
                : { color: "#ffffff", weight: 2, fillColor: "#dc2626", fillOpacity: 1 }}
            >
              <Tooltip>{m.etiquette}{m.approximative ? " (position périmée)" : ""}</Tooltip>
            </CircleMarker>
          ))}
          <Cadrage lignes={lignes} marqueurs={marqueurs} />
        </MapContainer>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-700" aria-label="Légende de la carte">
        <li><span className="mr-1 inline-block h-0.5 w-5 bg-[#1d4ed8] align-middle" aria-hidden="true" />Trace enregistrée</li>
        <li><span className="mr-1 inline-block h-3 w-3 rounded-full border-2 border-white bg-[#dc2626] align-middle shadow-[0_0_0_1px_#6b7280]" aria-hidden="true" />Repère</li>
        <li><span className="mr-1 inline-block h-3 w-3 rounded-full border-2 border-dashed border-[#b45309] bg-white align-middle" aria-hidden="true" />Repère à position périmée (approximative)</li>
      </ul>
    </div>
  );
}

export const CarteReleveEnvoye = memo(CarteReleveEnvoyeBase);
