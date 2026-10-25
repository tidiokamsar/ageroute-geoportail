import { useEffect, useMemo, useState } from "react";
import { CONSTATS, METHODES, manquesFiche, nombreOuRien } from "../lib/inspectionTerrain";
import { useNavigate } from "react-router-dom";
import { MapPin, Camera, X, CloudOff, CheckCircle2, ClipboardList } from "lucide-react";
import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { toast } from "../lib/toast";
import { addPendingInspection, getAllPending, type PendingInspection } from "../lib/offlineDb";
import { refreshPendingCount, syncPendingOfflineData } from "../lib/offlineSync";
import { useOfflineSync } from "../hooks/useOfflineSync";
import { useAuth } from "../lib/auth";

// ── Cache local des référentiels (troncons/ouvrages) pour usage hors-ligne ────────

const CACHE_KEY = "bdri_terrain_referentiels";

interface Referentiels {
  troncons: { id: string; code: string; nom: string }[];
  ouvrages: { id: string; nom: string; type: string }[];
  /** Missions de l'agent, encore ouvertes (lot F). Absent d'un ancien cache : liste vide. */
  missions?: { id: string; code: string; intitule: string }[];
  cachedAt: string;
}

/**
 * TOUT le reseau classe, page par page (BDRI, lot F). Le cache ne prenait que les 200 premiers troncons par code :
 * au-dela, un agent ne pouvait pas inspecter le troncon sur lequel il se trouvait. Plafond de 30 pages (6 000) : le
 * reseau classe en compte 1 691 ; au-dela, ce serait la voirie, que la liste n'expose pas par defaut.
 */
async function tousLesTroncons(): Promise<Referentiels["troncons"]> {
  const out: Referentiels["troncons"] = [];
  for (let page = 1; page <= 30; page++) {
    const r = await api.get("/troncons", { params: { page, pageSize: 200, sortBy: "code", sortDir: "asc" } });
    out.push(...(r.data.data ?? []).map((t: { id: string; code: string; nom: string }) => ({ id: t.id, code: t.code, nom: t.nom })));
    if (page >= (r.data.totalPages ?? 1)) break;
  }
  return out;
}

async function mesMissions(userId: string | undefined): Promise<Referentiels["missions"]> {
  try {
    const { data } = await api.get<{ id: string; code: string; intitule: string; statut: string; assigneId: string | null; createurId: string }[]>("/v2/missions", { params: { limite: 200 } });
    return data.filter((m) => !["TERMINEE", "ANNULEE"].includes(m.statut) && (m.assigneId === userId || m.createurId === userId)).map((m) => ({ id: m.id, code: m.code, intitule: m.intitule }));
  } catch {
    return [];
  }
}

