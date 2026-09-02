import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MapContainer, TileLayer, CircleMarker, Polyline, GeoJSON, Tooltip, useMap, useMapEvents } from "react-leaflet";
import type { Layer } from "leaflet";
import type { Feature, Geometry } from "geojson";
import MarkerClusterGroup from "react-leaflet-cluster";
import {
  Search, Ruler, Square, Navigation, Share2, Maximize, Minimize, ChevronDown,
  ChevronLeft, ChevronRight,
  Route, Landmark, ShieldAlert, Construction, AlertTriangle, MapPinned, Layers as LayersIcon,
  PenLine, Check, X, BarChart2,
} from "lucide-react";
import { api } from "../lib/api";
import { useEntityMutations } from "../hooks/useEntity";
import { useAuth, canDelete, canWrite } from "../lib/auth";
import { Checkbox } from "../components/ui/checkbox";
import type { DashboardKpis, EtatPatrimoine, Region } from "../types";
import { DetailPanel } from "./geoportail/DetailPanel";
import { MeasureLayer, type MeasureMode } from "./geoportail/MeasureLayer";
import { DrawTronconLayer, type DrawHandle, type DrawPhase } from "./geoportail/DrawTronconLayer";
import { DrawTronconForm } from "./geoportail/DrawTronconForm";
import { ExportControl } from "./geoportail/ExportControl";
import { TOPONYMES } from "./geoportail/toponymes";
import { TronconPicker } from "../components/TronconPicker";
import {
  ETAT_COLORS,
  ETAT_LABELS,
  CHANTIER_COLORS,
  type ChantierGeoFeature,
  type OuvrageGeoPoint,
  type PointNoirGeoPoint,
  type PosteGeoPoint,
  type SelectedFeature,
  type TronconGeoFeature,
} from "./geoportail/types";
import type { StatutChantier } from "../types";

const GUINEE_CENTER: [number, number] = [10.5, -10.8];
const DEFAULT_ZOOM = 7;

const BASEMAPS = {
  // Esri Light Gray et non le fond clair CARTO : basemaps.cartocdn.com renvoie
  // desormais une tuile filigranee "API KEY REQUIRED" (en HTTP 200, donc sans
  // erreur visible cote code). Esri est deja la source du fond satellite ci-dessous
  // et ne demande pas de cle.
  clair: {
    label: "Plan clair",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: "&copy; Esri, HERE, Garmin, &copy; OpenStreetMap",
  },
  osm: {
    label: "OpenStreetMap",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap",
  },
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "&copy; Esri",
  },
} as const;

type BasemapKey = keyof typeof BASEMAPS;
const LAYER_KEYS = ["troncons", "chantiers", "ouvrages", "postes", "pointsNoirs"] as const;
type LayerKey = (typeof LAYER_KEYS)[number];
const CLASSE_KEYS = ["RN", "RR", "RU", "PISTE"] as const;
const CLASSE_LABELS: Record<(typeof CLASSE_KEYS)[number], string> = {
  RN: "Routes nationales (RN)",
  RR: "Routes préfectorales (RP)",
  RU: "Voiries urbaines (VU)",
  PISTE: "Pistes rurales",
};
const CHANTIER_STATUT_KEYS = ["PLANIFIE", "EN_COURS", "SUSPENDU", "TERMINE"] as const;
const CHANTIER_STATUT_LABELS: Record<StatutChantier, string> = {
  PLANIFIE: "Planifiés",
  EN_COURS: "En cours",
  SUSPENDU: "Suspendus",
  TERMINE: "Terminés",
};

function geoJsonToLatLngs(geometry: string): [number, number][] {
  try {
    const g = JSON.parse(geometry) as { type: string; coordinates: number[][] };
    if (g.type !== "LineString") return [];
    return g.coordinates.map(([lon, lat]) => [lat, lon]);
  } catch {
    return [];
  }
}

function FlyTo({ position }: { position: [number, number] | null }) {
  const map = useMap();
  if (position) map.flyTo(position, 13, { duration: 0.8 });
  return null;
}

function ViewTracker({ onChange }: { onChange: (center: [number, number], zoom: number) => void }) {
  useMapEvents({
    moveend(e) {
      const c = e.target.getCenter();
      onChange([c.lat, c.lng], e.target.getZoom());
    },
  });
  return null;
}

