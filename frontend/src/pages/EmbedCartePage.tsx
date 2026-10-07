import { useEffect, useMemo, useState } from "react";
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

export type Couche = "troncons" | "ouvrages" | "chantiers" | "franchissements";

export interface EmbedParametres {
  /**
   * Couches demandees (`couches=troncons,ouvrages`). Vide : la carte historique des portails
   * (reseau, chantiers et points noirs). `ouvrages` seul et `troncons` seul gardent leur sens.
   */
  couches: Couche[];
  /** `ouvrage=<id>` : centrage et etiquette sur un ouvrage (ID SIG). */
  ouvrage: string | null;
  /** `troncon=<id>` : centrage et surbrillance d'un troncon (ID SIG). */
  troncon: string | null;
  /** `etat=CRITIQUE,MAUVAIS` : troncons dans ces etats seulement. */
  etats: string[];
  /** `region=<nom>` : troncons, chantiers et points noirs de cette region (nom exact de l'API). */
  region: string | null;
  /** `fond=satellite` : imagerie aerienne ; sinon le fond sombre. */
  fond: "sombre" | "satellite";
  /** `chantiers=precis` : chantiers localises precisement seulement (positions approchees masquees). */
  chantiersPrecis: boolean;
}

/**
 * Parametres de l'URL d'embed, lus une fois au chargement. Tous facultatifs et cumulables ;
 * SANS parametre, la carte reste celle de tous les portails : reseau, chantiers et points
 * noirs, sans ouvrages.
 */
export function lireParametres(search: string): EmbedParametres {
  const q = new URLSearchParams(search);
  const couches = (q.get("couches") ?? "").split(",").map((c) => c.trim().toLowerCase())
    .filter((c): c is Couche => c === "troncons" || c === "ouvrages" || c === "chantiers" || c === "franchissements");
  return {
    couches: Array.from(new Set(couches)),
    ouvrage: q.get("ouvrage"),
    troncon: q.get("troncon"),
    etats: (q.get("etat") ?? "").split(",").map((e) => e.trim().toUpperCase()).filter(Boolean),
    region: q.get("region")?.trim() || null,
    fond: q.get("fond") === "satellite" ? "satellite" : "sombre",
    chantiersPrecis: q.get("chantiers") === "precis",
  };
}

/**
 * Pages autorisees a piloter la carte par message (filtre et couleurs des ouvrages) et a en recevoir
 * les clics : l'intranet AGEROUTE seulement. Les donnees echangees sont des identifiants publics et des
 * etats ; le controle d'origine evite qu'un site tiers qui embarquerait la carte la detourne.
 */
export const ORIGINES_PILOTES = ["https://ageroutegn.sharepoint.com"];
export const originePilote = (o: string): boolean => ORIGINES_PILOTES.includes(o) || /^https:\/\/[a-z0-9-]+\.ageroute\.gov\.gn$/.test(o);

/** Ouvrage tel que la page hote le decrit : l'etat et la marque viennent de DigitalRoad (maitre du metier). */
/** `valide` : fiche validee par la DOA&A dans DigitalRoad (la carte cesse de la marquer « a valider »). */
export interface OuvragePilote { id: string; etat?: string; marque?: "travaux" | "urgence"; valide?: boolean }
/** Messages recus : la liste des ouvrages a montrer (les autres sont masques). */
export function lireMessage(data: unknown): OuvragePilote[] | null {
  if (!data || typeof data !== "object") return null;
  const m = data as { type?: unknown; items?: unknown };
  if (m.type !== "agr-ouvrages" || !Array.isArray(m.items)) return null;
  return m.items
    .filter((x): x is OuvragePilote => !!x && typeof (x as OuvragePilote).id === "string")
    .map((x) => ({ id: x.id.toLowerCase(), etat: typeof x.etat === "string" ? x.etat.toUpperCase() : undefined, marque: x.marque === "travaux" || x.marque === "urgence" ? x.marque : undefined, ...(x.valide === true ? { valide: true } : {}) }));
}