async function loadReferentiels(userId?: string): Promise<Referentiels> {
  if (navigator.onLine) {
    try {
      const [troncons, oRes, missions] = await Promise.all([
        tousLesTroncons(),
        api.get("/ouvrages", { params: { pageSize: 200, sortBy: "nom", sortDir: "asc" } }),
        mesMissions(userId),
      ]);
      const data: Referentiels = {
        troncons,
        missions,
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
  const { user } = useAuth();

  const [referentiels, setReferentiels] = useState<Referentiels>({ troncons: [], ouvrages: [], cachedAt: "" });
  const [objetType, setObjetType] = useState<"troncon" | "ouvrage">("troncon");
  const [tronconId, setTronconId] = useState("");
  const [ouvrageId, setOuvrageId] = useState("");
  const [dateInspection, setDateInspection] = useState(new Date().toISOString().slice(0, 10));
  const [etatObserve, setEtatObserve] = useState("BON");
  const [defautsConstates, setDefautsConstates] = useState("");
  const [recommandations, setRecommandations] = useState("");
  const [photos, setPhotos] = useState<{ name: string; blob: Blob; previewUrl: string }[]>([]);
  const [geoloc, setGeoloc] = useState<{ lat: number; lon: number; precisionM: number } | null>(null);
  const [geolocError, setGeolocError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recentSubmissions, setRecentSubmissions] = useState<PendingInspection[]>([]);
  const [recherche, setRecherche] = useState("");
  const [constatDefauts, setConstatDefauts] = useState("");
  const [methodeObservation, setMethode] = useState("VISUELLE_A_PIED");
  const [conditionsObservation, setConditions] = useState("");
  const [missionId, setMissionId] = useState("");
  const [debutM, setDebutM] = useState("");
  const [finM, setFinM] = useState("");
  const manques = manquesFiche({ constatDefauts, defautsConstates, etatObserve, debutM, finM });

  useEffect(() => {
    loadReferentiels(user?.id).then(setReferentiels);
    getAllPending().then((all) => setRecentSubmissions(all.filter((item) => item.ownerUserId === user?.id).slice(-5).reverse()));
  }, [user?.id]);

  function captureGeoloc() {
    if (!navigator.geolocation) { setGeolocError("Géolocalisation non disponible sur cet appareil."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // On retient l'incertitude annoncee par l'appareil, et pas seulement la
        // position : a plus ou moins 500 m, une coordonnee rattachee a un troncon
        // precis cree une donnee fausse, plus couteuse qu'une donnee absente.
        setGeoloc({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          precisionM: Math.round(pos.coords.accuracy),
        });
        setGeolocError(null);
      },
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
    setConstatDefauts(""); setConditions(""); setMissionId(""); setDebutM(""); setFinM("");
    setDateInspection(new Date().toISOString().slice(0, 10));
  }

  const objetValid = objetType === "troncon" ? !!tronconId : !!ouvrageId;

  async function handleSubmit() {
    if (!objetValid) { toast.error("Sélectionnez un tronçon ou un ouvrage."); return; }
    if (manques.length) { toast.error(manques[0]); return; }
    setSubmitting(true);
    try {
      const pending: PendingInspection = {
        localId: uuid(),
        ownerUserId: user?.id,
        payload: {
          tronconId: objetType === "troncon" ? tronconId : undefined,
          ouvrageId: objetType === "ouvrage" ? ouvrageId : undefined,
          dateInspection,
          etatObserve,
          defautsConstates: defautsConstates || undefined,
          recommandations: recommandations || undefined,
          lat: geoloc?.lat,
          lon: geoloc?.lon,
          precisionM: geoloc?.precisionM,
          constatDefauts: constatDefauts || undefined,
          methodeObservation: methodeObservation || undefined,
          conditionsObservation: conditionsObservation.trim() || undefined,
          missionId: missionId || undefined,
          debutM: objetType === "troncon" ? nombreOuRien(debutM) : undefined,
          finM: objetType === "troncon" ? nombreOuRien(finM) : undefined,
        },
        photos: photos.map((p) => ({ name: p.name, blob: p.blob })),
        createdAt: new Date().toISOString(),
        status: "pending",
      };
      await addPendingInspection(pending);
      await refreshPendingCount();
      toast.success(online ? "Inspection enregistrée — synchronisation en cours…" : "Inspection enregistrée hors-ligne — sera synchronisée au retour du réseau.");
      resetForm();
      getAllPending().then((all) => setRecentSubmissions(all.filter((item) => item.ownerUserId === user?.id).slice(-5).reverse()));
      if (online) syncPendingOfflineData();
    } finally {
      setSubmitting(false);
    }
  }

  const objetOptions = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    const liste = objetType === "troncon" ? referentiels.troncons : referentiels.ouvrages;
    // Recherche LOCALE dans le cache : elle marche hors ligne. Le choix courant reste toujours dans la liste.
    if (!q) return liste;
    const courant = objetType === "troncon" ? tronconId : ouvrageId;
    return (liste as { id: string; nom: string; code?: string }[]).filter((x) => x.id === courant || x.nom.toLowerCase().includes(q) || (x.code ?? "").toLowerCase().includes(q));
  }, [objetType, referentiels, recherche, tronconId, ouvrageId]);

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
          <Button type="button" variant="secondary" size="sm" onClick={() => navigate("/inspections/terrain/defauts")}>
            <ClipboardList className="h-3.5 w-3.5" /> Défaut structuré
          </Button>
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
        <input
          aria-label="Rechercher dans le référentiel local"
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
          placeholder="Code ou nom (recherche hors ligne)"
          className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-navy/30"
        />
        <select
          aria-label={objetType === "troncon" ? "Tronçon inspecté" : "Ouvrage inspecté"}
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
          <p className="mt-1 text-xs text-amber-700">
            Référentiel non chargé. Connectez-vous une première fois en ligne pour le mettre en cache.
          </p>
        )}
      </div>

      {/* Date + état */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="inspection-terrain-page-champ-1" className="block text-sm font-medium text-gray-700 mb-1.5">Date</label>
          <input id="inspection-terrain-page-champ-1"
            type="date"
            value={dateInspection}
            onChange={(e) => setDateInspection(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30"
          />
        </div>
        <div>
          <label htmlFor="inspection-terrain-page-champ-2" className="block text-sm font-medium text-gray-700 mb-1.5">État observé (appréciation visuelle)</label>
          <select id="inspection-terrain-page-champ-2"
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

      {/* Constat, méthode, section, mission (lot F) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="inspection-terrain-constat" className="block text-sm font-medium text-gray-700 mb-1.5">Constat des défauts</label>
          <select id="inspection-terrain-constat" value={constatDefauts} onChange={(e) => setConstatDefauts(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30">
            <option value="">Non précisé</option>
            {CONSTATS.map((c) => <option key={c.code} value={c.code}>{c.libelle}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="inspection-terrain-methode" className="block text-sm font-medium text-gray-700 mb-1.5">Méthode d'observation</label>
          <select id="inspection-terrain-methode" value={methodeObservation} onChange={(e) => setMethode(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30">
            {METHODES.map((m) => <option key={m.code} value={m.code}>{m.libelle}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="inspection-terrain-conditions" className="block text-sm font-medium text-gray-700 mb-1.5">Conditions d'observation</label>
          <input id="inspection-terrain-conditions" value={conditionsObservation} maxLength={500} onChange={(e) => setConditions(e.target.value)} placeholder="Météo, visibilité, trafic…"
            className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30" />
        </div>
        {objetType === "troncon" && (
          <>
            <div>
              <label htmlFor="inspection-terrain-debut" className="block text-sm font-medium text-gray-700 mb-1.5">Section observée : début (m)</label>
              <input id="inspection-terrain-debut" inputMode="decimal" value={debutM} onChange={(e) => setDebutM(e.target.value)} placeholder="vide : tronçon entier"
                className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30" />
            </div>
            <div>
              <label htmlFor="inspection-terrain-fin" className="block text-sm font-medium text-gray-700 mb-1.5">Section observée : fin (m)</label>
              <input id="inspection-terrain-fin" inputMode="decimal" value={finM} onChange={(e) => setFinM(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30" />
            </div>
          </>
        )}
        <div className="sm:col-span-2">
          <label htmlFor="inspection-terrain-mission" className="block text-sm font-medium text-gray-700 mb-1.5">Mission</label>
          <select id="inspection-terrain-mission" value={missionId} onChange={(e) => setMissionId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30">
            <option value="">Sans mission</option>
            {(referentiels.missions ?? []).map((m) => <option key={m.id} value={m.id}>{m.code} · {m.intitule}</option>)}
          </select>
        </div>
        <p className="sm:col-span-2 text-xs text-gray-600">L'état est une appréciation visuelle : aucun IRI ni portance ne s'en déduit. Une section en mètres se compte le long du tracé depuis son origine.</p>
        {manques.length > 0 && <ul role="alert" className="sm:col-span-2 text-sm text-red-700">{manques.map((m) => <li key={m}>{m}</li>)}</ul>}
      </div>

      {/* Défauts / recommandations */}
      <div>
        <label htmlFor="inspection-terrain-page-champ-3" className="block text-sm font-medium text-gray-700 mb-1.5">Défauts constatés</label>
        <textarea id="inspection-terrain-page-champ-3"
          value={defautsConstates}
          onChange={(e) => setDefautsConstates(e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-navy/30"
        />
      </div>
      <div>
        <label htmlFor="inspection-terrain-page-champ-4" className="block text-sm font-medium text-gray-700 mb-1.5">Recommandations</label>
        <textarea id="inspection-terrain-page-champ-4"
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
          {geoloc ? `Position capturée — ± ${geoloc.precisionM} m` : "Capturer la position GPS"}
        </Button>
        {geolocError && <p className="mt-1 text-xs text-red-600">{geolocError}</p>}
      </div>

      {/* Photos */}
      <div>
        <label htmlFor="inspection-terrain-page-champ-5" className="block text-sm font-medium text-gray-700 mb-1.5">Photos</label>
        <label className="flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 py-4 text-sm text-gray-500 cursor-pointer active:bg-gray-50">
          <input id="inspection-terrain-page-champ-5" type="file" accept="image/*" capture="environment" multiple onChange={handlePhotoCapture} className="hidden" />
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
                <span className={`inline-flex items-center gap-1 font-medium ${s.status === "error" ? "text-red-600" : "text-amber-700"}`}>
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
