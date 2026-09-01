import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MapPin, Camera, X, CloudOff, CheckCircle2, ClipboardList } from "lucide-react";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { toast } from "../lib/toast";
import { addPendingInspection, getAllPending, type PendingInspection } from "../lib/offlineDb";
import { refreshPendingCount, syncPendingInspections } from "../lib/offlineSync";
import { useOfflineSync } from "../hooks/useOfflineSync";

// ── Cache local des référentiels (troncons/ouvrages) pour usage hors-ligne ────────

const CACHE_KEY = "bdri_terrain_referentiels";

interface Referentiels {
  troncons: { id: string; code: string; nom: string }[];
  ouvrages: { id: string; nom: string; type: string }[];
  cachedAt: string;
}

async function loadReferentiels(): Promise<Referentiels> {
  if (navigator.onLine) {
    try {
      const [tRes, oRes] = await Promise.all([
        api.get("/troncons", { params: { pageSize: 200, sortBy: "code", sortDir: "asc" } }),
        api.get("/ouvrages", { params: { pageSize: 200, sortBy: "nom", sortDir: "asc" } }),
      ]);
      const data: Referentiels = {
        troncons: (tRes.data.data ?? []).map((t: { id: string; code: string; nom: string }) => ({ id: t.id, code: t.code, nom: t.nom })),
        ouvrages: (oRes.data.data ?? []).map((o: { id: string; nom: string; type: string }) => ({ id: o.id, nom: o.nom, type: o.type })),
        cachedAt: new Date().toISOString(),
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      return data;
    } catch {
      // repli sur le cache local si la requete echoue malgre navigator.onLine=true
    }
  }
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached) as Referentiels;
  return { troncons: [], ouvrages: [], cachedAt: "" };
}