/** Route demandee par la page hote (`route: "RN2"`), normalisee ; null si absente. */
export function lireRoute(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const r = (data as { route?: unknown }).route;
  return typeof r === "string" && r.trim() ? r.trim().toUpperCase().replace(/\s+/g, "") : null;
}
/** Les franchissements notent la route « N2 » ; le reseau AGEROUTE « RN2 ». */
export const memeRoute = (numero: string, route: string): boolean => {
  const n = numero.trim().toUpperCase().replace(/\s+/g, "");
  return !!n && (n === route || `R${n}` === route);
};

/**
 * Cle d'un franchissement partagee avec DigitalRoad (liste DOA_FRANCHISSEMENTS) : le point milieu du trace,
 * « lat,lon » a 5 decimales. Le fichier OSM n'a pas d'identifiant stable ; la position, elle, ne bouge pas.
 */
export const cleFranchissement = (lat: number, lon: number): string => `${lat.toFixed(5)},${lon.toFixed(5)}`;

/** Instruction d'un franchissement par la DOA&A, tenue dans DigitalRoad. */
export type StatutFranchissement = "À instruire" | "Ouvrage confirmé" | "Pas d'ouvrage" | "Doublon";
const STATUTS_FRANCHISSEMENT: StatutFranchissement[] = ["À instruire", "Ouvrage confirmé", "Pas d'ouvrage", "Doublon"];
/** Message `agr-franchissements` de la page hote : statut d'instruction par cle ; null pour tout autre message. */
export function lireStatutsFranchissements(data: unknown): Map<string, StatutFranchissement> | null {
  if (!data || typeof data !== "object") return null;
  const m = data as { type?: unknown; items?: unknown };
  if (m.type !== "agr-franchissements" || !Array.isArray(m.items)) return null;
  const r = new Map<string, StatutFranchissement>();
  for (const x of m.items as Array<{ cle?: unknown; statut?: unknown }>) {
    if (x && typeof x.cle === "string" && STATUTS_FRANCHISSEMENT.includes(x.statut as StatutFranchissement)) r.set(x.cle, x.statut as StatutFranchissement);
  }
  return r;
}
/** Rouge : a instruire (aucun ouvrage connu) ; vert : ouvrage AGEROUTE proche ; bleu : confirme ; gris : ecarte. */
export function couleurFranchissement(classement: string, statut?: StatutFranchissement): string {
  if (statut === "Ouvrage confirmé") return "#2563eb";
  if (statut === "Pas d'ouvrage" || statut === "Doublon") return "#9ca3af";
  return classement === "PONT_SANS_OUVRAGE" ? "#dc2626" : "#16a34a";
}

