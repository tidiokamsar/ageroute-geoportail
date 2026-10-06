import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import axios from "axios";
import { ETAT_COLORS, CHANTIER_COLORS } from "./geoportail/types";
import { ouvrageIcon, TYPE_OUVRAGE_LABEL } from "./geoportail/symbols";
import type { PublicOuvrage } from "./public/types";
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
  ouvrages?: PublicOuvrage[];
}

export interface EmbedParametres {
  /** `couches=ouvrages` : ouvrages seuls ; `couches=troncons` : reseau seul. */
  couches: "ouvrages" | "troncons" | null;
  /** `ouvrage=<id>` : centrage et etiquette sur un ouvrage (ID SIG). */
  ouvrage: string | null;
  /** `troncon=<id>` : centrage et surbrillance d'un troncon (ID SIG). */
  troncon: string | null;
  /** `etat=CRITIQUE,MAUVAIS` : troncons dans ces etats seulement. */
  etats: string[];
  /** `region=<nom>` : troncons, chantiers et points noirs de cette region (nom exact de l'API). */
  region: string | null;
}

/**
 * Parametres de l'URL d'embed, lus une fois au chargement. Tous facultatifs et cumulables ;
 * SANS parametre, la carte reste celle de tous les portails : reseau, chantiers et points
 * noirs, sans ouvrages.
 * - `couches=ouvrages` (DigitalRoad DOA&A) : les ouvrages d'art seuls ;
 * - `couches=troncons` (DigitalRoad Maintenance) : le reseau seul, colore par etat ;
 * - `ouvrage=<id>` / `troncon=<id>` : centrer sur l'objet lie par son ID SIG ;
 * - `etat=` : etats de troncon a garder (BON, MOYEN, MAUVAIS, CRITIQUE, NON_EVALUE) ;
 *   le troncon cible reste affiche quel que soit son etat ;
 * - `region=` : restreindre a une region.
 */
export function lireParametres(search: string): EmbedParametres {
  const q = new URLSearchParams(search);
  const c = q.get("couches");
  return {
    couches: c === "ouvrages" || c === "troncons" ? c : null,
    ouvrage: q.get("ouvrage"),
    troncon: q.get("troncon"),
    etats: (q.get("etat") ?? "").split(",").map((e) => e.trim().toUpperCase()).filter(Boolean),
    region: q.get("region")?.trim() || null,
  };
}

