import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeft, CheckCircle2, CloudOff, MapPin, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../components/ui/Button";
import { TronconPickerGeo } from "../components/TronconPickerGeo";
import { useOfflineSync } from "../hooks/useOfflineSync";
import { usePositionGps } from "../hooks/usePositionGps";
import { api } from "../lib/api";
import {
  evaluerSommet, lireMesureServeur, lireRefusServeur, mesuresRequisesAvecContour, PRECISION_MAX_SOMMET_M, SOMMETS_MIN, usageDuContour,
  validerContour, type MesureServeur, type SommetContour,
} from "../lib/contourDefaut";
import { chargerReferentielsDefautsTerrain, type MesureDefaut, type TypeCatalogueDefaut } from "../lib/defautsTerrain";
import {
  addPendingDefaut,
  getAllPendingDefauts,
  removePendingDefaut,
  updatePendingDefaut,
  type PendingDefaut,
} from "../lib/offlineDb";
import { refreshPendingCount, syncPendingOfflineData } from "../lib/offlineSync";
import { toast } from "../lib/toast";
import { useAuth } from "../lib/auth";

const MESURES: Record<MesureDefaut, { key: keyof NonNullable<PendingDefaut["payload"]["mesures"]>; label: string; unite: string }> = {
  NOMBRE: { key: "nombre", label: "Nombre", unite: "unités" },
  LONGUEUR: { key: "longueurM", label: "Longueur", unite: "m" },
  LARGEUR: { key: "largeurM", label: "Largeur", unite: "m" },
  PROFONDEUR: { key: "profondeurM", label: "Profondeur", unite: "m" },
  QUANTITE: { key: "quantiteSaisie", label: "Quantité relevée", unite: "selon le catalogue" },
};

type EmpriseDefaut = NonNullable<PendingDefaut["payload"]["emprise"]>;

/** Etat du releve du contour. `ferme` : l'emprise est prete (`emprise` non nulle) ; `sommets` est vide pour une emprise reprise d'un brouillon. */
interface ContourEtat {
  etat: "inactif" | "en_cours" | "ferme";
  sommets: SommetContour[];
  emprise: EmpriseDefaut | null;
  avertissements: string[];
}
const CONTOUR_VIDE: ContourEtat = { etat: "inactif", sommets: [], emprise: null, avertissements: [] };

/** Ce que le SERVEUR dit du contour (apercu de sa mesure). Aucune surface n'est calculee sur le telephone. */
type MesureContour =
  | { etat: "aucune" }
  | { etat: "hors_ligne" }
  | { etat: "attente" }
  | { etat: "mesuree"; mesure: MesureServeur }
  | { etat: "refusee"; raison: string }
  | { etat: "indisponible"; raison: string };

const estSurface = (e: EmpriseDefaut | null) => e?.type === "Polygon" || e?.type === "MultiPolygon";
const nombreDeSommets = (e: EmpriseDefaut): number | null => {
  const anneau = e.type === "Polygon" ? e.coordinates[0] : null;
  return Array.isArray(anneau) ? anneau.length - 1 : null;
};

type MesuresForm = Record<keyof NonNullable<PendingDefaut["payload"]["mesures"]>, string>;
type PhotoForm = NonNullable<PendingDefaut["photos"]>[number] & { previewUrl: string };
const MESURES_VIDES: MesuresForm = {
  nombre: "",
  longueurM: "",
  largeurM: "",
  profondeurM: "",
  quantiteSaisie: "",
};

function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function dateLocalePourInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function dateMaintenantPourInput(): string {
  return dateLocalePourInput(new Date().toISOString());
}

function mesureDansForm(item: PendingDefaut, key: keyof NonNullable<PendingDefaut["payload"]["mesures"]>): string {
  const value = item.payload.mesures?.[key];
  return value === undefined ? "" : String(value);
}

