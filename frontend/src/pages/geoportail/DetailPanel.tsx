import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import L from "leaflet";
import {
  X, Printer, Pencil, History, Download, ZoomIn, Route as RouteIcon,
  Landmark, ShieldAlert, Building2, HardHat, MapPin, Info, Wrench,
  Layers, Clock, Camera, FileText, BarChart2,
  Copy, Check, AlertTriangle, Trash2, ChevronLeft, ChevronRight, Save,
} from "lucide-react";
import { EtatBadge } from "../../components/ui/Badge";
import { PhotoGallery } from "../../components/PhotoGallery";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Input";
import { useEntityMutations } from "../../hooks/useEntity";
import { printFiche } from "../../lib/print";
import { useConfirm } from "../../hooks/useConfirm";
import { api } from "../../lib/api";
import { ETAT_COLORS, ETAT_LABELS, CHANTIER_COLORS } from "./types";
import type { SelectedFeature, TronconGeoFeature } from "./types";
import type { EtatPatrimoine, StatutChantier, Ouvrage, PointNoir, Poste, Chantier, Inspection, Document } from "../../types";

// ── Helpers ──────────────────────────────────────────────────────────────────

const CLASSE_LABELS: Record<string, string> = {
  RN: "Route Nationale",
  RR: "Route Préfectorale",
  RU: "Voirie Urbaine",
  PISTE: "Piste Rurale",
};

const REVETEMENT_LABELS: Record<string, string> = {
  BITUME: "Bitume",
  TERRE: "Terre",
  LATERITE: "Latérite",
  PAVE: "Pavé",
};

const STATUT_LABELS: Record<StatutChantier, string> = {
  PLANIFIE: "Planifié", EN_COURS: "En cours", SUSPENDU: "Suspendu", TERMINE: "Terminé",
};

const TYPE_OUVRAGE_LABELS: Record<string, string> = {
  PONT: "Pont", DALOT: "Dalot", BUSE: "Buse", RADIER: "Radier", PONCEAU: "Ponceau",
  MUR_SOUTENEMENT: "Mur de soutènement", TUNNEL: "Tunnel", PASSERELLE: "Passerelle", VIADUC: "Viaduc",
};