interface Franchissement { id: number; cle: string; lat: number; lon: number; nature: string; numero: string; nom: string; classement: string; region: string }
async function chargerFranchissements(): Promise<Franchissement[]> {
  const g = (await axios.get<{ features: Array<{ geometry: { type: string; coordinates: number[][] }; properties: Record<string, unknown> }> }>("/data/ponts-osm.geojson")).data;
  return (g.features ?? []).map((f, i) => {
    const c = f.geometry?.coordinates ?? []; const m = c[Math.floor(c.length / 2)] ?? [0, 0];
    const p = f.properties ?? {};
    return { id: i, cle: cleFranchissement(m[1], m[0]), lat: m[1], lon: m[0], nature: String(p.franchissement ?? ""), numero: String(p.numero ?? ""), nom: String(p.nom ?? ""), classement: String(p.classement ?? ""), region: String(p.region ?? "") };
  }).filter((f) => f.lat && f.lon);
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

/** Origine de la page hote si elle est autorisee (les clics ne partent que vers elle). */
function origineHote(): string | null {
  try {
    const o = document.referrer ? new URL(document.referrer).origin : "";
    return window.parent !== window && originePilote(o) ? o : null;
  } catch {
    return null;
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
  const hote = useMemo(origineHote, []);
  const [pilotes, setPilotes] = useState<OuvragePilote[] | null>(null);
  const [route, setRoute] = useState<string | null>(null);
  const [statutsFr, setStatutsFr] = useState<Map<string, StatutFranchissement>>(() => new Map());
  // Un troncon cible se regarde de pres : traces moins simplifies (palier du zoom 13).
  const zoom = params.troncon ? 13 : undefined;
  const { data } = useQuery({
    queryKey: ["public", "carte", "geo", zoom ?? "pays"],
    queryFn: async () => (await axios.get<PublicCarteData>("/api/public/carte/geo", { params: zoom ? { zoom } : undefined })).data,
  });

  // Pilotage par la page hote : elle annonce les ouvrages a montrer et leur etat metier.
  useEffect(() => {
    const ecoute = (e: MessageEvent) => { if (!originePilote(e.origin)) return; const items = lireMessage(e.data); if (items) { setPilotes(items); setRoute(lireRoute(e.data)); } const fr = lireStatutsFranchissements(e.data); if (fr) setStatutsFr(fr); };
    window.addEventListener("message", ecoute);
    if (hote) window.parent.postMessage({ type: "agr-embed-pret" }, hote);
    return () => window.removeEventListener("message", ecoute);
  }, [hote]);

  const c = params.couches;
  const voirReseau = c.length === 0 || c.includes("troncons");
  const voirChantiers = c.length === 0 || c.includes("chantiers");
  const voirOuvrages = c.includes("ouvrages") || !!params.ouvrage || pilotes !== null;
  const voirFranchissements = c.includes("franchissements");
  // 3 178 points : en SVG la page se fige ; le rendu canvas les dessine d'un bloc.
  const rendu = useMemo(() => L.canvas({ padding: 0.5, tolerance: 4 }), []);
  const { data: franchissements } = useQuery({ queryKey: ["public", "franchissements"], queryFn: chargerFranchissements, enabled: voirFranchissements, staleTime: Infinity });

  const parId = useMemo(() => {
    const m = new Map<string, OuvragePilote>();
    (pilotes ?? []).forEach((p) => m.set(p.id, p));
    return m;
  }, [pilotes]);
  const ouvrages = useMemo(
    () => (data?.ouvrages ?? []).filter((o) => pilotes === null || parId.has(o.id.toLowerCase())),
    [data, pilotes, parId]
  );

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
  /** Troncons de la route demandee par la page hote : mis en evidence et cadres. */
  const surRoute = useMemo(() => (route ? tronconLines.filter((x) => x.t.nom.toUpperCase().replace(/\s+/g, "") === route) : []), [tronconLines, route]);
  /**
   * Cadrage d'une route : sur les ouvrages montres s'il y en a (une route peut porter des troncons homonymes
   * hors de Guinee, repris d'une source externe : 6 troncons « RN4 » de la N4 bissau-guineenne, 07/10/2026),
   * sinon sur ses troncons.
   */
  const limitesRoute = useMemo(() => {
    if (!route) return null;
    const pts = ouvrages.map((o) => [o.lat, o.lon] as [number, number]);
    if (pts.length) return pts;
    return surRoute.length ? surRoute.flatMap((x) => x.positions) : null;
  }, [route, ouvrages, surRoute]);
  const franchissementsVus = useMemo(() => (franchissements ?? []).filter((f) => !route || memeRoute(f.numero, route)), [franchissements, route]);
  const chantierLines = useMemo(
    () =>
      (data?.chantiers ?? [])
        .filter((c) => !c.approximate && (!params.region || c.region === params.region))
        .map((c) => ({ c, positions: geoJsonToLatLngs(c.geometry) }))
        .filter((x) => x.positions.length > 0),
    [data, params]
  );
  const dansRegion = (r: string | null): boolean => !params.region || r === params.region;
  const cliquer = (id: string) => { if (hote) window.parent.postMessage({ type: "agr-ouvrage-clic", id }, hote); };
  /** Clic sur un franchissement : DigitalRoad ouvre sa fiche (cle) ; les attributs servent si la fiche manque encore. */
  const cliquerFranchissement = (f: Franchissement) => {
    if (hote) window.parent.postMessage({ type: "agr-franchissement-clic", cle: f.cle, lat: f.lat, lon: f.lon, nature: f.nature, numero: f.numero, nom: f.nom, region: f.region, classement: f.classement }, hote);
  };

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <MapContainer center={GUINEE_CENTER} zoom={7} zoomControl={params.fond === "satellite"} attributionControl={false} style={{ height: "100%", width: "100%" }}>
        {params.fond === "satellite" ? (
          <>
            <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" maxNativeZoom={18} />
            <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}" maxNativeZoom={18} />
          </>
        ) : (
          /* Esri Dark Gray et non le fond sombre CARTO : basemaps.cartocdn.com renvoie
             desormais une tuile filigranee "API KEY REQUIRED" (en HTTP 200). */
          <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}" />
        )}
        <CentrerSur position={focus} limites={focus ? null : cible ? cible.positions : limitesRoute} />
        {voirReseau && tronconLines.map(({ t, positions }) => (
          <Polyline key={t.id} positions={positions} pathOptions={{ color: ETAT_COLORS[t.etat] ?? "#8FA9C8", weight: t.id === params.troncon || (route !== null && t.nom.toUpperCase().replace(/\s+/g, "") === route) ? 7 : 3, opacity: route !== null && t.nom.toUpperCase().replace(/\s+/g, "") !== route ? 0.35 : 1 }}>
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
        {voirChantiers && !params.chantiersPrecis && (data?.chantiers ?? [])
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
        {voirFranchissements && franchissementsVus.map((f) => {
          const statut = statutsFr.get(f.cle);
          return (
            <CircleMarker key={f.id} center={[f.lat, f.lon]} radius={route ? 6 : 3} renderer={rendu}
              pathOptions={{ color: "#ffffff", weight: 1, fillColor: couleurFranchissement(f.classement, statut), fillOpacity: 0.9 }}
              eventHandlers={hote ? { click: () => cliquerFranchissement(f) } : undefined}>
              <Tooltip>
                {f.nature} (franchissement repéré){f.numero ? ` · ${f.numero}` : ""}{f.nom ? ` · ${f.nom}` : ""}
                <br />
                {statut && statut !== "À instruire" ? `Instruit DOA&A : ${statut}`
                  : f.classement === "PONT_SANS_OUVRAGE" ? "aucun ouvrage AGEROUTE à proximité : à instruire" : "ouvrage AGEROUTE à proximité"}
                {hote ? <><br />Cliquer pour ouvrir la fiche</> : null}
              </Tooltip>
            </CircleMarker>
          );
        })}
        {voirOuvrages && ouvrages.map((o) => {
          const p = parId.get(o.id.toLowerCase());
          const etat = p?.etat && p.etat in ETAT_COLORS ? p.etat : o.etat;
          return (
            <Marker key={o.id} position={[o.lat, o.lon]} icon={ouvrageIcon(o.type, etat, o.aValider === true && !p?.valide)} eventHandlers={{ click: () => cliquer(o.id) }}>
              <Tooltip permanent={o.id === params.ouvrage}>
                {TYPE_OUVRAGE_LABEL[o.type] ?? o.type} — {o.code ?? o.nom}
                {p?.marque === "urgence" ? " · urgence" : p?.marque === "travaux" ? " · en travaux" : ""}
                {o.aValider && !p?.valide ? " (à valider)" : p?.valide && o.aValider ? " (validé DOA&A)" : ""}
              </Tooltip>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