export function DefautTerrainPage() {
  const navigate = useNavigate();
  const { online, syncing } = useOfflineSync();
  const { user } = useAuth();
  const [catalogue, setCatalogue] = useState<TypeCatalogueDefaut[]>([]);
  const [troncons, setTroncons] = useState<{ id: string; code: string; nom: string }[]>([]);
  const [catalogueEnCache, setCatalogueEnCache] = useState(false);
  const [queue, setQueue] = useState<PendingDefaut[]>([]);
  const [catalogueCode, setCatalogueCode] = useState("");
  const [dateConstat, setDateConstat] = useState(dateMaintenantPourInput);
  const [modeLocalisation, setModeLocalisation] = useState<"gps" | "troncon">("gps");
  const [position, setPosition] = useState<{ lat: number; lon: number; precisionM: number } | null>(null);
  const [erreurGps, setErreurGps] = useState("");
  const [tronconId, setTronconId] = useState("");
  const [typeRepere, setTypeRepere] = useState<"abscisse" | "pk">("abscisse");
  const [repere, setRepere] = useState("");
  const [confiance, setConfiance] = useState("0.8");
  const [gravite, setGravite] = useState("");
  const [etendue, setEtendue] = useState<PendingDefaut["payload"]["etendue"] | "">("");
  const [mesures, setMesures] = useState<MesuresForm>(MESURES_VIDES);
  const [photos, setPhotos] = useState<PhotoForm[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [erreurFormulaire, setErreurFormulaire] = useState("");
  const gpsContour = usePositionGps();
  const [contour, setContour] = useState<ContourEtat>(CONTOUR_VIDE);
  const [refusSommet, setRefusSommet] = useState("");
  const [mesureContour, setMesureContour] = useState<MesureContour>({ etat: "aucune" });
  const jetonMesure = useRef(0);

  const typeChoisi = useMemo(
    () => catalogue.find((type) => type.code === catalogueCode) ?? null,
    [catalogue, catalogueCode],
  );
  // Un contour FERME de surface couvre longueur et largeur (m2, m3) : meme regle que le serveur.
  const contourDeSurface = contour.etat === "ferme" && estSurface(contour.emprise);
  const mesuresExigees = useMemo(
    () => (typeChoisi ? mesuresRequisesAvecContour(typeChoisi.unite, typeChoisi.mesuresRequises, contourDeSurface) : []),
    [typeChoisi, contourDeSurface],
  );

  // Apercu de ce que le SERVEUR mesure sur le contour ferme. La valeur enregistree est recalculee par lui a la reception :
  // cet apercu ne l'engage pas, et rien n'est calcule sur ce telephone.
  useEffect(() => {
    if (contour.etat !== "ferme" || !contour.emprise) { setMesureContour({ etat: "aucune" }); return; }
    if (!online) { setMesureContour({ etat: "hors_ligne" }); return; }
    jetonMesure.current += 1;
    const jeton = jetonMesure.current;
    setMesureContour({ etat: "attente" });
    api.post("/v2/geo/metre", { geometrie: contour.emprise })
      .then(({ data }) => {
        if (jeton !== jetonMesure.current) return;
        const mesure = lireMesureServeur(data);
        setMesureContour(mesure ? { etat: "mesuree", mesure } : { etat: "indisponible", raison: "réponse inattendue" });
      })
      .catch((err: unknown) => {
        if (jeton !== jetonMesure.current) return;
        const r = lireRefusServeur(err);
        setMesureContour(r.refus ? { etat: "refusee", raison: r.raison } : { etat: "indisponible", raison: r.raison });
      });
  }, [contour.etat, contour.emprise, online]);

  async function rafraichirQueue() {
    const items = await getAllPendingDefauts();
    setQueue(items.filter((item) => item.ownerUserId === user?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  useEffect(() => {
    let mounted = true;
    chargerReferentielsDefautsTerrain().then((refs) => {
      if (!mounted) return;
      setCatalogue(refs.catalogue);
      setTroncons(refs.troncons);
      setCatalogueEnCache(refs.catalogueEnCache);
      setCatalogueCode((current) => current || refs.catalogue[0]?.code || "");
    });
    rafraichirQueue();
    return () => { mounted = false; };
  }, [user?.id]);

  useEffect(() => {
    rafraichirQueue();
  }, [syncing]);

  function capturePosition() {
    if (!navigator.geolocation) {
      setErreurGps("La géolocalisation n'est pas disponible sur cet appareil.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (resultat) => {
        setPosition({
          lat: resultat.coords.latitude,
          lon: resultat.coords.longitude,
          precisionM: Math.max(1, Math.round(resultat.coords.accuracy)),
        });
        setErreurGps("");
      },
      () => setErreurGps("Position indisponible. Autorisez le GPS ou choisissez un tronçon et un repère."),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  function commencerContour() {
    setRefusSommet("");
    setContour({ etat: "en_cours", sommets: [], emprise: null, avertissements: [] });
    gpsContour.demarrer();
  }

  /** Pose le sommet « ici » : la position courante, si elle passe les controles (precision, anciennete, croisement). */
  function poserSommet() {
    const decision = evaluerSommet(gpsContour.position, contour.sommets, Date.now());
    if (!decision.ok) { setRefusSommet(decision.message); return; }
    setRefusSommet("");
    setContour((c) => ({ ...c, sommets: [...c.sommets, decision.sommet] }));
  }

  function retirerDernierSommet() {
    setRefusSommet("");
    setContour((c) => ({ ...c, sommets: c.sommets.slice(0, -1) }));
  }

  function fermerContour() {
    const r = validerContour(contour.sommets);
    if (!r.ok) { setRefusSommet(r.message); return; }
    setRefusSommet("");
    gpsContour.arreter();
    setContour({ etat: "ferme", sommets: contour.sommets, emprise: r.emprise, avertissements: r.avertissements });
  }

  /** Abandonne ou retire le contour : plus d'emprise, plus de suivi GPS du contour. */
  function retirerContour() {
    gpsContour.arreter();
    setRefusSommet("");
    setContour(CONTOUR_VIDE);
  }

  function reinitialiserFormulaire() {
    retirerContour();
    photos.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
    setPhotos([]);
    setCatalogueCode(catalogue[0]?.code ?? "");
    setDateConstat(dateMaintenantPourInput());
    setModeLocalisation("gps");
    setPosition(null);
    setErreurGps("");
    setTronconId("");
    setTypeRepere("abscisse");
    setRepere("");
    setConfiance("0.8");
    setGravite("");
    setEtendue("");
    setMesures(MESURES_VIDES);
    setEditingId(null);
    setErreurFormulaire("");
  }

  function commencerCorrection(item: PendingDefaut) {
    setEditingId(item.localId);
    setCatalogueCode(item.payload.catalogueCode);
    setDateConstat(dateLocalePourInput(item.payload.constateA));
    if (item.payload.lat !== undefined && item.payload.lon !== undefined) {
      setModeLocalisation("gps");
      setPosition({
        lat: item.payload.lat,
        lon: item.payload.lon,
        precisionM: item.payload.precisionM ?? 1,
      });
      setTronconId("");
      setRepere("");
      setConfiance("0.8");
      setErreurGps("");
    } else {
      setModeLocalisation("troncon");
      setTronconId(item.payload.tronconId ?? "");
      const utiliseAbscisse = item.payload.abscisseM !== undefined;
      setTypeRepere(utiliseAbscisse ? "abscisse" : "pk");
      setRepere(String(utiliseAbscisse ? item.payload.abscisseM ?? "" : item.payload.pk ?? ""));
      setConfiance(String(item.payload.confianceAppariement ?? 0.8));
      setPosition(null);
      setErreurGps("");
    }
    setGravite(item.payload.gravite === undefined ? "" : String(item.payload.gravite));
    setEtendue(item.payload.etendue ?? "");
    setMesures({
      nombre: mesureDansForm(item, "nombre"),
      longueurM: mesureDansForm(item, "longueurM"),
      largeurM: mesureDansForm(item, "largeurM"),
      profondeurM: mesureDansForm(item, "profondeurM"),
      quantiteSaisie: mesureDansForm(item, "quantiteSaisie"),
    });
    photos.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
    setPhotos((item.photos ?? []).map((photo) => ({ ...photo, previewUrl: URL.createObjectURL(photo.blob) })));
    // Le contour du brouillon est repris tel quel : corriger une autre saisie ne doit pas le faire disparaitre en silence.
    gpsContour.arreter();
    setRefusSommet("");
    setContour(item.payload.emprise ? { etat: "ferme", sommets: [], emprise: item.payload.emprise, avertissements: [] } : CONTOUR_VIDE);
    setErreurFormulaire("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function ajouterPhotos(files: FileList | null) {
    if (!files) return;
    const selection = Array.from(files);
    const disponibles = Math.max(0, 5 - photos.length);
    const acceptes = selection.slice(0, disponibles).filter((file) => {
      const image = ["image/jpeg", "image/png", "image/webp"].includes(file.type);
      if (!image) toast.error(`${file.name} : seuls les formats JPG, PNG et WebP sont acceptés.`);
      if (file.size > 8 * 1024 * 1024) toast.error(`${file.name} : la taille maximale est de 8 Mo.`);
      return image && file.size <= 8 * 1024 * 1024;
    });
    if (selection.length > disponibles) toast.error("Cinq photos au maximum peuvent être jointes à un défaut.");
    const capturedA = new Date().toISOString();
    setPhotos((current) => [...current, ...acceptes.map((file) => ({
      name: file.name,
      blob: file,
      capturedA,
      ...(position ? { lat: position.lat, lon: position.lon, precisionM: position.precisionM } : {}),
      previewUrl: URL.createObjectURL(file),
    }))]);
  }

  function retirerPhoto(index: number) {
    setPhotos((current) => {
      URL.revokeObjectURL(current[index].previewUrl);
      return current.filter((_, currentIndex) => currentIndex !== index);
    });
  }

  async function supprimerBrouillon(item: PendingDefaut) {
    if (!window.confirm("Retirer ce défaut non synchronisé de cet appareil ?")) return;
    await removePendingDefaut(item.localId);
    if (editingId === item.localId) reinitialiserFormulaire();
    await rafraichirQueue();
    await refreshPendingCount();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErreurFormulaire("");
    if (!typeChoisi) {
      setErreurFormulaire("Le catalogue des défauts n'est pas disponible. Connectez l'appareil pour le charger avant de repartir sur le terrain.");
      return;
    }

    const constateA = new Date(dateConstat);
    if (!dateConstat || Number.isNaN(constateA.getTime())) {
      setErreurFormulaire("Saisissez la date et l'heure du constat.");
      return;
    }
    if (constateA.getTime() > Date.now() + 3_600_000) {
      setErreurFormulaire("La date du constat ne peut pas être située dans le futur.");
      return;
    }

    const mesuresPayload: NonNullable<PendingDefaut["payload"]["mesures"]> = {};
    for (const [key, raw] of Object.entries(mesures) as [keyof MesuresForm, string][]) {
      if (!raw.trim()) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        const label = Object.values(MESURES).find((spec) => spec.key === key)?.label ?? "La mesure";
        setErreurFormulaire(`${label} doit être supérieure à zéro.`);
        return;
      }
      if (key === "nombre" && !Number.isInteger(value)) {
        setErreurFormulaire("Le nombre doit être un entier.");
        return;
      }
      mesuresPayload[key] = value;
    }
    if (contour.etat === "en_cours") {
      setErreurFormulaire("Le contour est commencé mais pas fermé : le fermer (« Fermer le contour ») ou l'abandonner avant d'enregistrer.");
      return;
    }
    if (mesureContour.etat === "refusee") {
      setErreurFormulaire(`Le serveur a refusé ce contour (${mesureContour.raison}) : le refaire ou le retirer avant d'enregistrer.`);
      return;
    }
    const manquantes = mesuresExigees.filter((measure) => {
      const key = MESURES[measure].key;
      return mesuresPayload[key] === undefined;
    });
    if (manquantes.length > 0) {
      setErreurFormulaire(`Mesures obligatoires pour ce type : ${manquantes.map((measure) => MESURES[measure].label.toLowerCase()).join(", ")}.`);
      return;
    }

    const graviteNum = gravite ? Number(gravite) : undefined;
    if (typeChoisi.graviteMax !== null && (!graviteNum || graviteNum < 1 || graviteNum > typeChoisi.graviteMax)) {
      setErreurFormulaire(`Choisissez une gravité entre 1 et ${typeChoisi.graviteMax}.`);
      return;
    }

    const localisation: Pick<PendingDefaut["payload"], "lat" | "lon" | "precisionM" | "tronconId" | "abscisseM" | "pk" | "confianceAppariement"> = {};
    if (modeLocalisation === "gps") {
      if (!position) {
        setErreurFormulaire("Capturez une position GPS ou choisissez le repérage par tronçon.");
        return;
      }
      if (position.precisionM > 10_000) {
        setErreurFormulaire("La précision GPS est trop faible. Reprenez la position ou utilisez un repère sur tronçon.");
        return;
      }
      Object.assign(localisation, position);
    } else {
      const valeurRepere = Number(repere);
      if (!tronconId || !repere.trim() || !Number.isFinite(valeurRepere) || valeurRepere < 0) {
        setErreurFormulaire("Sélectionnez un tronçon et saisissez un repère égal ou supérieur à zéro.");
        return;
      }
      localisation.tronconId = tronconId;
      if (typeRepere === "abscisse") {
        const confianceNum = Number(confiance);
        if (!Number.isFinite(confianceNum) || confianceNum < 0 || confianceNum > 1) {
          setErreurFormulaire("La confiance d'appariement doit être comprise entre 0 et 1.");
          return;
        }
        localisation.abscisseM = valeurRepere;
        localisation.confianceAppariement = confianceNum;
      } else {
        localisation.pk = valeurRepere;
      }
    }

    const payload: PendingDefaut["payload"] = {
      catalogueCode: typeChoisi.code,
      constateA: constateA.toISOString(),
      ...localisation,
      ...(graviteNum !== undefined ? { gravite: graviteNum } : {}),
      ...(etendue ? { etendue } : {}),
      ...(Object.keys(mesuresPayload).length > 0 ? { mesures: mesuresPayload } : {}),
      // Le contour part TEL QUEL (GeoJSON 4326) : aucune surface n'est jointe, le serveur la mesure en UTM.
      ...(contour.etat === "ferme" && contour.emprise ? { emprise: contour.emprise } : {}),
    };

    setSubmitting(true);
    try {
      if (editingId) {
        const existing = queue.find((item) => item.localId === editingId);
        if (!existing) throw new Error("Le brouillon n'est plus disponible sur cet appareil.");
        if (existing.serverId) throw new Error("Ce défaut est déjà enregistré sur le serveur. Synchronisez les photos restantes depuis la file locale.");
        await updatePendingDefaut({
          ...existing,
          ownerUserId: user?.id,
          payload,
          photos: photos.map(({ previewUrl: _preview, ...photo }) => photo),
          status: "pending",
          tentatives: 0,
          errorMessage: undefined,
        });
      } else {
        await addPendingDefaut({
          localId: uuid(),
          ownerUserId: user?.id,
          payload,
          photos: photos.map(({ previewUrl: _preview, ...photo }) => photo),
          createdAt: new Date().toISOString(),
          status: "pending",
        });
      }
      await refreshPendingCount();
      await rafraichirQueue();
      toast.success(online ? "Défaut enregistré — synchronisation en cours…" : "Défaut enregistré hors-ligne — il sera envoyé au retour du réseau.");
      reinitialiserFormulaire();
      if (online) void syncPendingOfflineData();
    } catch (err) {
      setErreurFormulaire(err instanceof Error ? err.message : "Impossible d'enregistrer le défaut sur cet appareil.");
    } finally {
      setSubmitting(false);
    }
  }

  const mesuresAffichees = useMemo(() => {
    if (!typeChoisi) return [];
    const required = typeChoisi.mesuresRequises;
    return [...required, ...(required.includes("QUANTITE") ? [] : ["QUANTITE" as const])];
  }, [typeChoisi]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-8">
      <section className="rounded-xl bg-gradient-to-r from-navy via-navy2 to-[#1e3a5f] p-4 text-white">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-gold" />
            <div>
              <h1 className="text-base font-bold">Relevé de défaut routier</h1>
              <p className="mt-1 text-xs text-white/70">Saisie mesurée, enregistrée sur cet appareil puis synchronisée automatiquement.</p>
            </div>
          </div>
          {!online && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-400/20 px-2 py-1 text-[11px] font-medium text-amber-100"><CloudOff className="h-3 w-3" /> Hors-ligne</span>}
        </div>
        <button onClick={() => navigate("/inspections/terrain")} className="mt-3 inline-flex items-center gap-1 text-xs text-white/70 underline">
          <ArrowLeft className="h-3 w-3" /> Retour au mode terrain
        </button>
      </section>

      {!catalogueEnCache && !online && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Le catalogue doit être chargé une première fois en ligne pour permettre la saisie hors connexion.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm md:p-6">
        <div>
          <label htmlFor="defaut-catalogue" className="mb-1.5 block text-sm font-medium text-gray-700">Type de défaut</label>
          <select id="defaut-catalogue" value={catalogueCode} onChange={(event) => { setCatalogueCode(event.target.value); setMesures(MESURES_VIDES); setGravite(""); }} disabled={catalogue.length === 0} required className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30">
            {catalogue.length === 0 && <option value="">Catalogue indisponible</option>}
            {catalogue.map((type) => <option key={type.code} value={type.code}>{type.libelle} — {type.famille}</option>)}
          </select>
          {typeChoisi && <p className="mt-1 text-xs text-gray-500">Unité de métré : {typeChoisi.unite.toLowerCase().replaceAll("_", " ")}</p>}
        </div>

        <div>
          <label htmlFor="defaut-date" className="mb-1.5 block text-sm font-medium text-gray-700">Date et heure du constat</label>
          <input id="defaut-date" type="datetime-local" value={dateConstat} onChange={(event) => setDateConstat(event.target.value)} required className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30" />
        </div>

        <fieldset className="space-y-3 rounded-lg border border-gray-200 p-3">
          <legend className="px-1 text-sm font-medium text-gray-700">Localisation du défaut</legend>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setModeLocalisation("gps")} aria-pressed={modeLocalisation === "gps"} className={`rounded-lg border-2 px-3 py-2.5 text-sm font-medium ${modeLocalisation === "gps" ? "border-navy bg-navy/5 text-navy" : "border-gray-200 text-gray-600"}`}>GPS</button>
            <button type="button" onClick={() => setModeLocalisation("troncon")} aria-pressed={modeLocalisation === "troncon"} className={`rounded-lg border-2 px-3 py-2.5 text-sm font-medium ${modeLocalisation === "troncon" ? "border-navy bg-navy/5 text-navy" : "border-gray-200 text-gray-600"}`}>Tronçon et repère</button>
          </div>

          {modeLocalisation === "gps" ? (
            <div>
              <Button type="button" variant="secondary" onClick={capturePosition} className="w-full justify-center">
                <MapPin className="h-4 w-4" /> {position ? `Position capturée — précision ± ${position.precisionM} m` : "Capturer la position GPS"}
              </Button>
              {erreurGps && <p role="alert" className="mt-2 text-xs text-red-600">{erreurGps}</p>}
              {position && <p className="mt-1 text-xs text-gray-500">{position.lat.toFixed(6)}, {position.lon.toFixed(6)}</p>}
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label htmlFor="defaut-troncon" className="mb-1 block text-sm text-gray-700">Tronçon</label>
                {/* Trouver SANS connaître le code : par GPS (« près de moi »), par ville,
                    ou au texte — l'agent reconnaît, le formulaire hors ligne reste la
                    vérité (le choix présélectionne la liste du cache, jamais l'inverse). */}
                <TronconPickerGeo
                  onChoisir={(t) => { setModeLocalisation("troncon"); setTronconId(t.id); }}
                />
                <select id="defaut-troncon" value={tronconId} onChange={(event) => setTronconId(event.target.value)} required className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy/30">
                  <option value="">— Sélectionner —</option>
                  {troncons.map((troncon) => <option key={troncon.id} value={troncon.id}>{troncon.code} — {troncon.nom}</option>)}
                </select>
                {tronconId && !troncons.some((t) => t.id === tronconId) && (
                  <p className="mt-1 text-xs text-amber-700">Tronçon choisi en ligne mais absent du cache hors ligne : il sera rattaché à la synchronisation.</p>
                )}
                {troncons.length === 0 && <p className="mt-1 text-xs text-amber-700">Aucun tronçon en cache. Utilisez la recherche ci-dessus (GPS, ville ou texte) en mode en ligne.</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="defaut-repere-type" className="mb-1 block text-sm text-gray-700">Type de repère</label>
                  <select id="defaut-repere-type" value={typeRepere} onChange={(event) => setTypeRepere(event.target.value as "abscisse" | "pk")} className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base">
                    <option value="abscisse">Abscisse locale (m)</option>
                    <option value="pk">PK</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="defaut-repere" className="mb-1 block text-sm text-gray-700">Valeur du repère</label>
                  <input id="defaut-repere" type="number" min="0" step="any" value={repere} onChange={(event) => setRepere(event.target.value)} required className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base" />
                </div>
              </div>
              {typeRepere === "abscisse" && (
                <div>
                  <label htmlFor="defaut-confiance" className="mb-1 block text-sm text-gray-700">Confiance d'appariement (0 à 1)</label>
                  <input id="defaut-confiance" type="number" min="0" max="1" step="0.05" value={confiance} onChange={(event) => setConfiance(event.target.value)} required className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base" />
                </div>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border border-gray-200 p-3">
          <legend className="px-1 text-sm font-medium text-gray-700">Contour GPS du défaut (facultatif)</legend>
          <p className="text-xs text-gray-500">
            Pour un défaut qui couvre une surface : marcher autour et poser un sommet à chaque angle, puis fermer le contour. Le téléphone ne calcule aucune
            surface : c'est le serveur qui la mesure, en projection métrique. La localisation du défaut reste à renseigner ci-dessus.
          </p>
          <p className="text-xs text-gray-500">
            Un sommet n'est posé que si la précision annoncée est de ± {PRECISION_MAX_SOMMET_M} m ou mieux (seuil provisoire, non calibré sur un récepteur réel).
            {typeChoisi ? ` ${usageDuContour(typeChoisi.unite)}` : ""}
          </p>

          {contour.etat === "inactif" && (
            <Button type="button" variant="secondary" onClick={commencerContour} className="w-full justify-center">
              <MapPin className="h-4 w-4" /> Commencer le contour
            </Button>
          )}

          {contour.etat === "en_cours" && (
            <div className="space-y-3">
              <p className="text-sm text-gray-700">
                {gpsContour.erreur === "REFUSEE" ? "Autorisation de position refusée : la rouvrir dans les réglages du navigateur."
                  : gpsContour.erreur === "INDISPONIBLE" ? "Cet appareil n'a pas de géolocalisation : le contour ne peut pas être relevé."
                  : gpsContour.erreur === "INDETERMINEE" ? "Signal introuvable : sortir à découvert et attendre."
                  : gpsContour.position ? `Position actuelle : précision ± ${gpsContour.position.precisionM} m${gpsContour.position.precisionM > PRECISION_MAX_SOMMET_M ? ` (au-dessus du seuil de ${PRECISION_MAX_SOMMET_M} m : attendre)` : ""}.`
                  : "Recherche du signal…"}
                {" "}{contour.sommets.length} sommet(s) posé(s).
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Button type="button" variant="secondary" onClick={poserSommet} className="w-full justify-center">
                  <MapPin className="h-4 w-4" /> Poser un sommet ici
                </Button>
                <Button type="button" variant="secondary" onClick={fermerContour} disabled={contour.sommets.length < SOMMETS_MIN} className="w-full justify-center">
                  Fermer le contour
                </Button>
                <Button type="button" variant="ghost" onClick={retirerDernierSommet} disabled={contour.sommets.length === 0} className="w-full justify-center">
                  Retirer le dernier sommet
                </Button>
                <Button type="button" variant="ghost" onClick={retirerContour} className="w-full justify-center">
                  Abandonner le contour
                </Button>
              </div>
              {contour.sommets.length < SOMMETS_MIN && <p className="text-xs text-gray-500">Il faut au moins {SOMMETS_MIN} sommets pour fermer le contour.</p>}
              {refusSommet && <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{refusSommet}</p>}
              {contour.sommets.length > 0 && (
                <ol className="max-h-32 list-decimal space-y-0.5 overflow-y-auto pl-5 text-xs text-gray-600">
                  {contour.sommets.map((s, i) => <li key={`${s.poseLe}-${i}`}>{s.lat.toFixed(6)}, {s.lon.toFixed(6)} (± {Math.round(s.precisionM)} m)</li>)}
                </ol>
              )}
            </div>
          )}

          {contour.etat === "ferme" && contour.emprise && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-green-800">
                Contour fermé{nombreDeSommets(contour.emprise) !== null ? ` : ${nombreDeSommets(contour.emprise)} sommets` : ` (${contour.emprise.type})`}.
                {contour.sommets.length === 0 && " Contour repris du brouillon."}
              </p>
              {contour.avertissements.map((a) => <p key={a} className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{a}</p>)}
              <div role="status" className="rounded-lg border border-gray-200 bg-gray-50 p-2 text-sm text-gray-800">
                {mesureContour.etat === "attente" && "Mesure du contour par le serveur…"}
                {mesureContour.etat === "hors_ligne" && "Hors ligne : la surface sera mesurée par le serveur à la synchronisation. Aucune surface n'est calculée sur ce téléphone."}
                {mesureContour.etat === "mesuree" && (
                  <>
                    Surface mesurée par le serveur : <strong>{mesureContour.mesure.surfaceM2.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} m²</strong>
                    {" "}(périmètre {mesureContour.mesure.longueurM.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} m, projection UTM EPSG:{mesureContour.mesure.epsg}).
                    {" "}Aperçu : la valeur enregistrée est recalculée par le serveur à la réception.
                  </>
                )}
                {mesureContour.etat === "refusee" && `Le serveur refuse ce contour : ${mesureContour.raison}. Le refaire ou le retirer.`}
                {mesureContour.etat === "indisponible" && `Mesure du serveur indisponible (${mesureContour.raison}) : la surface sera mesurée à l'enregistrement.`}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Button type="button" variant="secondary" onClick={commencerContour} className="w-full justify-center">Refaire le contour</Button>
                <Button type="button" variant="ghost" onClick={retirerContour} className="w-full justify-center">Retirer le contour</Button>
              </div>
            </div>
          )}
        </fieldset>

        {typeChoisi && mesuresAffichees.length > 0 && (
          <fieldset className="space-y-3 rounded-lg border border-gray-200 p-3">
            <legend className="px-1 text-sm font-medium text-gray-700">Mesures du défaut</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {mesuresAffichees.map((measure) => {
                const spec = MESURES[measure];
                const required = mesuresExigees.includes(measure);
                const couvertParLeContour = !required && typeChoisi.mesuresRequises.includes(measure);
                return (
                  <div key={measure}>
                    <label htmlFor={`mesure-${spec.key}`} className="mb-1 block text-sm text-gray-700">{spec.label}{required ? " *" : couvertParLeContour ? " (couvert par le contour, facultatif)" : " (facultatif)"}</label>
                    <div className="flex items-center gap-2">
                      <input id={`mesure-${spec.key}`} type="number" min="0.001" step={measure === "NOMBRE" ? 1 : "any"} value={mesures[spec.key]} onChange={(event) => setMesures((prev) => ({ ...prev, [spec.key]: event.target.value }))} required={required} className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-3 text-base" />
                      <span className="w-28 text-xs text-gray-500">{spec.unite}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </fieldset>
        )}

        {typeChoisi?.graviteMax !== null && typeChoisi && (
          <div>
            <label htmlFor="defaut-gravite" className="mb-1.5 block text-sm font-medium text-gray-700">Gravité (1 à {typeChoisi.graviteMax})</label>
            <select id="defaut-gravite" value={gravite} onChange={(event) => setGravite(event.target.value)} required className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base">
              <option value="">— Choisir —</option>
              {Array.from({ length: typeChoisi.graviteMax ?? 0 }, (_, index) => index + 1).map((niveau) => <option key={niveau} value={niveau}>{niveau}</option>)}
            </select>
          </div>
        )}

        <div>
          <label htmlFor="defaut-etendue" className="mb-1.5 block text-sm font-medium text-gray-700">Étendue (facultatif)</label>
          <select id="defaut-etendue" value={etendue} onChange={(event) => setEtendue(event.target.value as typeof etendue)} className="w-full rounded-lg border border-gray-300 px-3 py-3 text-base">
            <option value="">— Non précisée —</option>
            <option value="PONCTUEL">Ponctuelle</option>
            <option value="LOCALISE">Localisée</option>
            <option value="ETENDU">Étendue</option>
            <option value="GENERALISE">Généralisée</option>
          </select>
        </div>

        <fieldset className="space-y-3 rounded-lg border border-gray-200 p-3">
          <legend className="px-1 text-sm font-medium text-gray-700">Photos de preuve (5 maximum, 8 Mo par photo)</legend>
          <p className="text-xs text-gray-500">La photo conserve son empreinte SHA-256 au serveur. Si une position GPS a été capturée, elle est jointe comme métadonnée de la preuve.</p>
          {!position && <Button type="button" variant="secondary" onClick={capturePosition}><MapPin className="h-4 w-4" /> Capturer le GPS pour les photos</Button>}
          {/*
            Deux entrées distinctes, pensées téléphone/tablette : PHOTOGRAPHIER ouvre
            l'appareil photo (capture="environment" : caméra arrière), CHOISIR ouvre la
            galerie et les fichiers. Sur ordinateur les deux se valent. Le choix reste
            celui de l'agent ; rien ne se déclenche sans lui.
          */}
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="flex-1 cursor-pointer rounded-lg border-2 border-dashed border-navy/40 bg-navy/5 px-4 py-3 text-center text-sm font-semibold text-navy transition-colors hover:bg-navy/10">
              📷 Photographier sur le vif
              <input aria-label="Photographier une preuve du défaut" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple onChange={(event) => { ajouterPhotos(event.target.files); event.target.value = ""; }} className="sr-only" />
            </label>
            <label className="flex-1 cursor-pointer rounded-lg border border-gray-300 bg-white px-4 py-3 text-center text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50">
              📎 Choisir dans la galerie ou les fichiers
              <input aria-label="Choisir des photos existantes du défaut" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => { ajouterPhotos(event.target.files); event.target.value = ""; }} className="sr-only" />
            </label>
          </div>
          {photos.length > 0 && <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">{photos.map((photo, index) => <li key={`${photo.name}-${index}`} className="overflow-hidden rounded-lg border border-gray-200"><img src={photo.previewUrl} alt={`Aperçu de ${photo.name}`} className="h-28 w-full object-cover" /><div className="p-2"><p className="truncate text-xs font-medium">{photo.name}</p><p className="text-[11px] text-gray-500">{photo.lat !== undefined ? `GPS ${photo.lat.toFixed(5)}, ${photo.lon?.toFixed(5)}` : "Sans position GPS"}</p><Button type="button" variant="ghost" size="sm" onClick={() => retirerPhoto(index)}>Retirer</Button></div></li>)}</ul>}
        </fieldset>

        {erreurFormulaire && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{erreurFormulaire}</p>}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={submitting || !typeChoisi} className="w-full py-3.5 text-base">
            {submitting ? "Enregistrement…" : editingId ? "Mettre à jour le brouillon" : "Enregistrer le défaut"}
          </Button>
          {editingId && <Button type="button" variant="secondary" onClick={reinitialiserFormulaire} className="w-full">Annuler la correction</Button>}
        </div>
        {editingId && <p className="text-xs text-gray-500">La clé d'idempotence est conservée pendant la correction pour éviter de créer un doublon si l'envoi précédent a déjà été reçu.</p>}
      </form>

      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-navy">File locale des défauts</h2>
            <p className="text-xs text-gray-500">Les erreurs restent sur cet appareil pour être corrigées ou renvoyées.</p>
          </div>
          {queue.length > 0 && <Button type="button" variant="secondary" size="sm" disabled={!online || syncing} onClick={() => void syncPendingOfflineData()}><RefreshCw className="h-3.5 w-3.5" /> Synchroniser</Button>}
        </div>
        {queue.length === 0 ? (
          <p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-500">Aucun défaut en attente.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {queue.map((item) => {
              const label = catalogue.find((type) => type.code === item.payload.catalogueCode)?.libelle ?? item.payload.catalogueCode;
              const error = item.status !== "pending";
              return (
                <li key={item.localId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800">{label}</p>
                    <p className="text-xs text-gray-500">{new Date(item.payload.constateA).toLocaleString("fr-FR")}</p>
                    <p className={`mt-1 inline-flex items-center gap-1 text-xs font-medium ${error ? "text-red-700" : "text-amber-700"}`}>
                      {error ? <AlertTriangle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                      {item.status === "abandonnee" ? "À reprendre manuellement" : item.status === "error" ? "Échec — à corriger ou réessayer" : "En attente de synchronisation"}
                    </p>
                    {item.errorMessage && <p className="mt-1 break-words text-xs text-red-700">{item.errorMessage}</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {item.serverId
                      ? <Button type="button" size="sm" variant="secondary" disabled={!online || syncing} onClick={() => void syncPendingOfflineData()}><RefreshCw className="h-3.5 w-3.5" /> Reprendre les photos</Button>
                      : <Button type="button" size="sm" variant="secondary" onClick={() => commencerCorrection(item)}><Pencil className="h-3.5 w-3.5" /> Corriger</Button>}
                    <Button type="button" size="sm" variant="ghost" aria-label={`Retirer le brouillon ${label}`} onClick={() => void supprimerBrouillon(item)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