function fmtPk(pk: number | null | undefined) {
  if (pk == null) return "—";
  const km = Math.floor(pk);
  const m = Math.round((pk - km) * 1000);
  return `PK ${km}+${String(m).padStart(3, "0")}`;
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function exportGeoJSON(data: TronconGeoFeature) {
  const feat = {
    type: "Feature",
    properties: { code: data.code, nom: data.nom, classe: data.classe, etat: data.etat, longueurKm: data.longueurKm },
    geometry: JSON.parse(data.geometry),
  };
  const blob = new Blob([JSON.stringify(feat, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `troncon-${data.code}.geojson`; a.click();
  URL.revokeObjectURL(url);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function InfoRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  if (value == null || value === "" || value === "—") return null;
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-gray-50 last:border-0">
      <span className="text-xs text-gray-500 shrink-0 pt-0.5">{label}</span>
      <span className={`text-sm font-medium text-navy text-right ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3 mt-4 first:mt-0">
      <span className="text-navy">{icon}</span>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">{title}</h4>
    </div>
  );
}

function StatCard({ label, value, color = "#1a2942", sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <div className="relative rounded-lg bg-gray-50 p-3 pl-3.5 overflow-hidden">
      <span className="absolute inset-y-0 left-0 w-1 rounded-l-lg" style={{ backgroundColor: color }} />
      <p className="text-[10px] text-gray-500 leading-tight">{label}</p>
      <p className="text-base font-bold text-navy">{value}</p>
      {sub && <p className="text-[10px] text-gray-400">{sub}</p>}
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="ml-1 inline-flex items-center text-gray-400 hover:text-navy"
      onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

// Vanilla Leaflet mini-map (avoids nested react-leaflet MapContainer issues)
function MiniMap({ geom, lat, lon }: { geom?: string | null; lat?: number | null; lon?: number | null }) {
  const divRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const map = L.map(el, {
      zoomControl: false, scrollWheelZoom: false, dragging: false,
      doubleClickZoom: false, attributionControl: false,
    });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { crossOrigin: "anonymous" }).addTo(map);

    if (geom) {
      try {
        const g = JSON.parse(geom);
        const layer = L.geoJSON(g, { style: { color: "#1a2942", weight: 4, opacity: 0.9 } }).addTo(map);
        map.fitBounds(layer.getBounds(), { padding: [16, 16] });
      } catch {/* ignore */ }
    } else if (lat != null && lon != null) {
      L.circleMarker([lat, lon], { radius: 8, color: "#1a2942", fillColor: "#f5a623", fillOpacity: 1, weight: 2 }).addTo(map);
      map.setView([lat, lon], 14);
    }

    return () => { map.remove(); };
  }, [geom, lat, lon]);

  return (
    <div ref={divRef} className="h-[180px] w-full rounded-lg overflow-hidden border border-gray-200 z-0" />
  );
}

// Timeline entry for audit/history
function AuditEntry({ action, auteur, createdAt, before, after }: {
  action: string; auteur: string; createdAt: string; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null;
}) {
  const [open, setOpen] = useState(false);
  const hasDetails = before || after;
  return (
    <div className="relative pl-5">
      <span className="absolute left-0 top-1.5 h-2 w-2 rounded-full bg-navy" />
      <span className="absolute left-1 top-3.5 bottom-0 w-px bg-gray-100" />
      <div className="pb-4">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-navy">{action}</span>
          <span className="text-[11px] text-gray-400 shrink-0">{fmtDate(createdAt)}</span>
        </div>
        <p className="text-xs text-gray-500">{auteur}</p>
        {hasDetails && (
          <button className="text-[11px] text-navy mt-1 underline" onClick={() => setOpen((v) => !v)}>
            {open ? "Masquer les détails" : "Voir les modifications"}
          </button>
        )}
        {open && (
          <pre className="mt-1 text-[10px] text-gray-600 bg-gray-50 rounded p-2 overflow-x-auto max-h-24">
            {JSON.stringify({ avant: before, après: after }, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

// ── Fiche type (tronçon) ──────────────────────────────────────────────────────

interface TronconFiche {
  troncon: {
    id: string; code: string; nom: string; classe: string; etat: EtatPatrimoine;
    longueurKm: number; revetement: string; pkDebut: number; pkFin: number;
    traficMoyenJma?: number | null; prefecture?: string | null; commune?: string | null;
    observations?: string | null; createdAt: string; updatedAt: string;
    region: { nom: string } | null;
  };
  ouvrages: Ouvrage[];
  pointsNoirs: PointNoir[];
  postes: Poste[];
  chantiers: Chantier[];
  inspections: (Inspection & { inspecteur: { nomComplet: string } })[];
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

type TronconTab = "info" | "localisation" | "technique" | "etat" | "patrimoine" | "chantiers" | "photos" | "documents" | "historique" | "stats";
type OuvrageTab = "info" | "localisation" | "technique" | "etat" | "photos" | "documents" | "historique";

const TRONCON_TABS: { key: TronconTab; icon: React.ReactNode; label: string }[] = [
  { key: "info", icon: <Info className="h-3.5 w-3.5" />, label: "Infos" },
  { key: "localisation", icon: <MapPin className="h-3.5 w-3.5" />, label: "Localisation" },
  { key: "technique", icon: <Wrench className="h-3.5 w-3.5" />, label: "Technique" },
  { key: "etat", icon: <AlertTriangle className="h-3.5 w-3.5" />, label: "État" },
  { key: "patrimoine", icon: <Layers className="h-3.5 w-3.5" />, label: "Patrimoine" },
  { key: "chantiers", icon: <HardHat className="h-3.5 w-3.5" />, label: "Chantiers" },
  { key: "photos", icon: <Camera className="h-3.5 w-3.5" />, label: "Photos" },
  { key: "documents", icon: <FileText className="h-3.5 w-3.5" />, label: "Docs" },
  { key: "historique", icon: <History className="h-3.5 w-3.5" />, label: "Historique" },
  { key: "stats", icon: <BarChart2 className="h-3.5 w-3.5" />, label: "Stats" },
];

const OUVRAGE_TABS: { key: OuvrageTab; icon: React.ReactNode; label: string }[] = [
  { key: "info", icon: <Info className="h-3.5 w-3.5" />, label: "Infos" },
  { key: "localisation", icon: <MapPin className="h-3.5 w-3.5" />, label: "Localisation" },
  { key: "technique", icon: <Wrench className="h-3.5 w-3.5" />, label: "Technique" },
  { key: "etat", icon: <AlertTriangle className="h-3.5 w-3.5" />, label: "État" },
  { key: "photos", icon: <Camera className="h-3.5 w-3.5" />, label: "Photos" },
  { key: "documents", icon: <FileText className="h-3.5 w-3.5" />, label: "Docs" },
  { key: "historique", icon: <History className="h-3.5 w-3.5" />, label: "Historique" },
];

function TabBar<T extends string>({ tabs, active, onChange }: {
  tabs: { key: T; icon: React.ReactNode; label: string }[];
  active: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="flex overflow-x-auto scrollbar-none border-b border-gray-100 bg-white shrink-0">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`flex items-center gap-1.5 px-3 py-2.5 text-xs whitespace-nowrap border-b-2 -mb-px shrink-0 transition-colors ${
            active === t.key
              ? "border-[#f5a623] text-navy font-semibold"
              : "border-transparent text-gray-500 hover:text-navy hover:border-gray-200"
          }`}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Audit hook ────────────────────────────────────────────────────────────────

function useAudit(entityType: string, entityId: string) {
  return useQuery({
    queryKey: ["audit", entityType, entityId],
    queryFn: async () => {
      const { data } = await api.get("/audit", { params: { entityType, entityId, pageSize: 30 } });
      return data as { data: { id: string; action: string; auteur: string; createdAt: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[] };
    },
    staleTime: 30_000,
  });
}

// ── Documents hook ────────────────────────────────────────────────────────────

function useDocuments(tronconId?: string, ouvrageId?: string) {
  const param = tronconId ? `tronconId=${tronconId}` : ouvrageId ? `ouvrageId=${ouvrageId}` : null;
  return useQuery({
    queryKey: ["documents", "linked", tronconId ?? ouvrageId],
    queryFn: async () => {
      const { data } = await api.get<{ data: Document[] }>(`/documents?${param}&pageSize=50`);
      return data.data;
    },
    enabled: !!param,
    staleTime: 60_000,
  });
}

// ── Main component ────────────────────────────────────────────────────────────

export function DetailPanel({
  feature, onClose, onArchive, canArchive, canEdit, onZoomTo,
}: {
  feature: SelectedFeature;
  onClose: () => void;
  onArchive?: () => void;
  canArchive?: boolean;
  canEdit?: boolean;
  onZoomTo?: (center: [number, number]) => void;
}) {
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const tronconsMut = useEntityMutations("troncons");
  const chantiersMut = useEntityMutations("chantiers");

  // Tab state per entity type
  const [tronconTab, setTronconTab] = useState<TronconTab>("info");
  const [ouvrageTab, setOuvrageTab] = useState<OuvrageTab>("info");

  // Panel UI state
  const [isEditing, setIsEditing] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [editDraft, setEditDraft] = useState<Record<string, unknown>>({});

  // Quick edit state
  const [etatDraft, setEtatDraft] = useState<EtatPatrimoine | null>(null);
  const [statutDraft, setStatutDraft] = useState<StatutChantier | null>(null);
  const [avancementDraft, setAvancementDraft] = useState<number | null>(null);
  const [chantierOpen, setChantierOpen] = useState(false);
  const [chantierIntitule, setChantierIntitule] = useState("");
  const [chantierEntreprise, setChantierEntreprise] = useState("");
  const chantiersCreateMut = useEntityMutations("chantiers").create;

  // Safe id (toponyme has no id)
  const featureId = feature.kind !== "toponyme" ? feature.data.id : "";
  const tronconId = feature.kind === "troncon" ? feature.data.id : null;

  // Fiche data (tronçon only)
  const { data: fiche } = useQuery<TronconFiche>({
    queryKey: ["troncons", "fiche", tronconId],
    queryFn: async () => (await api.get(`/troncons/${tronconId}/fiche`)).data,
    enabled: feature.kind === "troncon",
    staleTime: 60_000,
  });

  // Audit log
  const entityTypeMap: Partial<Record<typeof feature.kind, string>> = {
    troncon: "Troncon", ouvrage: "Ouvrage", chantier: "Chantier",
    poste: "Poste", pointNoir: "PointNoir",
  };
  const auditEntityType = entityTypeMap[feature.kind] ?? "";
  const { data: auditData } = useAudit(auditEntityType, featureId);

  // Documents
  const { data: docs } = useDocuments(
    feature.kind === "troncon" ? feature.data.id : undefined,
    feature.kind === "ouvrage" ? feature.data.id : undefined,
  );

  async function saveTronconEtat() {
    if (feature.kind !== "troncon" || !etatDraft) return;
    await tronconsMut.update.mutateAsync({ id: feature.data.id, payload: { etat: etatDraft } });
    await qc.invalidateQueries({ queryKey: ["troncons", "geo"] });
    setEtatDraft(null);
  }

  async function saveChantierStatut() {
    if (feature.kind !== "chantier") return;
    const payload: Record<string, unknown> = {};
    if (statutDraft) payload.statut = statutDraft;
    if (avancementDraft != null) payload.avancementPct = avancementDraft;
    if (!Object.keys(payload).length) return;
    await chantiersMut.update.mutateAsync({ id: feature.data.id, payload });
    await qc.invalidateQueries({ queryKey: ["chantiers", "geo"] });
    setStatutDraft(null); setAvancementDraft(null);
  }

  async function signalerChantier() {
    if (feature.kind !== "troncon" || !chantierIntitule.trim() || !chantierEntreprise.trim()) return;
    await chantiersCreateMut.mutateAsync({
      intitule: chantierIntitule.trim(), entreprise: chantierEntreprise.trim(),
      tronconId: feature.data.id, statut: "EN_COURS", avancementPct: 0,
    });
    await qc.invalidateQueries({ queryKey: ["chantiers", "geo"] });
    setChantierOpen(false); setChantierIntitule(""); setChantierEntreprise("");
  }

  function startEdit() {
    if (feature.kind !== "troncon") return;
    const d = feature.data;
    setEditDraft({
      nom: d.nom,
      classe: d.classe,
      revetement: d.revetement ?? "",
      etat: d.etat,
      pkDebut: d.pkDebut,
      pkFin: d.pkFin,
      longueurKm: d.longueurKm,
      traficMoyenJma: d.traficMoyenJma ?? "",
      prefecture: fiche?.troncon.prefecture ?? "",
      commune: fiche?.troncon.commune ?? "",
      observations: fiche?.troncon.observations ?? "",
    });
    setIsEditing(true);
  }

  async function saveEdit() {
    if (feature.kind !== "troncon") return;
    const payload: Record<string, unknown> = { ...editDraft };
    if (payload.traficMoyenJma === "") payload.traficMoyenJma = null;
    else if (payload.traficMoyenJma !== null) payload.traficMoyenJma = Number(payload.traficMoyenJma);
    if (payload.prefecture === "") payload.prefecture = null;
    if (payload.commune === "") payload.commune = null;
    if (payload.observations === "") payload.observations = null;
    payload.pkDebut = Number(payload.pkDebut);
    payload.pkFin = Number(payload.pkFin);
    payload.longueurKm = Number(payload.longueurKm);
    await tronconsMut.update.mutateAsync({ id: feature.data.id, payload });
    await qc.invalidateQueries({ queryKey: ["troncons", "geo"] });
    await qc.invalidateQueries({ queryKey: ["troncons", "fiche", feature.data.id] });
    setIsEditing(false);
  }

  function renderEditForm() {
    if (feature.kind !== "troncon") return null;
    const setField = (field: string) =>
      (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        setEditDraft((prev) => ({ ...prev, [field]: e.target.value }));
    const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy/30";
    return (
      <div className="p-4 space-y-3">
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Nom</label>
          <input type="text" value={String(editDraft.nom ?? "")} onChange={setField("nom")} className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Classe</label>
            <select value={String(editDraft.classe ?? "")} onChange={setField("classe")} className={inputCls}>
              <option value="RN">Route Nationale</option>
              <option value="RR">Route Préfectorale</option>
              <option value="RU">Voirie Urbaine</option>
              <option value="PISTE">Piste Rurale</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Revêtement</label>
            <select value={String(editDraft.revetement ?? "")} onChange={setField("revetement")} className={inputCls}>
              <option value="BITUME">Bitume</option>
              <option value="TERRE">Terre</option>
              <option value="LATERITE">Latérite</option>
              <option value="PAVE">Pavé</option>
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">État</label>
          <select value={String(editDraft.etat ?? "")} onChange={setField("etat")} className={inputCls}>
            <option value="BON">Bon</option>
            <option value="MOYEN">Moyen</option>
            <option value="MAUVAIS">Mauvais</option>
            <option value="CRITIQUE">Critique</option>
            <option value="NON_EVALUE">Non évalué</option>
          </select>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">PK début</label>
            <input type="number" step="0.001" value={String(editDraft.pkDebut ?? "")} onChange={setField("pkDebut")} className={inputCls} />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">PK fin</label>
            <input type="number" step="0.001" value={String(editDraft.pkFin ?? "")} onChange={setField("pkFin")} className={inputCls} />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Longueur (km)</label>
            <input type="number" step="0.001" value={String(editDraft.longueurKm ?? "")} onChange={setField("longueurKm")} className={inputCls} />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Trafic moyen (véh/j)</label>
          <input type="number" value={String(editDraft.traficMoyenJma ?? "")} onChange={setField("traficMoyenJma")} className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Préfecture</label>
            <input type="text" value={String(editDraft.prefecture ?? "")} onChange={setField("prefecture")} className={inputCls} />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Commune</label>
            <input type="text" value={String(editDraft.commune ?? "")} onChange={setField("commune")} className={inputCls} />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Observations</label>
          <textarea value={String(editDraft.observations ?? "")} onChange={setField("observations")} rows={3} className={`${inputCls} resize-none`} />
        </div>
      </div>
    );
  }

  // ── Header info ──────────────────────────────────────────────────────────────

  const headerConfig = {
    troncon: {
      icon: <RouteIcon className="h-5 w-5" />,
      title: feature.kind === "troncon" ? feature.data.nom : "",
      subtitle: feature.kind === "troncon" ? `${CLASSE_LABELS[feature.data.classe] ?? feature.data.classe} — ${feature.data.code}` : "",
      etat: feature.kind === "troncon" ? feature.data.etat : "NON_EVALUE" as EtatPatrimoine,
      meta: feature.kind === "troncon"
        ? `${fmtPk(feature.data.pkDebut)} → ${fmtPk(feature.data.pkFin)} · ${feature.data.longueurKm.toFixed(2)} km`
        : "",
    },
    ouvrage: {
      icon: <Landmark className="h-5 w-5" />,
      title: feature.kind === "ouvrage" ? feature.data.nom : "",
      subtitle: feature.kind === "ouvrage" ? `${TYPE_OUVRAGE_LABELS[feature.data.type] ?? feature.data.type}${feature.data.code ? ` · ${feature.data.code}` : ""}` : "",
      etat: feature.kind === "ouvrage" ? feature.data.etat : "NON_EVALUE" as EtatPatrimoine,
      meta: feature.kind === "ouvrage" && feature.data.pk != null ? fmtPk(feature.data.pk) : "",
    },
    pointNoir: {
      icon: <ShieldAlert className="h-5 w-5" />,
      title: feature.kind === "pointNoir" ? feature.data.description : "",
      subtitle: "Point noir",
      etat: "CRITIQUE" as EtatPatrimoine,
      meta: feature.kind === "pointNoir" ? (feature.data.gravite === "FORTE" ? "Gravité élevée" : `Gravité ${feature.data.gravite.toLowerCase()}`) : "",
    },
    poste: {
      icon: <Building2 className="h-5 w-5" />,
      title: feature.kind === "poste" ? feature.data.nom : "",
      subtitle: feature.kind === "poste" ? `Poste de ${feature.data.type.toLowerCase()}` : "",
      etat: "BON" as EtatPatrimoine,
      meta: "",
    },
    chantier: {
      icon: <HardHat className="h-5 w-5" />,
      title: feature.kind === "chantier" ? feature.data.intitule : "",
      subtitle: feature.kind === "chantier" ? STATUT_LABELS[feature.data.statut] : "",
      etat: "NON_EVALUE" as EtatPatrimoine,
      meta: feature.kind === "chantier" ? `Avancement : ${feature.data.avancementPct}%` : "",
    },
    toponyme: {
      icon: <MapPin className="h-5 w-5" />,
      title: feature.kind === "toponyme" ? feature.data.nom : "",
      subtitle: feature.kind === "toponyme" ? feature.data.nature : "",
      etat: "NON_EVALUE" as EtatPatrimoine,
      meta: "",
    },
  }[feature.kind];

  const etatColor = ETAT_COLORS[headerConfig.etat];

  // ── Render content tabs ───────────────────────────────────────────────────────

  function renderTronconContent() {
    const d = feature.kind === "troncon" ? feature.data : null;
    if (!d) return null;
    const ft = fiche?.troncon;

    // Geometry analysis
    let geoCoords: number[][] = [];
    try { geoCoords = (JSON.parse(d.geometry) as { coordinates: number[][] }).coordinates; } catch {/* */ }
    const firstPt = geoCoords[0];
    const lastPt = geoCoords[geoCoords.length - 1];

    // Bounding box
    let bbox = { minLon: 0, minLat: 0, maxLon: 0, maxLat: 0 };
    if (geoCoords.length) {
      bbox = geoCoords.reduce(
        (acc, [lon, lat]) => ({
          minLon: Math.min(acc.minLon, lon), minLat: Math.min(acc.minLat, lat),
          maxLon: Math.max(acc.maxLon, lon), maxLat: Math.max(acc.maxLat, lat),
        }),
        { minLon: geoCoords[0][0], minLat: geoCoords[0][1], maxLon: geoCoords[0][0], maxLat: geoCoords[0][1] }
      );
    }

    switch (tronconTab) {
      case "info":
        return (
          <div>
            <SectionTitle icon={<Info className="h-3.5 w-3.5" />} title="Identification" />
            <InfoRow label="Code" value={<span className="font-mono">{d.code}</span>} />
            <InfoRow label="Nom" value={d.nom} />
            <InfoRow label="Classe" value={CLASSE_LABELS[d.classe] ?? d.classe} />
            <InfoRow label="Longueur" value={`${d.longueurKm.toFixed(3)} km`} />
            <InfoRow label="Revêtement" value={REVETEMENT_LABELS[d.revetement ?? ""] ?? d.revetement} />
            <InfoRow label="Trafic journalier" value={d.traficMoyenJma ? `${d.traficMoyenJma.toLocaleString("fr-FR")} véh/j` : null} />
            {ft && (
              <>
                <InfoRow label="Préfecture" value={ft.prefecture} />
                <InfoRow label="Commune" value={ft.commune} />
              </>
            )}
            {ft?.observations && (
              <div className="mt-3 p-3 bg-amber-50 rounded-lg border border-amber-100">
                <p className="text-xs font-semibold text-amber-700 mb-1">Observations</p>
                <p className="text-sm text-amber-800">{ft.observations}</p>
              </div>
            )}
            {ft && (
              <>
                <SectionTitle icon={<Clock className="h-3.5 w-3.5" />} title="Métadonnées" />
                <InfoRow label="Créé le" value={fmtDate(ft.createdAt)} />
                <InfoRow label="Mis à jour" value={fmtDate(ft.updatedAt)} />
              </>
            )}
          </div>
        );

      case "localisation":
        return (
          <div>
            <SectionTitle icon={<MapPin className="h-3.5 w-3.5" />} title="Position géographique" />
            <InfoRow label="Région" value={d.region ?? "—"} />
            {ft && <InfoRow label="Préfecture" value={ft.prefecture} />}
            <InfoRow label="PK début" value={fmtPk(d.pkDebut)} />
            <InfoRow label="PK fin" value={fmtPk(d.pkFin)} />
            <InfoRow label="Longueur" value={`${d.longueurKm.toFixed(3)} km`} />
            {firstPt && (
              <div className="flex items-center justify-between py-2 border-b border-gray-50">
                <span className="text-xs text-gray-500">Départ</span>
                <span className="font-mono text-xs text-navy">
                  {firstPt[1].toFixed(5)}, {firstPt[0].toFixed(5)}
                  <CopyButton value={`${firstPt[1].toFixed(5)}, ${firstPt[0].toFixed(5)}`} />
                </span>
              </div>
            )}
            {lastPt && (
              <div className="flex items-center justify-between py-2 border-b border-gray-50">
                <span className="text-xs text-gray-500">Arrivée</span>
                <span className="font-mono text-xs text-navy">
                  {lastPt[1].toFixed(5)}, {lastPt[0].toFixed(5)}
                  <CopyButton value={`${lastPt[1].toFixed(5)}, ${lastPt[0].toFixed(5)}`} />
                </span>
              </div>
            )}
            <div className="mt-4">
              <p className="text-xs text-gray-500 mb-2">Aperçu cartographique</p>
              <MiniMap geom={d.geometry} />
            </div>
          </div>
        );

      case "technique":
        return (
          <div>
            <SectionTitle icon={<Wrench className="h-3.5 w-3.5" />} title="Caractéristiques de chaussée" />
            <InfoRow label="Revêtement" value={REVETEMENT_LABELS[d.revetement ?? ""] ?? d.revetement} />
            <InfoRow label="Trafic moyen journalier" value={d.traficMoyenJma ? `${d.traficMoyenJma.toLocaleString("fr-FR")} véh/j` : "—"} />
            <div className="mt-3 p-3 rounded-lg bg-gray-50 border border-dashed border-gray-200 text-xs text-gray-400 text-center">
              Largeur chaussée, nbre de voies, drainage, vitesse de référence… — à compléter dans une prochaine version
            </div>
            <SectionTitle icon={<Layers className="h-3.5 w-3.5" />} title="Géométrie" />
            <InfoRow label="Nb de sommets" value={geoCoords.length} />
            <InfoRow label="Type" value="LineString (WGS 84 / EPSG:4326)" />
            <InfoRow label="Longueur réelle" value={`${d.longueurKm.toFixed(3)} km`} />
            <InfoRow label="Bbox min" value={geoCoords.length ? `${bbox.minLat.toFixed(5)}, ${bbox.minLon.toFixed(5)}` : "—"} mono />
            <InfoRow label="Bbox max" value={geoCoords.length ? `${bbox.maxLat.toFixed(5)}, ${bbox.maxLon.toFixed(5)}` : "—"} mono />
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => exportGeoJSON(d)}
                className="flex items-center gap-1.5 text-xs text-navy border border-navy/20 rounded-lg px-3 py-1.5 hover:bg-navy/5"
              >
                <Download className="h-3 w-3" /> GeoJSON
              </button>
              <button className="flex items-center gap-1.5 text-xs text-gray-400 border border-gray-200 rounded-lg px-3 py-1.5 cursor-not-allowed" title="Bientôt disponible">
                <Download className="h-3 w-3" /> Shapefile (bientôt)
              </button>
            </div>
          </div>
        );

      case "etat":
        return (
          <div>
            <SectionTitle icon={<AlertTriangle className="h-3.5 w-3.5" />} title="État observé" />
            <div className="flex items-center gap-3 p-3 rounded-lg mb-4" style={{ backgroundColor: `${etatColor}15`, border: `1px solid ${etatColor}30` }}>
              <span className="h-4 w-4 rounded-full shrink-0" style={{ backgroundColor: etatColor }} />
              <div>
                <p className="text-sm font-semibold text-navy">{ETAT_LABELS[d.etat]}</p>
                <p className="text-xs text-gray-500">Dernier état constaté</p>
              </div>
            </div>
            {canEdit && (
              <div className="mb-4">
                <p className="text-xs font-medium text-gray-600 mb-2">Mettre à jour l'état</p>
                <div className="flex gap-2">
                  <Select value={etatDraft ?? d.etat} onChange={(e) => setEtatDraft(e.target.value as EtatPatrimoine)} className="flex-1">
                    {Object.entries(ETAT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </Select>
                  <Button size="sm" disabled={!etatDraft || etatDraft === d.etat || tronconsMut.update.isPending} onClick={saveTronconEtat}>
                    Enregistrer
                  </Button>
                </div>
              </div>
            )}
            {fiche?.inspections && fiche.inspections.length > 0 && (
              <>
                <SectionTitle icon={<History className="h-3.5 w-3.5" />} title={`Inspections (${fiche.inspections.length})`} />
                <div className="space-y-1 mb-4">
                  {fiche.inspections.map((insp) => (
                    <div key={insp.id} className="flex items-center gap-2 p-2 rounded-lg bg-gray-50 border border-gray-100">
                      <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: ETAT_COLORS[insp.etatObserve] }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-navy">{ETAT_LABELS[insp.etatObserve]}</p>
                        <p className="text-[11px] text-gray-500 truncate">{insp.inspecteur?.nomComplet} · {fmtDate(insp.dateInspection)}</p>
                        {insp.defautsConstates && <p className="text-[11px] text-gray-400 truncate">{insp.defautsConstates}</p>}
                      </div>
                    </div>
                  ))}
                </div>
                {/* Mini chart */}
                <SectionTitle icon={<BarChart2 className="h-3.5 w-3.5" />} title="Évolution des inspections" />
                <div className="space-y-1.5">
                  {fiche.inspections.slice(0, 6).reverse().map((insp, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-400 w-20 text-right">{new Date(insp.dateInspection).toLocaleDateString("fr-FR", { month: "short", year: "2-digit" })}</span>
                      <div className="flex-1 h-3 rounded bg-gray-100 overflow-hidden">
                        <div className="h-full rounded" style={{ width: "100%", backgroundColor: ETAT_COLORS[insp.etatObserve] }} />
                      </div>
                      <span className="text-[10px] text-gray-500 w-20 truncate">{ETAT_LABELS[insp.etatObserve].split(" ")[0]}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        );

      case "patrimoine":
        const ouvrages = fiche?.ouvrages ?? [];
        const postes = fiche?.postes ?? [];
        const pns = fiche?.pointsNoirs ?? [];
        return (
          <div>
            <SectionTitle icon={<Landmark className="h-3.5 w-3.5" />} title={`Ouvrages d'art (${ouvrages.length})`} />
            {ouvrages.length === 0 ? (
              <p className="text-sm text-gray-400 italic mb-3">Aucun ouvrage référencé sur ce tronçon</p>
            ) : (
              <div className="space-y-1.5 mb-4">
                {ouvrages.map((o) => (
                  <div key={o.id} className="flex items-center gap-2.5 p-2.5 rounded-lg bg-gray-50 border border-gray-100 cursor-pointer hover:border-navy/20">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: ETAT_COLORS[o.etat] }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-navy truncate">{o.nom}</p>
                      <p className="text-[11px] text-gray-500">{TYPE_OUVRAGE_LABELS[o.type] ?? o.type}{o.pk != null ? ` · ${fmtPk(o.pk)}` : ""}{o.longueurM ? ` · ${o.longueurM} m` : ""}</p>
                    </div>
                    <EtatBadge etat={o.etat} />
                  </div>
                ))}
              </div>
            )}
            <SectionTitle icon={<Building2 className="h-3.5 w-3.5" />} title={`Postes péage/pesage (${postes.length})`} />
            {postes.length === 0 ? (
              <p className="text-sm text-gray-400 italic mb-3">Aucun poste</p>
            ) : (
              <div className="space-y-1 mb-4">
                {postes.map((p) => (
                  <div key={p.id} className="flex items-center justify-between p-2 rounded bg-gray-50 border border-gray-100">
                    <span className="text-sm text-navy">{p.nom}</span>
                    <span className="text-xs text-gray-500">{p.type}{p.pk != null ? ` · ${fmtPk(p.pk)}` : ""}</span>
                  </div>
                ))}
              </div>
            )}
            <SectionTitle icon={<ShieldAlert className="h-3.5 w-3.5" />} title={`Points noirs (${pns.length})`} />
            {pns.length === 0 ? (
              <p className="text-sm text-gray-400 italic">Aucun point noir</p>
            ) : (
              <div className="space-y-1">
                {pns.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 p-2 rounded bg-gray-50 border border-gray-100">
                    <span className={`h-2 w-2 rounded-full ${p.gravite === "FORTE" ? "bg-red-500" : p.gravite === "MOYENNE" ? "bg-orange-400" : "bg-yellow-400"}`} />
                    <p className="text-xs text-navy truncate flex-1">{p.description}</p>
                    <span className="text-[10px] text-gray-400">{p.gravite}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case "chantiers":
        const chantiers = fiche?.chantiers ?? [];
        return (
          <div>
            <SectionTitle icon={<HardHat className="h-3.5 w-3.5" />} title={`Chantiers associés (${chantiers.length})`} />
            {chantiers.length > 0 && (
              <div className="space-y-2 mb-4">
                {chantiers.map((c) => (
                  <div key={c.id} className="p-3 rounded-lg border border-gray-100 bg-gray-50">
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <p className="text-sm font-medium text-navy leading-tight">{c.intitule}</p>
                      <span className="text-xs px-2 py-0.5 rounded-full text-white shrink-0" style={{ backgroundColor: CHANTIER_COLORS[c.statut] }}>
                        {STATUT_LABELS[c.statut]}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="flex-1 h-1.5 rounded-full bg-gray-200">
                        <div className="h-full rounded-full bg-navy/70" style={{ width: `${c.avancementPct}%` }} />
                      </div>
                      <span className="text-xs text-gray-500 shrink-0">{c.avancementPct}%</span>
                    </div>
                    {c.entreprise && <p className="text-[11px] text-gray-500">{c.entreprise}</p>}
                    {c.montantGnf && <p className="text-[11px] text-gray-400">{Number(c.montantGnf).toLocaleString("fr-FR")} GNF</p>}
                  </div>
                ))}
              </div>
            )}
            {canEdit && (
              <div className="border-t border-gray-100 pt-3">
                {!chantierOpen ? (
                  <button onClick={() => setChantierOpen(true)} className="w-full text-sm text-navy border border-dashed border-navy/30 rounded-lg py-2 hover:bg-navy/5">
                    + Signaler des travaux
                  </button>
                ) : (
                  <div className="space-y-2">
                    <input value={chantierIntitule} onChange={(e) => setChantierIntitule(e.target.value)} placeholder="Intitulé" className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                    <input value={chantierEntreprise} onChange={(e) => setChantierEntreprise(e.target.value)} placeholder="Entreprise" className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={!chantierIntitule.trim() || !chantierEntreprise.trim() || chantiersCreateMut.isPending} onClick={signalerChantier}>Enregistrer</Button>
                      <Button size="sm" variant="ghost" onClick={() => setChantierOpen(false)}>Annuler</Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );

      case "photos":
        return <PhotoGallery endpoint="troncons" entityId={d.id} canWrite={!!canEdit} />;

      case "documents":
        return renderDocuments();

      case "historique":
        return renderHistorique();

      case "stats":
        const f = fiche;
        return (
          <div>
            <SectionTitle icon={<BarChart2 className="h-3.5 w-3.5" />} title="Statistiques du tronçon" />
            <div className="grid grid-cols-2 gap-2 mb-4">
              <StatCard label="Longueur" value={`${d.longueurKm.toFixed(1)} km`} color="#1a2942" />
              <StatCard label="Ouvrages" value={f?.ouvrages.length ?? 0} color="#7c3aed" />
              <StatCard label="Points noirs" value={f?.pointsNoirs.length ?? 0} color="#dc2626" />
              <StatCard label="Chantiers" value={f?.chantiers.length ?? 0} color="#f5a623" />
              <StatCard label="Inspections" value={f?.inspections.length ?? 0} color="#0891b2" />
              <StatCard label="Postes" value={f?.postes.length ?? 0} color="#059669" />
            </div>
            {f?.inspections && f.inspections.length > 0 && (
              <>
                <SectionTitle icon={<AlertTriangle className="h-3.5 w-3.5" />} title="Répartition par état observé" />
                {(() => {
                  const counts = f.inspections.reduce((acc, i) => { acc[i.etatObserve] = (acc[i.etatObserve] ?? 0) + 1; return acc; }, {} as Record<EtatPatrimoine, number>);
                  const total = f.inspections.length;
                  return (
                    <div className="space-y-1.5">
                      {(Object.entries(counts) as [EtatPatrimoine, number][]).map(([etat, n]) => (
                        <div key={etat} className="flex items-center gap-2 text-xs">
                          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: ETAT_COLORS[etat] }} />
                          <span className="flex-1 text-gray-600">{ETAT_LABELS[etat]}</span>
                          <div className="w-24 h-2 rounded-full bg-gray-100 overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${(n / total) * 100}%`, backgroundColor: ETAT_COLORS[etat] }} />
                          </div>
                          <span className="text-gray-500 w-4 text-right">{n}</span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        );

      default: return null;
    }
  }

  function renderOuvrageContent() {
    const d = feature.kind === "ouvrage" ? feature.data : null;
    if (!d) return null;
    switch (ouvrageTab) {
      case "info":
        return (
          <div>
            <SectionTitle icon={<Info className="h-3.5 w-3.5" />} title="Identification" />
            <InfoRow label="Nom" value={d.nom} />
            <InfoRow label="Type" value={TYPE_OUVRAGE_LABELS[d.type] ?? d.type} />
            <InfoRow label="Code" value={d.code} />
            <InfoRow label="Fiche n°" value={d.ficheNumero} />
            <InfoRow label="Tronçon" value={d.tronconCode ? `${d.tronconCode} — ${d.tronconNom}` : null} />
          </div>
        );
      case "localisation":
        return (
          <div>
            <SectionTitle icon={<MapPin className="h-3.5 w-3.5" />} title="Localisation" />
            <InfoRow label="Région" value={d.region ?? "—"} />
            <InfoRow label="Tronçon" value={d.tronconCode ? `${d.tronconCode}` : null} />
            <InfoRow label="PK" value={d.pk != null ? fmtPk(d.pk) : null} />
            {d.lat != null && d.lon != null && (
              <div className="flex items-center justify-between py-2 border-b border-gray-50">
                <span className="text-xs text-gray-500">Coordonnées GPS</span>
                <span className="font-mono text-xs text-navy">
                  {d.lat.toFixed(5)}, {d.lon.toFixed(5)}
                  <CopyButton value={`${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}`} />
                </span>
              </div>
            )}
            {d.lat != null && d.lon != null && (
              <div className="mt-4"><MiniMap lat={d.lat} lon={d.lon} /></div>
            )}
          </div>
        );
      case "technique":
        return (
          <div>
            <SectionTitle icon={<Wrench className="h-3.5 w-3.5" />} title="Dimensions" />
            <InfoRow label="Longueur" value={d.longueurM ? `${d.longueurM} m` : null} />
            <InfoRow label="Largeur" value={d.largeurM ? `${d.largeurM} m` : null} />
            <InfoRow label="Hauteur" value={d.hauteurM ? `${d.hauteurM} m` : null} />
            <InfoRow label="Gabarit" value={d.gabaritT ? `${d.gabaritT} t` : null} />
            <InfoRow label="Nb travées" value={d.nbTravees} />
            <InfoRow label="Longueur travée" value={d.longueurTravee ? `${d.longueurTravee} m` : null} />
            <SectionTitle icon={<Layers className="h-3.5 w-3.5" />} title="Matériaux" />
            <InfoRow label="Appuis" value={d.materiauAppuis} />
            <InfoRow label="Tablier" value={d.materiauTablier} />
            <InfoRow label="Piles" value={d.materiauPiles} />
            <InfoRow label="Autre" value={d.materiauAutre} />
            <SectionTitle icon={<Clock className="h-3.5 w-3.5" />} title="Histoire" />
            <InfoRow label="Année construction" value={d.anneeConstruction} />
            {d.remarques && (
              <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-100">
                <p className="text-xs font-semibold text-blue-700 mb-1">Remarques</p>
                <p className="text-sm text-blue-800">{d.remarques}</p>
              </div>
            )}
            {d.travauxAPrevoir && (
              <div className="mt-2 p-3 bg-orange-50 rounded-lg border border-orange-100">
                <p className="text-xs font-semibold text-orange-700 mb-1">Travaux à prévoir</p>
                <p className="text-sm text-orange-800">{d.travauxAPrevoir}</p>
              </div>
            )}
          </div>
        );
      case "etat":
        return (
          <div>
            <SectionTitle icon={<AlertTriangle className="h-3.5 w-3.5" />} title="État observé" />
            <div className="flex items-center gap-3 p-3 rounded-lg mb-4" style={{ backgroundColor: `${ETAT_COLORS[d.etat]}15`, border: `1px solid ${ETAT_COLORS[d.etat]}30` }}>
              <span className="h-4 w-4 rounded-full shrink-0" style={{ backgroundColor: ETAT_COLORS[d.etat] }} />
              <div>
                <p className="text-sm font-semibold text-navy">{ETAT_LABELS[d.etat]}</p>
                {d.derniereInspectionDate && <p className="text-xs text-gray-500">Inspecté le {fmtDate(d.derniereInspectionDate)}</p>}
              </div>
            </div>
          </div>
        );
      case "photos":
        return <PhotoGallery endpoint="ouvrages" entityId={d.id} canWrite={!!canEdit} />;
      case "documents":
        return renderDocuments();
      case "historique":
        return renderHistorique();
      default: return null;
    }
  }

  function renderDocuments() {
    if (!docs) return <p className="text-sm text-gray-400 py-4 text-center">Chargement…</p>;
    if (docs.length === 0) return <p className="text-sm text-gray-400 italic">Aucun document lié</p>;
    const TYPE_LABELS: Record<string, string> = {
      ARRETE: "Arrêté", CAHIER_CHARGES: "Cahier des charges", CAHIER_ENGAGEMENT: "Cahier d'engagement", AUTRE: "Autre",
    };
    return (
      <div className="space-y-2">
        {docs.map((doc) => (
          <div key={doc.id} className="flex items-center gap-2.5 p-2.5 rounded-lg bg-gray-50 border border-gray-100">
            <FileText className="h-4 w-4 text-navy shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-navy truncate">{doc.titre}</p>
              <p className="text-[11px] text-gray-500">{TYPE_LABELS[doc.type] ?? doc.type} · {fmtDate(doc.createdAt)}</p>
            </div>
            <a href={`/api/documents/${doc.id}/download`} download={doc.fileName} className="p-1.5 text-navy hover:bg-navy/10 rounded">
              <Download className="h-3.5 w-3.5" />
            </a>
          </div>
        ))}
      </div>
    );
  }

  function renderHistorique() {
    const entries = auditData?.data ?? [];
    if (entries.length === 0) return <p className="text-sm text-gray-400 italic py-4 text-center">Aucun historique disponible</p>;
    return (
      <div className="mt-2">
        {entries.map((e) => (
          <AuditEntry key={e.id} action={e.action} auteur={e.auteur} createdAt={e.createdAt} before={e.before} after={e.after} />
        ))}
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────────

  // Minimized strip
  if (isMinimized) {
    return (
      <div className="absolute right-0 top-0 h-full w-10 shadow-2xl z-[900] flex flex-col items-center py-3 gap-2 border-l border-white/10" style={{ background: "linear-gradient(180deg, #1a2942 0%, #2d4a6b 100%)" }}>
        <button onClick={() => setIsMinimized(false)} title="Afficher le panneau" className="p-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex-1 flex items-center justify-center">
          <span className="text-white/40 text-[10px] uppercase tracking-widest" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
            {feature.kind === "troncon" ? feature.data.nom.slice(0, 20) : feature.kind}
          </span>
        </div>
        <button onClick={onClose} title="Fermer" className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="absolute right-0 top-0 h-full w-[520px] bg-white shadow-2xl z-[900] flex flex-col border-l border-gray-200">
      {/* ── Header ── */}
      <div className="relative shrink-0" style={{ background: "linear-gradient(135deg, #1a2942 0%, #2d4a6b 100%)" }}>
        <div className="absolute top-3 right-3 flex items-center gap-1">
          <button onClick={() => setIsMinimized(true)} title="Réduire" className="p-1.5 rounded-lg hover:bg-white/10 text-white/70 hover:text-white">
            <ChevronRight className="h-4 w-4" />
          </button>
          <button onClick={onClose} title="Fermer" className="p-1.5 rounded-lg hover:bg-white/10 text-white/70 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-white/10 text-white shrink-0 mt-0.5">{headerConfig.icon}</div>
            <div className="flex-1 min-w-0">
              <p className="text-white/60 text-[11px] font-medium uppercase tracking-wider mb-0.5">{headerConfig.subtitle}</p>
              <h2 className="text-white font-semibold text-base leading-tight pr-8">{headerConfig.title}</h2>
              {headerConfig.meta && <p className="text-white/50 text-xs mt-1">{headerConfig.meta}</p>}
            </div>
          </div>

          {feature.kind !== "toponyme" && (
            <div className="flex items-center gap-2 mt-3">
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold text-white"
                style={{ backgroundColor: `${etatColor}cc` }}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-white" />
                {ETAT_LABELS[headerConfig.etat]}
              </span>
              {feature.kind === "troncon" && (
                <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-white/10 text-white/80">
                  {REVETEMENT_LABELS[feature.data.revetement ?? ""] ?? feature.data.revetement}
                </span>
              )}
              {feature.kind === "chantier" && (
                <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-white/10 text-white/80">
                  {feature.data.avancementPct}%
                </span>
              )}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 px-4 pb-3 border-t border-white/10 pt-2.5">
          <button onClick={printFiche} title="Imprimer" className="flex items-center gap-1 text-white/60 hover:text-white text-[11px] px-2 py-1 rounded hover:bg-white/10">
            <Printer className="h-3 w-3" /> Imprimer
          </button>
          {canEdit && feature.kind === "troncon" && !isEditing && (
            <button onClick={startEdit} className="flex items-center gap-1 text-[#f5a623] hover:text-white text-[11px] px-2 py-1 rounded hover:bg-white/10 font-medium">
              <Pencil className="h-3 w-3" /> Modifier
            </button>
          )}
          {onZoomTo && feature.kind === "troncon" && (
            <button
              title="Zoomer"
              onClick={() => {
                try {
                  const coords = (JSON.parse(feature.data.geometry) as { coordinates: number[][] }).coordinates;
                  const mid = coords[Math.floor(coords.length / 2)];
                  onZoomTo([mid[1], mid[0]]);
                } catch {/* */ }
              }}
              className="flex items-center gap-1 text-white/60 hover:text-white text-[11px] px-2 py-1 rounded hover:bg-white/10"
            >
              <ZoomIn className="h-3 w-3" /> Zoom
            </button>
          )}
          {onZoomTo && (feature.kind === "ouvrage" || feature.kind === "poste" || feature.kind === "pointNoir") && (
            <button
              onClick={() => { const d = feature.data as { lat: number; lon: number }; if (d.lat && d.lon) onZoomTo([d.lat, d.lon]); }}
              className="flex items-center gap-1 text-white/60 hover:text-white text-[11px] px-2 py-1 rounded hover:bg-white/10"
            >
              <ZoomIn className="h-3 w-3" /> Zoom
            </button>
          )}
          {feature.kind === "troncon" && (
            <button onClick={() => exportGeoJSON(feature.data)} className="flex items-center gap-1 text-white/60 hover:text-white text-[11px] px-2 py-1 rounded hover:bg-white/10">
              <Download className="h-3 w-3" /> GeoJSON
            </button>
          )}
        </div>
      </div>

      {/* ── Tab bar (hidden in edit mode) ── */}
      {!isEditing && feature.kind === "troncon" && <TabBar tabs={TRONCON_TABS} active={tronconTab} onChange={setTronconTab} />}
      {!isEditing && feature.kind === "ouvrage" && <TabBar tabs={OUVRAGE_TABS} active={ouvrageTab} onChange={setOuvrageTab} />}

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto p-4">
        {isEditing && renderEditForm()}
        {!isEditing && feature.kind === "troncon" && renderTronconContent()}
        {!isEditing && feature.kind === "ouvrage" && renderOuvrageContent()}

        {feature.kind === "pointNoir" && (
          <div>
            <SectionTitle icon={<ShieldAlert className="h-3.5 w-3.5" />} title="Point noir" />
            <InfoRow label="Description" value={feature.data.description} />
            <InfoRow label="Gravité" value={feature.data.gravite} />
            <InfoRow label="Région" value={feature.data.region ?? "—"} />
            {feature.data.lat != null && feature.data.lon != null && (
              <>
                <div className="flex items-center justify-between py-2 border-b border-gray-50">
                  <span className="text-xs text-gray-500">Coordonnées</span>
                  <span className="font-mono text-xs text-navy">
                    {feature.data.lat.toFixed(5)}, {feature.data.lon.toFixed(5)}
                    <CopyButton value={`${feature.data.lat.toFixed(5)}, ${feature.data.lon.toFixed(5)}`} />
                  </span>
                </div>
                <div className="mt-4"><MiniMap lat={feature.data.lat} lon={feature.data.lon} /></div>
              </>
            )}
            {renderHistorique()}
          </div>
        )}

        {feature.kind === "poste" && (
          <div>
            <SectionTitle icon={<Building2 className="h-3.5 w-3.5" />} title="Poste" />
            <InfoRow label="Nom" value={feature.data.nom} />
            <InfoRow label="Type" value={feature.data.type} />
            <InfoRow label="Statut" value={feature.data.statut} />
            <InfoRow label="Région" value={feature.data.region ?? "—"} />
            {feature.data.lat != null && feature.data.lon != null && (
              <div className="mt-4"><MiniMap lat={feature.data.lat} lon={feature.data.lon} /></div>
            )}
          </div>
        )}

        {feature.kind === "toponyme" && (
          <div>
            <InfoRow label="Nature" value={feature.data.nature} />
            <div className="flex items-center justify-between py-2">
              <span className="text-xs text-gray-500">Coordonnées</span>
              <span className="font-mono text-xs text-navy">
                {feature.data.lat.toFixed(5)}, {feature.data.lon.toFixed(5)}
                <CopyButton value={`${feature.data.lat.toFixed(5)}, ${feature.data.lon.toFixed(5)}`} />
              </span>
            </div>
            <p className="text-[11px] text-gray-400 mt-2">Repère OpenStreetMap, à titre indicatif (non géré par AGEROUTE).</p>
          </div>
        )}

        {feature.kind === "chantier" && (
          <div>
            <SectionTitle icon={<HardHat className="h-3.5 w-3.5" />} title="Chantier" />
            <InfoRow label="Entreprise" value={feature.data.entreprise} />
            <InfoRow label="Bailleur" value={feature.data.bailleur} />
            <InfoRow label="N° contrat" value={feature.data.numContrat} />
            <InfoRow label="Montant" value={feature.data.montantGnf ? `${Number(feature.data.montantGnf).toLocaleString("fr-FR")} GNF` : null} />
            <InfoRow label="Région" value={feature.data.region ?? "—"} />
            <InfoRow label="Observations" value={feature.data.observations} />
            {feature.data.approximate && (
              <p className="text-[11px] text-gray-400 mt-2">📍 Position approximative — centre de la région</p>
            )}
            {canEdit && (
              <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Statut</label>
                  <Select value={statutDraft ?? feature.data.statut} onChange={(e) => setStatutDraft(e.target.value as StatutChantier)}>
                    {Object.entries(STATUT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </Select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Avancement (%)</label>
                  <input type="number" min={0} max={100} defaultValue={feature.data.avancementPct} onChange={(e) => setAvancementDraft(Number(e.target.value))} className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
                </div>
                <Button size="sm" className="w-full" disabled={(!statutDraft && avancementDraft == null) || chantiersMut.update.isPending} onClick={saveChantierStatut}>
                  Enregistrer
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Action bar ── */}
      {isEditing ? (
        <div className="shrink-0 border-t border-gray-100 px-4 py-2.5 bg-amber-50 flex items-center gap-2">
          <Button size="sm" disabled={tronconsMut.update.isPending} onClick={saveEdit} className="flex items-center gap-1.5">
            <Save className="h-3 w-3" />
            {tronconsMut.update.isPending ? "Enregistrement…" : "Enregistrer"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setIsEditing(false)}>Annuler</Button>
          <div className="flex-1" />
          <span className="text-[11px] text-amber-600 italic">Mode édition</span>
        </div>
      ) : (
        feature.kind !== "toponyme" && (
          <div className="shrink-0 border-t border-gray-100 px-4 py-2.5 bg-gray-50 flex items-center gap-2">
            {canEdit && feature.kind !== "chantier" && feature.kind !== "troncon" && (
              <button className="flex items-center gap-1.5 text-xs text-navy border border-navy/20 rounded-lg px-3 py-1.5 hover:bg-navy/5">
                <Pencil className="h-3 w-3" /> Modifier
              </button>
            )}
            {canArchive && onArchive && feature.kind !== "troncon" && (
              <button
                onClick={async () => { if (await confirm("Archiver cet élément ?", { danger: true })) onArchive(); }}
                className="flex items-center gap-1.5 text-xs text-red-600 border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-50"
              >
                <Trash2 className="h-3 w-3" /> Archiver
              </button>
            )}
            <div className="flex-1" />
            <button onClick={() => setIsMinimized(true)} title="Réduire" className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1.5">
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-700 px-3 py-1.5">Fermer</button>
          </div>
        )
      )}

      {confirmDialog}
    </div>
  );
}