// Section repliable du panneau lateral : evite un panneau interminable une fois
// toutes les couches/filtres affiches, et donne un rendu "carte" plus moderne
// que les blocs de texte empiles de l'ancienne version.
function PanelSection({
  icon, title, defaultOpen = true, children,
}: { icon: React.ReactNode; title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-gray-100 bg-white shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-gray-50"
      >
        <span className="text-navy">{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-600 flex-1">{title}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="px-3 pb-3 space-y-1.5 text-sm">{children}</div>}
    </div>
  );
}

function LayerRow({ checked, onChange, label, bold }: { checked: boolean; onChange: () => void; label: string; bold?: boolean }) {
  return (
    <label className={`flex items-center gap-2 cursor-pointer ${bold ? "font-medium text-navy" : "text-gray-600"}`}>
      <Checkbox checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}

export function GeoportailPage() {
  const [params, setParams] = useSearchParams();

  const [layers, setLayers] = useState<Record<LayerKey, boolean>>(() => {
    const fromUrl = params.get("layers");
    if (!fromUrl) return { troncons: true, chantiers: true, ouvrages: true, postes: true, pointsNoirs: true };
    const active = new Set(fromUrl.split(","));
    return Object.fromEntries(LAYER_KEYS.map((k) => [k, active.has(k)])) as Record<LayerKey, boolean>;
  });
  const [regionFilter, setRegionFilter] = useState(params.get("region") ?? "");
  const [etatFilter, setEtatFilter] = useState(params.get("etat") ?? "");
  const [basemap, setBasemap] = useState<BasemapKey>((params.get("bg") as BasemapKey) || "clair");
  const [search, setSearch] = useState("");
  const [flyTarget, setFlyTarget] = useState<[number, number] | null>(null);
  const [selectedFeature, setSelectedFeature] = useState<SelectedFeature | null>(null);
  const [measureMode, setMeasureMode] = useState<MeasureMode>("off");
  const [measurePoints, setMeasurePoints] = useState<[number, number][]>([]);
  const [measureResult, setMeasureResult] = useState({ distanceKm: 0, areaKm2: null as number | null });
  const [shareCopied, setShareCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [classeFilter, setClasseFilter] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(CLASSE_KEYS.map((k) => [k, true]))
  );
  const [chantierStatutFilter, setChantierStatutFilter] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(CHANTIER_STATUT_KEYS.map((k) => [k, true]))
  );
  const [showAlertes, setShowAlertes] = useState(false);
  const [showToponymes, setShowToponymes] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawPhase, setDrawPhase] = useState<DrawPhase>("drawing");
  const [drawLengthKm, setDrawLengthKm] = useState(0);
  const [drawnPoints, setDrawnPoints] = useState<[number, number][] | null>(null);
  const drawRef = useRef<DrawHandle>(null);

  const [itineraireOpen, setItineraireOpen] = useState(false);
  const [itinFromId, setItinFromId] = useState<string | undefined>(undefined);
  const [itinToId, setItinToId] = useState<string | undefined>(undefined);
  const [itinResult, setItinResult] = useState<{
    distanceKm: number; fromCode: string; fromNom: string; toCode: string; toNom: string; regionsTraversees: string[];
  } | null>(null);
  const [itinError, setItinError] = useState<string | null>(null);
  const [itinLoading, setItinLoading] = useState(false);

  // Ce calcul n'est PAS un itineraire routier : le service trace une droite entre
  // les centroides des deux troncons et renvoie la distance a vol d'oiseau. Le nom de
  // la fonction est conserve pour ne pas toucher a l'API, mais l'interface ne doit
  // jamais promettre un trajet — elle promettait « Itineraire » sur le bouton, et ne
  // detrompait l'utilisateur qu'apres coup, dans le resultat.
  async function calculerItineraire() {
    if (!itinFromId || !itinToId) return;
    setItinLoading(true);
    setItinError(null);
    setItinResult(null);
    try {
      const { data } = await api.get("/troncons/itineraire", { params: { fromId: itinFromId, toId: itinToId } });
      setItinResult(data);
    } catch {
      setItinError("Calcul impossible (tronçons introuvables).");
    } finally {
      setItinLoading(false);
    }
  }

  const { user } = useAuth();
  const { remove: removeOuvrage } = useEntityMutations("ouvrages");
  const { remove: removePointNoir } = useEntityMutations("points-noirs");
  const { remove: removePoste } = useEntityMutations("postes");
  const { remove: removeChantier } = useEntityMutations("chantiers");

  function archiveSelectedFeature() {
    if (!selectedFeature || selectedFeature.kind === "toponyme" || selectedFeature.kind === "troncon") return;
    const mutations = { ouvrage: removeOuvrage, pointNoir: removePointNoir, poste: removePoste, chantier: removeChantier };
    const mutation = mutations[selectedFeature.kind as keyof typeof mutations];
    mutation?.mutate(selectedFeature.data.id);
    setSelectedFeature(null);
  }

  const initialView = useMemo<{ center: [number, number]; zoom: number }>(() => {
    const lat = parseFloat(params.get("lat") ?? "");
    const lng = parseFloat(params.get("lng") ?? "");
    const zoom = parseFloat(params.get("zoom") ?? "");
    if (!isNaN(lat) && !isNaN(lng) && !isNaN(zoom)) return { center: [lat, lng], zoom };
    return { center: GUINEE_CENTER, zoom: DEFAULT_ZOOM };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const viewRef = useRef(initialView);

  const exportRef = useRef<HTMLDivElement>(null);

  const { data: regions } = useQuery({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
  });
  const { data: kpis } = useQuery({
    queryKey: ["dashboard", "kpis"],
    queryFn: async () => (await api.get<DashboardKpis>("/dashboard/kpis")).data,
  });
  const { data: troncons, isLoading } = useQuery({
    queryKey: ["troncons", "geo"],
    queryFn: async () => (await api.get<TronconGeoFeature[]>("/troncons/geo")).data,
  });
  const { data: ouvrages } = useQuery({
    queryKey: ["ouvrages", "geo"],
    queryFn: async () => (await api.get<OuvrageGeoPoint[]>("/ouvrages/geo")).data,
  });
  const { data: pointsNoirs } = useQuery({
    queryKey: ["points-noirs", "geo"],
    queryFn: async () => (await api.get<PointNoirGeoPoint[]>("/points-noirs/geo")).data,
  });
  const { data: postes } = useQuery({
    queryKey: ["postes", "geo"],
    queryFn: async () => (await api.get<PosteGeoPoint[]>("/postes/geo")).data,
  });
  const { data: chantiers } = useQuery({
    queryKey: ["chantiers", "geo"],
    queryFn: async () => (await api.get<ChantierGeoFeature[]>("/chantiers/geo")).data,
  });

  // Arrivee depuis un lien externe (page Alertes/Rapports : "?select=ouvrage&id=...") :
  // une fois la couche correspondante chargee, on centre la carte et on ouvre la fiche
  // directement, sans que l'utilisateur ait a rechercher l'element manuellement.
  const selectKind = params.get("select");
  const selectId = params.get("id");
  useEffect(() => {
    if (!selectKind || !selectId) return;
    if (selectKind === "troncon") {
      const t = troncons?.find((x) => x.id === selectId);
      if (!t) return;
      const pts = geoJsonToLatLngs(t.geometry);
      if (pts.length) setFlyTarget(pts[Math.floor(pts.length / 2)]);
      setSelectedFeature({ kind: "troncon", data: t });
    } else if (selectKind === "ouvrage") {
      const o = ouvrages?.find((x) => x.id === selectId);
      if (!o) return;
      setFlyTarget([o.lat, o.lon]);
      setSelectedFeature({ kind: "ouvrage", data: o });
    } else if (selectKind === "pointNoir") {
      const p = pointsNoirs?.find((x) => x.id === selectId);
      if (!p) return;
      setFlyTarget([p.lat, p.lon]);
      setSelectedFeature({ kind: "pointNoir", data: p });
    } else if (selectKind === "poste") {
      const p = postes?.find((x) => x.id === selectId);
      if (!p) return;
      setFlyTarget([p.lat, p.lon]);
      setSelectedFeature({ kind: "poste", data: p });
    } else if (selectKind === "chantier") {
      const c = chantiers?.find((x) => x.id === selectId);
      if (!c) return;
      if (c.lat != null && c.lon != null) setFlyTarget([c.lat, c.lon]);
      else {
        const pts = geoJsonToLatLngs(c.geometry ?? "");
        if (pts.length) setFlyTarget(pts[Math.floor(pts.length / 2)]);
      }
      setSelectedFeature({ kind: "chantier", data: c });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectKind, selectId, troncons, ouvrages, pointsNoirs, postes, chantiers]);

  const filteredTroncons = useMemo(
    () =>
      (troncons ?? []).filter(
        (t) =>
          (!regionFilter || t.region === regionFilter) &&
          (!etatFilter || t.etat === etatFilter) &&
          classeFilter[t.classe] !== false
      ),
    [troncons, regionFilter, etatFilter, classeFilter]
  );

  const alertTroncons = useMemo(
    () => (troncons ?? []).filter((t) => t.etat === "CRITIQUE" || t.etat === "MAUVAIS"),
    [troncons]
  );
  const alertOuvrages = useMemo(() => (ouvrages ?? []).filter((o) => o.etat === "CRITIQUE"), [ouvrages]);

  const toggleClasse = (key: string) => setClasseFilter((c) => ({ ...c, [key]: !c[key] }));
  const toggleChantierStatut = (key: string) => setChantierStatutFilter((c) => ({ ...c, [key]: !c[key] }));
  const filteredChantiers = useMemo(
    () => (chantiers ?? []).filter((c) => chantierStatutFilter[c.statut] !== false),
    [chantiers, chantierStatutFilter]
  );

  // Recherche unifiee (tous types confondus) : un utilisateur cherchant "Kindia" ou un nom
  // d'ouvrage ne devrait pas avoir a deviner dans quel module chercher. Chaque resultat
  // porte sa propre cible de centrage (point ou milieu de trace).
  interface SearchHit {
    key: string;
    label: string;
    sub: string;
    onSelect: () => void;
  }
  const searchResults = useMemo<SearchHit[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const hits: SearchHit[] = [];
    for (const t of troncons ?? []) {
      if (hits.length >= 10) break;
      if (t.code.toLowerCase().includes(q) || t.nom.toLowerCase().includes(q)) {
        hits.push({
          key: `troncon-${t.id}`,
          label: `${t.code} — ${t.nom}`,
          sub: "Tronçon",
          onSelect: () => {
            const pts = geoJsonToLatLngs(t.geometry);
            if (pts.length) setFlyTarget(pts[Math.floor(pts.length / 2)]);
            setSelectedFeature({ kind: "troncon", data: t });
          },
        });
      }
    }
    for (const o of ouvrages ?? []) {
      if (hits.length >= 10) break;
      if (o.nom.toLowerCase().includes(q)) {
        hits.push({
          key: `ouvrage-${o.id}`,
          label: o.nom,
          sub: `Ouvrage — ${o.type}`,
          onSelect: () => {
            setFlyTarget([o.lat, o.lon]);
            setSelectedFeature({ kind: "ouvrage", data: o });
          },
        });
      }
    }
    for (const c of chantiers ?? []) {
      if (hits.length >= 10) break;
      if (c.intitule.toLowerCase().includes(q)) {
        hits.push({
          key: `chantier-${c.id}`,
          label: c.intitule,
          sub: "Chantier",
          onSelect: () => {
            if (c.lat != null && c.lon != null) setFlyTarget([c.lat, c.lon]);
            else {
              const pts = geoJsonToLatLngs(c.geometry ?? "");
              if (pts.length) setFlyTarget(pts[Math.floor(pts.length / 2)]);
            }
            setSelectedFeature({ kind: "chantier", data: c });
          },
        });
      }
    }
    for (const p of pointsNoirs ?? []) {
      if (hits.length >= 10) break;
      if (p.description.toLowerCase().includes(q)) {
        hits.push({
          key: `pointNoir-${p.id}`,
          label: p.description,
          sub: "Point noir",
          onSelect: () => {
            setFlyTarget([p.lat, p.lon]);
            setSelectedFeature({ kind: "pointNoir", data: p });
          },
        });
      }
    }
    for (const p of postes ?? []) {
      if (hits.length >= 10) break;
      if (p.nom.toLowerCase().includes(q)) {
        hits.push({
          key: `poste-${p.id}`,
          label: p.nom,
          sub: `Poste — ${p.type}`,
          onSelect: () => {
            setFlyTarget([p.lat, p.lon]);
            setSelectedFeature({ kind: "poste", data: p });
          },
        });
      }
    }
    return hits.slice(0, 10);
  }, [troncons, ouvrages, chantiers, pointsNoirs, postes, search]);

  // Rendu en une seule couche GeoJSON plutot qu'en ~1700 <Polyline> React individuelles :
  // le nombre d'elements SVG dessines par Leaflet reste le meme, mais on supprime le cout
  // de reconciliation React (diff de ~1700 composants) a chaque re-render (changement de
  // filtre, ouverture d'un modal, etc.) — sensible sur un reseau de cette taille.
  const tronconsById = useMemo(() => new Map(filteredTroncons.map((t) => [t.id, t])), [filteredTroncons]);
  const tronconsFeatureCollection = useMemo(() => {
    const features: Feature<Geometry, { id: string }>[] = [];
    for (const t of filteredTroncons) {
      try {
        features.push({ type: "Feature", geometry: JSON.parse(t.geometry), properties: { id: t.id } });
      } catch {
        // geometrie illisible : on l'ignore plutot que de casser toute la couche
      }
    }
    return { type: "FeatureCollection" as const, features };
  }, [filteredTroncons]);

  const repartitionParEtat = useMemo(() => {
    const totals = new Map<EtatPatrimoine, number>();
    let total = 0;
    for (const t of troncons ?? []) {
      totals.set(t.etat, (totals.get(t.etat) ?? 0) + t.longueurKm);
      total += t.longueurKm;
    }
    return Array.from(totals.entries())
      .map(([etat, km]) => ({ etat, km, pct: total > 0 ? (km / total) * 100 : 0 }))
      .sort((a, b) => b.km - a.km);
  }, [troncons]);

  const toggleLayer = (key: LayerKey) => setLayers((l) => ({ ...l, [key]: !l[key] }));
  const bm = BASEMAPS[basemap];

  const handleViewChange = useCallback((center: [number, number], zoom: number) => {
    viewRef.current = { center, zoom };
  }, []);

  function buildShareUrl(): string {
    const next = new URLSearchParams();
    next.set("layers", LAYER_KEYS.filter((k) => layers[k]).join(","));
    if (regionFilter) next.set("region", regionFilter);
    if (etatFilter) next.set("etat", etatFilter);
    next.set("bg", basemap);
    next.set("lat", viewRef.current.center[0].toFixed(5));
    next.set("lng", viewRef.current.center[1].toFixed(5));
    next.set("zoom", String(viewRef.current.zoom));
    return `${window.location.origin}${window.location.pathname}?${next.toString()}`;
  }

  async function handleShare() {
    const url = buildShareUrl();
    setParams(new URLSearchParams(url.split("?")[1]), { replace: true });
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      window.prompt("Copiez ce lien :", url);
    }
  }

  function clearMeasure() {
    setMeasurePoints([]);
    setMeasureResult({ distanceKm: 0, areaKm2: null });
  }

  useEffect(() => {
    if (measureMode === "off") clearMeasure();
  }, [measureMode]);

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-50 bg-white flex"
          : "h-full rounded-xl overflow-hidden border border-gray-200 relative flex"
      }
      ref={exportRef}
    >
      {isLoading && (
        <p className="absolute z-20 top-2 left-1/2 -translate-x-1/2 bg-white px-3 py-1 rounded shadow text-sm">
          Chargement de la carte...
        </p>
      )}

      {/* Barre de recherche + outils */}
      <div className="absolute z-20 top-3 left-1/2 -translate-x-1/2 w-80 flex flex-col items-center gap-2">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher (tronçon, ouvrage, chantier...)"
            className="w-full rounded-full border border-gray-200 bg-white pl-9 pr-3 py-2 text-sm shadow-md focus:outline-none focus:ring-2 focus:ring-gold/50"
          />
        </div>
        {searchResults.length > 0 && (
          <div className="w-full bg-white rounded-lg shadow-lg border border-gray-100 overflow-hidden">
            {searchResults.map((hit) => (
              <button
                key={hit.key}
                className="flex w-full items-center justify-between gap-2 text-left px-3 py-2 text-sm hover:bg-gray-50"
                onClick={() => {
                  hit.onSelect();
                  setSearch("");
                }}
              >
                <span className="font-medium truncate">{hit.label}</span>
                <span className="text-[11px] text-gray-400 shrink-0">{hit.sub}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="absolute z-20 top-3 right-3 flex items-center gap-1.5">
        {canWrite(user?.role) && (
          <button
            onClick={() => {
              if (drawMode) {
                drawRef.current?.cancel();
                setDrawMode(false);
              } else {
                setMeasureMode("off");
                setItineraireOpen(false);
                setDrawMode(true);
              }
            }}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm shadow-md font-medium ${
              drawMode
                ? "border-red-400 bg-red-500 text-white hover:bg-red-600"
                : "border-gray-200 bg-white hover:bg-gray-50 text-navy"
            }`}
          >
            <PenLine className="h-3.5 w-3.5" />
            {drawMode ? "Annuler" : "Créer tronçon"}
          </button>
        )}
        {/* Outils de mesure groupés */}
        <div className="flex rounded-lg border border-gray-200 bg-white shadow-md overflow-hidden text-sm">
          <button
            onClick={() => setMeasureMode(measureMode === "distance" ? "off" : "distance")}
            title="Mesurer une distance"
            className={`flex items-center gap-1.5 px-2.5 py-2 ${measureMode === "distance" ? "bg-navy text-white" : "hover:bg-gray-50"}`}
          >
            <Ruler className="h-3.5 w-3.5" /><span className="hidden sm:inline">Distance</span>
          </button>
          <button
            onClick={() => setMeasureMode(measureMode === "area" ? "off" : "area")}
            title="Mesurer une surface"
            className={`flex items-center gap-1.5 px-2.5 py-2 border-l border-gray-200 ${measureMode === "area" ? "bg-navy text-white" : "hover:bg-gray-50"}`}
          >
            <Square className="h-3.5 w-3.5" /><span className="hidden sm:inline">Surface</span>
          </button>
          {measureMode !== "off" && (
            <button onClick={clearMeasure} title="Effacer la mesure" className="px-2.5 py-2 border-l border-gray-200 hover:bg-gray-50 text-gray-500">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {/* Autres outils */}
        <div className="flex rounded-lg border border-gray-200 bg-white shadow-md overflow-hidden text-sm">
          <button
            onClick={() => setItineraireOpen((v) => !v)}
            title="Estimer la distance à vol d'oiseau entre deux tronçons"
            className={`flex items-center gap-1.5 px-2.5 py-2 ${itineraireOpen ? "bg-navy text-white" : "hover:bg-gray-50"}`}
          >
            <Navigation className="h-3.5 w-3.5" /><span className="hidden sm:inline">Distance</span>
          </button>
          <button
            onClick={handleShare}
            title="Partager la vue"
            className="flex items-center gap-1.5 px-2.5 py-2 border-l border-gray-200 hover:bg-gray-50"
          >
            <Share2 className="h-3.5 w-3.5" /><span className="hidden sm:inline">{shareCopied ? "Copié ✓" : "Partager"}</span>
          </button>
          <div className="border-l border-gray-200">
            <ExportControl targetRef={exportRef} />
          </div>
          <button
            onClick={() => setFullscreen((v) => !v)}
            title={fullscreen ? "Quitter le plein écran" : "Plein écran"}
            className="flex items-center justify-center px-2.5 py-2 border-l border-gray-200 hover:bg-gray-50"
          >
            {fullscreen ? <Minimize className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {measureMode !== "off" && (
        <div className="absolute z-20 top-16 right-3 bg-white rounded-lg shadow-lg border border-gray-100 px-3 py-2 text-sm">
          <p className="text-gray-500 text-[11px]">Cliquez sur la carte pour ajouter des points</p>
          <p className="font-semibold text-navy">Distance : {measureResult.distanceKm.toFixed(2)} km</p>
          {measureMode === "area" && (
            <p className="font-semibold text-navy">Surface : {(measureResult.areaKm2 ?? 0).toFixed(2)} km²</p>
          )}
        </div>
      )}

      {drawMode && (
        <div className="absolute z-20 top-16 right-3 w-64 bg-white rounded-lg shadow-lg border border-red-100 px-3 py-2.5 text-sm space-y-2">
          <p className="text-xs font-semibold text-red-600 uppercase tracking-wide">
            {drawPhase === "drawing" ? "Mode dessin actif" : "Édition des sommets"}
          </p>
          {drawPhase === "drawing" ? (
            <>
              <p className="text-[11px] text-gray-500">
                Cliquez pour placer des points • <strong>Double-clic</strong> pour terminer le tracé
              </p>
              <p className="text-[11px] text-gray-400">
                Les cercles orange indiquent un accrochage à un tronçon existant.
              </p>
            </>
          ) : (
            <p className="text-[11px] text-gray-500">
              Glissez les sommets pour ajuster • Clic droit sur un sommet pour le supprimer.
            </p>
          )}
          <p className="font-semibold text-navy">Longueur : {drawLengthKm.toFixed(3)} km</p>
          {drawPhase === "editing" && (
            <button
              onClick={() => drawRef.current?.finish()}
              className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-navy text-white px-3 py-1.5 text-sm font-medium hover:bg-navy/90"
            >
              <Check className="h-3.5 w-3.5" /> Valider le tracé
            </button>
          )}
          <button
            onClick={() => { drawRef.current?.cancel(); setDrawMode(false); }}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          >
            <X className="h-3.5 w-3.5" /> Annuler
          </button>
        </div>
      )}

      {itineraireOpen && (
        <div className="absolute z-20 top-16 right-3 w-72 bg-white rounded-lg shadow-lg border border-gray-100 p-3 text-sm space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Estimation de distance</p>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Tronçon de départ</label>
            <TronconPicker value={itinFromId} onChange={setItinFromId} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Tronçon d'arrivée</label>
            <TronconPicker value={itinToId} onChange={setItinToId} />
          </div>
          <button
            onClick={calculerItineraire}
            disabled={!itinFromId || !itinToId || itinLoading}
            className="w-full rounded-lg bg-navy text-white px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {itinLoading ? "Calcul..." : "Calculer"}
          </button>
          {itinError && <p className="text-xs text-red-600">{itinError}</p>}
          {itinResult && (
            <div className="pt-2 border-t border-gray-100 space-y-1">
              <p className="font-semibold text-navy">
                {itinResult.distanceKm.toFixed(1)} km à vol d'oiseau
              </p>
              <p className="text-xs text-gray-500">
                {itinResult.fromCode} ({itinResult.fromNom}) → {itinResult.toCode} ({itinResult.toNom})
              </p>
              {itinResult.regionsTraversees.length > 0 && (
                <p className="text-xs text-gray-500">
                  Régions proches du tracé direct : {itinResult.regionsTraversees.join(", ")}
                </p>
              )}
              <p className="text-[11px] text-gray-400">
                Distance en ligne droite, pas un calcul d'itinéraire routier précis.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Panneau gauche collapsible */}
      <aside
        className={`relative z-10 bg-gray-50 border-r border-gray-100 text-sm flex flex-col flex-shrink-0 transition-all duration-200 ease-in-out ${
          sidebarOpen ? "w-72" : "w-10"
        }`}
      >
        {/* Bouton toggle */}
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? "Réduire le panneau" : "Afficher le panneau"}
          className={`absolute top-3 z-10 flex items-center justify-center w-6 h-6 rounded-full bg-white border border-gray-200 shadow-sm hover:bg-gray-50 text-gray-500 transition-all ${
            sidebarOpen ? "right-2" : "left-1/2 -translate-x-1/2"
          }`}
        >
          {sidebarOpen ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        {/* Contenu (masqué quand replié) */}
        <div
          className={`flex-1 overflow-y-auto p-3 pt-10 space-y-3 transition-opacity duration-150 ${
            sidebarOpen ? "opacity-100" : "opacity-0 pointer-events-none overflow-hidden"
          }`}
        >
          {/* KPIs réseau */}
          {kpis && (
            <PanelSection icon={<BarChart2 className="h-4 w-4" />} title="Tableau de bord">
              <div className="grid grid-cols-2 gap-1.5 mb-2">
                {/* « Lineaire total » etait faux : ce chiffre est la longueur SAISIE,
                    renseignee sur 662 troncons sur 1 690. La longueur calculee depuis
                    la geometrie donne 21 156 km. Deux chiffres, deux libelles. */}
                <MiniStat label="Longueur renseignée" value={`${kpis.longueurTotaleKm.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} km`} accent="#1a2942" />
                {kpis.reseau?.geometrique?.totalKm > 0 && (
                  <MiniStat
                    label="Calculé (géométrie)"
                    value={`${kpis.reseau.geometrique.totalKm.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} km`}
                    accent="#0891b2"
                  />
                )}
                <MiniStat label="Tronçons" value={kpis.tronconsCount} accent="#1a2942" />
                <MiniStat label="Ouvrages" value={kpis.ouvragesCount} accent="#7c3aed" />
                <MiniStat label="Chantiers actifs" value={kpis.chantiersEnCours} accent="#f5a623" />
                <MiniStat label="Points noirs" value={kpis.pointsNoirsCount} accent="#dc2626" />
              </div>
              <div className="space-y-1 pt-1 border-t border-gray-100">
                {repartitionParEtat.map((r) => (
                  <div key={r.etat} className="flex items-center gap-1.5 text-[11px]">
                    <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: ETAT_COLORS[r.etat] }} />
                    <span className="flex-1 text-gray-600 truncate">{ETAT_LABELS[r.etat]}</span>
                    <span className="text-gray-500 shrink-0">{r.km.toFixed(0)} km</span>
                    <span className="text-gray-400 shrink-0 w-7 text-right">{r.pct.toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </PanelSection>
          )}

          <PanelSection icon={<Route className="h-4 w-4" />} title="Réseau routier">
            <LayerRow checked={layers.troncons} onChange={() => toggleLayer("troncons")} label="Tous les tronçons" bold />
            {layers.troncons && (
              <div className="ml-5 space-y-1 border-l border-gray-100 pl-2">
                {CLASSE_KEYS.map((k) => (
                  <LayerRow key={k} checked={classeFilter[k] !== false} onChange={() => toggleClasse(k)} label={CLASSE_LABELS[k]} />
                ))}
              </div>
            )}
          </PanelSection>

          <PanelSection icon={<Landmark className="h-4 w-4" />} title="Patrimoine">
            <LayerRow checked={layers.ouvrages} onChange={() => toggleLayer("ouvrages")} label="Ouvrages d'art" />
            <LayerRow checked={layers.postes} onChange={() => toggleLayer("postes")} label="Péage / Pesage" />
            <LayerRow checked={layers.pointsNoirs} onChange={() => toggleLayer("pointsNoirs")} label="Points noirs" />
          </PanelSection>

          <PanelSection icon={<Construction className="h-4 w-4" />} title="Travaux">
            <LayerRow checked={layers.chantiers} onChange={() => toggleLayer("chantiers")} label="Tous les chantiers" bold />
            {layers.chantiers && (
              <div className="ml-5 space-y-1 border-l border-gray-100 pl-2">
                {CHANTIER_STATUT_KEYS.map((k) => (
                  <label key={k} className="flex items-center gap-2 text-gray-600 cursor-pointer">
                    <Checkbox checked={chantierStatutFilter[k] !== false} onCheckedChange={() => toggleChantierStatut(k)} />
                    <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: CHANTIER_COLORS[k] }} />
                    {CHANTIER_STATUT_LABELS[k]}
                  </label>
                ))}
              </div>
            )}
          </PanelSection>

          <PanelSection icon={<ShieldAlert className="h-4 w-4" />} title="Alertes" defaultOpen={false}>
            <LayerRow checked={showAlertes} onChange={() => setShowAlertes((v) => !v)} label="Tronçons / ouvrages à risque" />
            {showAlertes && (
              <p className="text-[11px] text-gray-400 ml-6">
                {alertTroncons.length} tronçon(s), {alertOuvrages.length} ouvrage(s) en état mauvais/critique
              </p>
            )}
          </PanelSection>

          <PanelSection icon={<MapPinned className="h-4 w-4" />} title="Repères" defaultOpen={false}>
            <LayerRow checked={showToponymes} onChange={() => setShowToponymes((v) => !v)} label="Ponts, tunnels, parkings (OSM)" />
          </PanelSection>

          <PanelSection icon={<AlertTriangle className="h-4 w-4" />} title="Filtres" defaultOpen={false}>
            <select
              value={regionFilter}
              onChange={(e) => setRegionFilter(e.target.value)}
              className="w-full rounded-md border border-gray-200 px-2 py-1.5 mb-2 text-sm"
            >
              <option value="">Toutes les régions</option>
              {regions?.map((r) => (
                <option key={r.id} value={r.nom}>{r.nom}</option>
              ))}
            </select>
            <select
              value={etatFilter}
              onChange={(e) => setEtatFilter(e.target.value)}
              className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-sm"
            >
              <option value="">Tous les états</option>
              {Object.entries(ETAT_LABELS).map(([etat, label]) => (
                <option key={etat} value={etat}>{label}</option>
              ))}
            </select>
          </PanelSection>

          <PanelSection icon={<LayersIcon className="h-4 w-4" />} title="Fond de carte" defaultOpen={false}>
            <div className="grid grid-cols-3 gap-1.5">
              {Object.entries(BASEMAPS).map(([key, b]) => (
                <button
                  key={key}
                  onClick={() => setBasemap(key as BasemapKey)}
                  className={`rounded-md border px-1.5 py-1.5 text-[11px] text-center leading-tight ${
                    basemap === key ? "border-navy bg-navy text-white" : "border-gray-200 hover:bg-gray-50 text-gray-600"
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </PanelSection>

          <div className="rounded-lg border border-gray-100 bg-white shadow-sm p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">État de la chaussée</h3>
            <div className="space-y-1">
              {Object.entries(ETAT_LABELS).map(([etat, label]) => (
                <div key={etat} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ETAT_COLORS[etat as EtatPatrimoine] }} />
                  <span className="text-gray-600">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Icônes visibles quand replié */}
        {!sidebarOpen && (
          <div className="flex flex-col items-center gap-4 pt-14 text-gray-400">
            <Route className="h-4 w-4" />
            <Landmark className="h-4 w-4" />
            <Construction className="h-4 w-4" />
            <LayersIcon className="h-4 w-4" />
          </div>
        )}
      </aside>

      {/* Carte. z-0 cree un contexte d'empilement local : les panes Leaflet internes
          (z-index jusqu'a 700 pour les popups) restent ainsi contenus ici et ne
          peuvent plus "fuiter" au-dessus des modals (z-50) au niveau racine du
          document — sans ce confinement, .leaflet-container ayant z-index:auto
          ne cree aucun contexte d'empilement, et ses enfants positionnes (panes)
          sont compares directement aux elements de la racine. */}
      <div className="flex-1 relative z-0">
        <MapContainer center={initialView.center} zoom={initialView.zoom} style={{ height: "100%", width: "100%" }}>
          <TileLayer attribution={bm.attribution} url={bm.url} crossOrigin="anonymous" />
          {flyTarget && <FlyTo position={flyTarget} />}
          <ViewTracker onChange={handleViewChange} />
          <MeasureLayer
            mode={measureMode}
            points={measurePoints}
            onAddPoint={(p) => setMeasurePoints((pts) => [...pts, p])}
            onResult={setMeasureResult}
          />

          {drawMode && (
            <DrawTronconLayer
              ref={drawRef}
              troncons={troncons ?? []}
              onComplete={(pts, km) => {
                setDrawLengthKm(km);
                setDrawnPoints(pts);
                setDrawMode(false);
              }}
              onCancel={() => setDrawMode(false)}
              onPhaseChange={setDrawPhase}
              onLengthChange={setDrawLengthKm}
            />
          )}

          {layers.troncons && (
            <GeoJSON
              key={`troncons-${tronconsFeatureCollection.features.length}-${regionFilter}-${etatFilter}-${Object.values(classeFilter).join("")}`}
              data={tronconsFeatureCollection}
              style={(feature) => {
                const t = feature?.properties?.id ? tronconsById.get(feature.properties.id) : undefined;
                return { color: t ? ETAT_COLORS[t.etat] ?? "#1a2942" : "#1a2942", weight: 4 };
              }}
              onEachFeature={(feature, layer: Layer) => {
                const t = tronconsById.get(feature.properties?.id);
                if (!t) return;
                layer.bindTooltip(`${t.code} — ${t.nom}`, { sticky: true });
                layer.on("click", () => setSelectedFeature({ kind: "troncon", data: t }));
              }}
            />
          )}

          {/* Couche Alertes : surbrillance des tronçons/ouvrages en mauvais/critique
              état, independante des couches de base (visible meme si "Tous les
              tronçons" est decoche) pour un reperage rapide des points a traiter
              en urgence — inspire du calque "Alertes" de l'observatoire de reference. */}
          {showAlertes &&
            alertTroncons.map((t) => {
              const positions = geoJsonToLatLngs(t.geometry);
              if (!positions.length) return null;
              return (
                <Polyline
                  key={`alert-${t.id}`}
                  positions={positions}
                  pathOptions={{ color: "#d946ef", weight: 6, opacity: 0.55, dashArray: "1 8" }}
                  eventHandlers={{ click: () => setSelectedFeature({ kind: "troncon", data: t }) }}
                >
                  <Tooltip sticky>⚠ {t.code} — {t.nom} ({ETAT_LABELS[t.etat]})</Tooltip>
                </Polyline>
              );
            })}

          {layers.chantiers &&
            filteredChantiers
              .filter((c) => !c.approximate)
              .map((c) => {
                const positions = geoJsonToLatLngs(c.geometry ?? "");
                if (!positions.length) return null;
                return (
                  <Polyline
                    key={c.id}
                    positions={positions}
                    pathOptions={{
                      color: CHANTIER_COLORS[c.statut],
                      weight: 6,
                      dashArray: c.statut === "TERMINE" ? undefined : "6 6",
                    }}
                    eventHandlers={{ click: () => setSelectedFeature({ kind: "chantier", data: c }) }}
                  >
                    <Tooltip sticky>{c.intitule} — {CHANTIER_STATUT_LABELS[c.statut]}</Tooltip>
                  </Polyline>
                );
              })}

          {showAlertes &&
            alertOuvrages.map((o) => (
              <CircleMarker
                key={`alert-${o.id}`}
                center={[o.lat, o.lon]}
                radius={14}
                pathOptions={{ color: "#d946ef", weight: 3, fillOpacity: 0, opacity: 0.8 }}
                eventHandlers={{ click: () => setSelectedFeature({ kind: "ouvrage", data: o }) }}
              >
                <Tooltip>⚠ {o.nom} — état critique</Tooltip>
              </CircleMarker>
            ))}

          {/* Marqueurs ponctuels regroupes (clustering) pour la lisibilite au dezoom */}
          <MarkerClusterGroup chunkedLoading maxClusterRadius={50}>
            {layers.chantiers &&
              filteredChantiers
                .filter((c) => c.approximate && c.lat != null && c.lon != null)
                .map((c) => (
                  <CircleMarker
                    key={c.id}
                    center={[c.lat as number, c.lon as number]}
                    radius={8}
                    pathOptions={{ color: "#fff", weight: 1, fillColor: CHANTIER_COLORS[c.statut], fillOpacity: 0.85 }}
                    eventHandlers={{ click: () => setSelectedFeature({ kind: "chantier", data: c }) }}
                  >
                    <Tooltip>
                      {c.intitule} — {CHANTIER_STATUT_LABELS[c.statut]} (position approx., région {c.region})
                    </Tooltip>
                  </CircleMarker>
                ))}

            {showToponymes &&
              TOPONYMES.map((t, i) => (
                <CircleMarker
                  key={`topo-${i}`}
                  center={[t.lat, t.lon]}
                  radius={5}
                  pathOptions={{ color: "#fff", weight: 1, fillColor: "#0891b2", fillOpacity: 0.9 }}
                  eventHandlers={{ click: () => setSelectedFeature({ kind: "toponyme", data: t }) }}
                >
                  <Tooltip>{t.nature} — {t.nom}</Tooltip>
                </CircleMarker>
              ))}

            {layers.ouvrages &&
              ouvrages
                ?.filter((o) => !regionFilter || o.region === regionFilter)
                .map((o) => (
                  <CircleMarker
                    key={o.id}
                    center={[o.lat, o.lon]}
                    radius={7}
                    pathOptions={{ color: "#fff", weight: 1, fillColor: ETAT_COLORS[o.etat] ?? "#1a2942", fillOpacity: 0.9 }}
                    eventHandlers={{ click: () => setSelectedFeature({ kind: "ouvrage", data: o }) }}
                  >
                    <Tooltip>{o.nom}</Tooltip>
                  </CircleMarker>
                ))}

            {layers.postes &&
              postes
                ?.filter((p) => !regionFilter || p.region === regionFilter)
                .map((p) => (
                  <CircleMarker
                    key={p.id}
                    center={[p.lat, p.lon]}
                    radius={6}
                    pathOptions={{ color: "#fff", weight: 1, fillColor: "#7c3aed", fillOpacity: 0.9 }}
                    eventHandlers={{ click: () => setSelectedFeature({ kind: "poste", data: p }) }}
                  >
                    <Tooltip>{p.nom}</Tooltip>
                  </CircleMarker>
                ))}

            {layers.pointsNoirs &&
              pointsNoirs
                ?.filter((p) => !regionFilter || p.region === regionFilter)
                .map((p) => (
                  <CircleMarker
                    key={p.id}
                    center={[p.lat, p.lon]}
                    radius={6}
                    pathOptions={{ color: "#fff", weight: 1, fillColor: "#dc2626", fillOpacity: 0.95 }}
                    eventHandlers={{ click: () => setSelectedFeature({ kind: "pointNoir", data: p }) }}
                  >
                    <Tooltip>{p.description}</Tooltip>
                  </CircleMarker>
                ))}
          </MarkerClusterGroup>
        </MapContainer>

        {drawnPoints && (
          <DrawTronconForm
            points={drawnPoints}
            lengthKm={drawLengthKm}
            onClose={() => setDrawnPoints(null)}
            onSaved={() => {
              setDrawnPoints(null);
              setDrawLengthKm(0);
            }}
          />
        )}

      </div>

      {/* DetailPanel hors du stacking context z-0 → s'affiche au-dessus de la toolbar */}
      {selectedFeature && (
        <DetailPanel
          feature={selectedFeature}
          onClose={() => setSelectedFeature(null)}
          onArchive={archiveSelectedFeature}
          canArchive={canDelete(user?.role)}
          canEdit={canWrite(user?.role)}
          onZoomTo={(center) => setFlyTarget(center)}
        />
      )}
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string | number; accent: string }) {
  return (
    <div className="relative rounded-md bg-gray-50 p-2 pl-3 overflow-hidden">
      <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: accent }} />
      <p className="text-[10px] text-gray-500 leading-tight">{label}</p>
      <p className="text-base font-bold text-navy leading-tight">{value}</p>
    </div>
  );
}
