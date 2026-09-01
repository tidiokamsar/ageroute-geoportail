import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip } from "react-leaflet";
import axios from "axios";
import { ETAT_COLORS, CHANTIER_COLORS } from "./geoportail/types";
import type { EtatPatrimoine, StatutChantier } from "../types";

const GUINEE_CENTER: [number, number] = [10.5, -10.8];

interface PublicTroncon {
  id: string; code: string; nom: string; classe: string; etat: EtatPatrimoine;
  longueurKm: number; region: string | null; geometry: string | null;
}
interface PublicPointNoir { id: string; gravite: string; region: string | null; lat: number; lon: number }
interface PublicChantier {
  id: string; statut: StatutChantier; avancementPct: number; region: string | null;
  geometry: string | null; approximate: boolean; lat: number | null; lon: number | null;
}
interface PublicCarteData {
  troncons: PublicTroncon[];
  pointsNoirs: PublicPointNoir[];
  chantiers: PublicChantier[];
}

function geoJsonToLatLngs(geometry: string | null): [number, number][] {
  if (!geometry) return [];
  try {
    const g = JSON.parse(geometry) as { type: string; coordinates: number[][] };
    if (g.type !== "LineString") return [];
    return g.coordinates.map(([lon, lat]) => [lat, lon]);
  } catch {
    return [];
  }
}

/**
 * Page d'aperçu PUBLIQUE, sans authentification ni chrome applicatif — juste
 * la carte, destinée à être embarquée (iframe) dans la mini-carte "Carte SIG
 * routier" de l'intranet SharePoint. Lit /api/public/carte/geo (données
 * volontairement réduites, cf. backend/src/modules/public). La carte
 * interactive complète (recherche, mesures, dessin, fiches détaillées) reste
 * réservée aux utilisateurs connectés sur /geoportail.
 */
export function EmbedCartePage() {
  const { data } = useQuery({
    queryKey: ["public", "carte", "geo"],
    queryFn: async () => (await axios.get<PublicCarteData>("/api/public/carte/geo")).data,
  });

  const tronconLines = useMemo(
    () =>
      (data?.troncons ?? [])
        .map((t) => ({ t, positions: geoJsonToLatLngs(t.geometry) }))
        .filter((x) => x.positions.length > 0),
    [data]
  );
  const chantierLines = useMemo(
    () =>
      (data?.chantiers ?? [])
        .filter((c) => !c.approximate)
        .map((c) => ({ c, positions: geoJsonToLatLngs(c.geometry) }))
        .filter((x) => x.positions.length > 0),
    [data]
  );

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <MapContainer center={GUINEE_CENTER} zoom={7} zoomControl={false} attributionControl={false} style={{ height: "100%", width: "100%" }}>
        {/* Esri Dark Gray et non le fond sombre CARTO : basemaps.cartocdn.com renvoie
            desormais une tuile filigranee "API KEY REQUIRED" (en HTTP 200). */}
        <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}" />
        {tronconLines.map(({ t, positions }) => (
          <Polyline key={t.id} positions={positions} pathOptions={{ color: ETAT_COLORS[t.etat] ?? "#8FA9C8", weight: 3 }}>
            <Tooltip sticky>{t.code} — {t.nom}</Tooltip>
          </Polyline>
        ))}
        {chantierLines.map(({ c, positions }) => (
          <Polyline key={c.id} positions={positions} pathOptions={{ color: CHANTIER_COLORS[c.statut], weight: 5, dashArray: "5 5" }}>
            <Tooltip sticky>Chantier — {c.statut} ({c.avancementPct}%)</Tooltip>
          </Polyline>
        ))}
        {(data?.chantiers ?? [])
          .filter((c) => c.approximate && c.lat != null && c.lon != null)
          .map((c) => (
            <CircleMarker key={c.id} center={[c.lat as number, c.lon as number]} radius={6} pathOptions={{ color: "#fff", weight: 1, fillColor: CHANTIER_COLORS[c.statut], fillOpacity: 0.9 }}>
              <Tooltip>Chantier — {c.statut}</Tooltip>
            </CircleMarker>
          ))}
        {(data?.pointsNoirs ?? []).map((p) => (
          <CircleMarker key={p.id} center={[p.lat, p.lon]} radius={5} pathOptions={{ color: "#fff", weight: 1, fillColor: "#dc2626", fillOpacity: 0.9 }}>
            <Tooltip>Point noir — {p.gravite}</Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