// ── Composant ────────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function InspectionTerrainPage() {
  const navigate = useNavigate();
  const { online } = useOfflineSync();

  const [referentiels, setReferentiels] = useState<Referentiels>({ troncons: [], ouvrages: [], cachedAt: "" });
  const [objetType, setObjetType] = useState<"troncon" | "ouvrage">("troncon");
  const [tronconId, setTronconId] = useState("");
  const [ouvrageId, setOuvrageId] = useState("");
  const [dateInspection, setDateInspection] = useState(new Date().toISOString().slice(0, 10));
  const [etatObserve, setEtatObserve] = useState("BON");
  const [defautsConstates, setDefautsConstates] = useState("");
  const [recommandations, setRecommandations] = useState("");
  const [photos, setPhotos] = useState<{ name: string; blob: Blob; previewUrl: string }[]>([]);
  const [geoloc, setGeoloc] = useState<{ lat: number; lon: number } | null>(null);
  const [geolocError, setGeolocError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recentSubmissions, setRecentSubmissions] = useState<PendingInspection[]>([]);

  useEffect(() => {
    loadReferentiels().then(setReferentiels);
    getAllPending().then((all) => setRecentSubmissions(all.slice(-5).reverse()));
  }, []);

  function captureGeoloc() {
    if (!navigator.geolocation) { setGeolocError("Géolocalisation non disponible sur cet appareil."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { setGeoloc({ lat: pos.coords.latitude, lon: pos.coords.longitude }); setGeolocError(null); },
      () => setGeolocError("Impossible d'obtenir la position (autorisation refusée ou GPS indisponible)."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function handlePhotoCapture(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const added = files.map((f) => ({ name: f.name, blob: f, previewUrl: URL.createObjectURL(f) }));
    setPhotos((prev) => [...prev, ...added]);
    e.target.value = "";
  }

  function removePhoto(idx: number) {
    setPhotos((prev) => {
      URL.revokeObjectURL(prev[idx].previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  }

  function resetForm() {
    photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    setTronconId(""); setOuvrageId(""); setDefautsConstates(""); setRecommandations("");
    setPhotos([]); setGeoloc(null); setEtatObserve("BON");
    setDateInspection(new Date().toISOString().slice(0, 10));
  }

  const objetValid = objetType === "troncon" ? !!tronconId : !!ouvrageId;

  async function handleSubmit() {
    if (!objetValid) { toast.error("Sélectionnez un tronçon ou un ouvrage."); return; }
    setSubmitting(true);
    try {
      const pending: PendingInspection = {
        localId: uuid(),
        payload: {
          tronconId: objetType === "troncon" ? tronconId : undefined,
          ouvrageId: objetType === "ouvrage" ? ouvrageId : undefined,
          dateInspection,
          etatObserve,
          defautsConstates: defautsConstates || undefined,
          recommandations: recommandations || undefined,
          lat: geoloc?.lat,
          lon: geoloc?.lon,
        },
        photos: photos.map((p) => ({ name: p.name, blob: p.blob })),
        createdAt: new Date().toISOString(),
        status: "pending",
      };
      await addPendingInspection(pending);
      await refreshPendingCount();
      toast.success(online ? "Inspection enregistrée — synchronisation en cours…" : "Inspection enregistrée hors-ligne — sera synchronisée au retour du réseau.");
      resetForm();
      getAllPending().then((all) => setRecentSubmissions(all.slice(-5).reverse()));
      if (online) syncPendingInspections();
    } finally {
      setSubmitting(false);
    }
  }

  const objetOptions = useMemo(
    () => objetType === "troncon" ? referentiels.troncons : referentiels.ouvrages,
    [objetType, referentiels]
  );

  return (
    <div className="space-y-4 pb-8">
      {/* Header terrain — grands boutons, optimisé mobile */}
      <div className="bg-gradient-to-r from-navy via-navy2 to-[#1e3a5f] rounded-xl p-4 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-gold" />
            <div>
              <h1 className="text-base font-bold">Inspection terrain</h1>
              <p className="text-xs text-white/60">Fonctionne hors-ligne — synchronisation automatique</p>
            </div>
          </div>
          {!online && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/20 text-amber-200 px-2 py-1 text-[11px] font-medium">
              <CloudOff className="h-3 w-3" /> Hors-ligne
            </span>
          )}
        </div>
        <button onClick={() => navigate("/inspections")} className="mt-2 text-xs text-white/60 underline">
          ← Retour à la liste des inspections
        </button>
      </div>

      {/* Type d'objet */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setObjetType("troncon")}
          className={`rounded-xl border-2 py-3 text-sm font-semibold transition-colors ${objetType === "troncon" ? "border-navy bg-navy/5 text-navy" : "border-gray-200 text-gray-500"}`}
        >
          Tronçon
        </button>
        <button
          onClick={() => setObjetType("ouvrage")}
          className={`rounded-xl border-2 py-3 text-sm font-semibold transition-colors ${objetType === "ouvrage" ? "border-navy bg-navy/5 text-navy" : "border-gray-200 text-gray-500"}`}
        >
          Ouvrage d'art
        </button>
      </div>

      {/* Sélection objet */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          {objetType === "troncon" ? "Tronçon inspecté" : "Ouvrage inspecté"}
        </label>
        <select
          value={objetType === "troncon" ? tronconId : ouvrageId}
          onChange={(e) => objetType === "troncon" ? setTronconId(e.target.value) : setOuvrageId(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30"
        >
          <option value="">— Sélectionner —</option>
          {objetType === "troncon"
            ? (objetOptions as Referentiels["troncons"]).map((t) => (
                <option key={t.id} value={t.id}>{t.code} — {t.nom}</option>
              ))
            : (objetOptions as Referentiels["ouvrages"]).map((o) => (
                <option key={o.id} value={o.id}>{o.nom} ({o.type})</option>
              ))}
        </select>
        {objetOptions.length === 0 && (
          <p className="mt-1 text-xs text-amber-600">
            Référentiel non chargé. Connectez-vous une première fois en ligne pour le mettre en cache.
          </p>
        )}
      </div>

      {/* Date + état */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Date</label>
          <input
            type="date"
            value={dateInspection}
            onChange={(e) => setDateInspection(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">État observé</label>
          <select
            value={etatObserve}
            onChange={(e) => setEtatObserve(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30"
          >
            <option value="BON">Bon</option>
            <option value="MOYEN">Moyen</option>
            <option value="MAUVAIS">Mauvais</option>
            <option value="CRITIQUE">Critique</option>
            <option value="NON_EVALUE">Non évalué</option>
          </select>
        </div>
      </div>

      {/* Défauts / recommandations */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">Défauts constatés</label>
        <textarea
          value={defautsConstates}
          onChange={(e) => setDefautsConstates(e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-navy/30"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">Recommandations</label>
        <textarea
          value={recommandations}
          onChange={(e) => setRecommandations(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-navy/30"
        />
      </div>

      {/* Géolocalisation */}
      <div>
        <Button variant="secondary" onClick={captureGeoloc} className="w-full justify-center">
          <MapPin className="h-4 w-4 mr-1.5" />
          {geoloc ? `Position capturée (${geoloc.lat.toFixed(5)}, ${geoloc.lon.toFixed(5)})` : "Capturer la position GPS"}
        </Button>
        {geolocError && <p className="mt-1 text-xs text-red-600">{geolocError}</p>}
      </div>

      {/* Photos */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">Photos</label>
        <label className="flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 py-4 text-sm text-gray-500 cursor-pointer active:bg-gray-50">
          <input type="file" accept="image/*" capture="environment" multiple onChange={handlePhotoCapture} className="hidden" />
          <Camera className="h-5 w-5" />
          Prendre une photo
        </label>
        {photos.length > 0 && (
          <div className="grid grid-cols-3 gap-2 mt-2">
            {photos.map((p, i) => (
              <div key={i} className="relative aspect-square rounded-lg overflow-hidden border border-gray-200">
                <img src={p.previewUrl} alt="" className="w-full h-full object-cover" />
                <button
                  onClick={() => removePhoto(i)}
                  className="absolute top-1 right-1 h-6 w-6 flex items-center justify-center rounded-full bg-black/60 text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Soumission */}
      <Button onClick={handleSubmit} disabled={submitting || !objetValid} className="w-full py-3.5 text-base">
        {submitting ? "Enregistrement…" : "Enregistrer l'inspection"}
      </Button>

      {/* Dernières saisies locales */}
      {recentSubmissions.length > 0 && (
        <div className="rounded-xl border border-gray-200 p-3">
          <p className="text-xs font-medium text-gray-500 mb-2">Dernières saisies (en attente ou récemment synchronisées)</p>
          <div className="space-y-1.5">
            {recentSubmissions.map((s) => (
              <div key={s.localId} className="flex items-center justify-between text-xs">
                <span className="text-gray-600">{new Date(s.createdAt).toLocaleString("fr-FR")}</span>
                <span className={`inline-flex items-center gap-1 font-medium ${s.status === "error" ? "text-red-600" : "text-amber-600"}`}>
                  {s.status === "error" ? <X className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                  {s.status === "error" ? "Échec" : "En attente"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