function CentrerSur({ position, limites }: { position: [number, number] | null; limites: [number, number][] | null }) {
  const map = useMap();
  useEffect(() => {
    if (position) map.setView(position, 15);
    else if (limites && limites.length) map.fitBounds(L.latLngBounds(limites), { padding: [30, 30], maxZoom: 15 });
  }, [map, position, limites]);
  return null;
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
 * la carte, destinée à être embarquée (iframe) dans l'intranet SharePoint. Lit
 * /api/public/carte/geo (données volontairement réduites, cf. backend/src/modules/public).
 * La carte interactive complète (recherche, mesures, dessin, fiches détaillées) reste
 * réservée aux utilisateurs connectés sur /geoportail.
 */
export function EmbedCartePage() {
  const params = useMemo(() => lireParametres(window.location.search), []);
  // Un troncon cible se regarde de pres : traces moins simplifies (palier du zoom 13).
  const zoom = params.troncon ? 13 : undefined;
  const { data } = useQuery({
    queryKey: ["public", "carte", "geo", zoom ?? "pays"],
    queryFn: async () => (await axios.get<PublicCarteData>("/api/public/carte/geo", { params: zoom ? { zoom } : undefined })).data,
  });

  const voirReseau = params.couches !== "ouvrages";
  const voirChantiers = params.couches === null;
  const voirOuvrages = params.couches === "ouvrages" || !!params.ouvrage;

  const focus = useMemo<[number, number] | null>(() => {
    const o = (data?.ouvrages ?? []).find((x) => x.id === params.ouvrage);
    return o ? [o.lat, o.lon] : null;
  }, [data, params]);

  const tronconLines = useMemo(
    () =>
      (data?.troncons ?? [])
        .filter((t) => (!params.region || t.region === params.region)
          && (!params.etats.length || params.etats.includes(t.etat) || t.id === params.troncon))
        .map((t) => ({ t, positions: geoJsonToLatLngs(t.geometry) }))
        .filter((x) => x.positions.length > 0),
    [data, params]
  );
  const cible = useMemo(() => tronconLines.find((x) => x.t.id === params.troncon) ?? null, [tronconLines, params]);
  const chantierLines = useMemo(
    () =>
      (data?.chantiers ?? [])
        .filter((c) => !c.approximate && (!params.region || c.region === params.region))
        .map((c) => ({ c, positions: geoJsonToLatLngs(c.geometry) }))
        .filter((x) => x.positions.length > 0),
    [data, params]
  );
  const dansRegion = (r: string | null): boolean => !params.region || r === params.region;

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <MapContainer center={GUINEE_CENTER} zoom={7} zoomControl={false} attributionControl={false} style={{ height: "100%", width: "100%" }}>
        {/* Esri Dark Gray et non le fond sombre CARTO : basemaps.cartocdn.com renvoie
            desormais une tuile filigranee "API KEY REQUIRED" (en HTTP 200). */}
        <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}" />
        <CentrerSur position={focus} limites={focus ? null : cible ? cible.positions : null} />
        {voirReseau && tronconLines.map(({ t, positions }) => (
          <Polyline key={t.id} positions={positions} pathOptions={{ color: ETAT_COLORS[t.etat] ?? "#8FA9C8", weight: t.id === params.troncon ? 7 : 3 }}>
            <Tooltip sticky>{t.code} — {t.nom}</Tooltip>
          </Polyline>
        ))}
        {/* Surbrillance : un liseré blanc au-dessus du tracé cible, lisible quel que soit son état. */}
        {voirReseau && cible && (
          <Polyline positions={cible.positions} pathOptions={{ color: "#ffffff", weight: 2, dashArray: "6 6" }} interactive={false} />
        )}
        {voirChantiers && chantierLines.map(({ c, positions }) => (
          <Polyline key={c.id} positions={positions} pathOptions={{ color: CHANTIER_COLORS[c.statut], weight: 5, dashArray: "5 5" }}>
            <Tooltip sticky>Chantier — {c.statut} ({c.avancementPct}%)</Tooltip>
          </Polyline>
        ))}
        {voirChantiers && (data?.chantiers ?? [])
          .filter((c) => c.approximate && c.lat != null && c.lon != null && dansRegion(c.region))
          .map((c) => (
            <CircleMarker key={c.id} center={[c.lat as number, c.lon as number]} radius={6} pathOptions={{ color: "#fff", weight: 1, fillColor: CHANTIER_COLORS[c.statut], fillOpacity: 0.9 }}>
              <Tooltip>Chantier — {c.statut}</Tooltip>
            </CircleMarker>
          ))}
        {voirChantiers && (data?.pointsNoirs ?? []).filter((p) => dansRegion(p.region)).map((p) => (
          <CircleMarker key={p.id} center={[p.lat, p.lon]} radius={5} pathOptions={{ color: "#fff", weight: 1, fillColor: "#dc2626", fillOpacity: 0.9 }}>
            <Tooltip>Point noir — {p.gravite}</Tooltip>
          </CircleMarker>
        ))}
        {voirOuvrages && (data?.ouvrages ?? []).map((o) => (
          <Marker key={o.id} position={[o.lat, o.lon]} icon={ouvrageIcon(o.type, o.etat, o.aValider === true)}>
            <Tooltip permanent={o.id === params.ouvrage}>
              {TYPE_OUVRAGE_LABEL[o.type] ?? o.type} — {o.code ?? o.nom}
              {o.aValider ? " (à valider)" : ""}
            </Tooltip>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
