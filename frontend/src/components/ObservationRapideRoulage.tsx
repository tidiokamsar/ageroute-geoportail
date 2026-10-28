import { useRef, useState } from "react";
import { Camera, MapPinned, X } from "lucide-react";
import { GRAVITES_OBSERVATION, TYPES_OBSERVATION, type TypeObservation } from "../lib/offlineDb";
import { LIBELLES_GRAVITE, LIBELLES_TYPE, PHOTOS_MAX_PAR_OBSERVATION, enregistrerObservation, motifRefusPhoto, type PhotoSaisie } from "../lib/observationsTerrain";
import { toast } from "../lib/toast";
import { AlerteStockageLocal, messageStockageLocal } from "./AlerteStockageLocal";

/**
 * Observation RAPIDE pendant l'enregistrement : deux appuis (le type, puis la gravité), sans formulaire.
 *
 * L'agent est en mouvement : pas de saisie de texte. Le type et la gravité sont ceux de l'observation de terrain existante
 * (même file locale hors ligne, même synchronisation, même validation par un responsable) ; la POSITION est celle du dernier
 * fix GPS retenu par l'enregistreur, avec sa précision. Elle n'est jamais inventée : sans position valide, la saisie est refusée
 * plutôt que posée « quelque part ». Une position ancienne est DITE dans la description (« position de N s »).
 *
 * PHOTO FACULTATIVE (étape du type à celle de la gravité) : l'appareil photo du téléphone s'ouvre (`capture`), la photo reste sur le
 * téléphone avec la position du GPS au moment de la prise, puis part APRÈS l'observation (`POST /v2/observations/:id/photos`),
 * une à la fois, retirée de la file à chaque confirmation du serveur. Formats JPG, PNG, WebP, 8 Mo, cinq au plus : refusés tout de
 * suite si hors limites (le serveur les refuserait au retour du réseau, trop tard pour reprendre la photo).
 *
 * Ce que ça enregistre : une PROPOSITION, pas un défaut confirmé. La session est rappelée dans la description (huit premiers
 * caractères de son identifiant) pour retrouver d'où vient l'observation ; le contrat serveur d'une observation n'a pas de champ
 * « session » et n'a pas été modifié.
 */

export interface PositionObservation { lat: number; lon: number; precisionM: number | null; ageMs: number }

interface Props {
  position: PositionObservation | null;
  userId: string;
  sessionId: string;
  missionId: string | null;
  /** Observations rapides déjà enregistrées pendant cette session (compteur d'écran). */
  onEnregistree?: () => void;
}

/** Au-delà, la position est dite ancienne dans la description. */
export const AGE_POSITION_ANCIENNE_MS = 15_000;

export function ObservationRapideRoulage({ position, userId, sessionId, missionId, onEnregistree }: Props) {
  const [type, setType] = useState<TypeObservation | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [nombre, setNombre] = useState(0);
  const [photos, setPhotos] = useState<PhotoSaisie[]>([]);
  // Ecriture refusee par le stockage local : l'observation n'est PAS conservee. Reste affichee (un toast s'efface en 6 s).
  const [erreurStockage, setErreurStockage] = useState<string | null>(null);
  const champPhoto = useRef<HTMLInputElement>(null);

  function ajouterPhotos(fichiers: FileList | null) {
    if (!fichiers) return;
    const prises: PhotoSaisie[] = [];
    for (const f of Array.from(fichiers)) {
      if (photos.length + prises.length >= PHOTOS_MAX_PAR_OBSERVATION) { toast.error("Cinq photos au maximum par observation."); break; }
      const photo: PhotoSaisie = {
        name: f.name || "photo.jpg", blob: f, capturedA: new Date().toISOString(),
        // La position de la photo est celle du GPS au moment de la prise ; sans position valide, aucune n'est inventee.
        ...(position ? { lat: position.lat, lon: position.lon, ...(position.precisionM !== null ? { precisionM: position.precisionM } : {}) } : {}),
      };
      const motif = motifRefusPhoto(photo);
      if (motif) { toast.error(motif); continue; }
      prises.push(photo);
    }
    if (prises.length > 0) setPhotos((courantes) => [...courantes, ...prises]);
    if (champPhoto.current) champPhoto.current.value = "";
  }

  async function enregistrer(gravite: string | undefined) {
    if (!type || !position) return;
    setEnCours(true);
    setErreurStockage(null);
    try {
      const age = Math.round(position.ageMs / 1000);
      const description = `Relevé en roulant, session ${sessionId.slice(0, 8)}${position.ageMs > AGE_POSITION_ANCIENNE_MS ? ` (position de ${age} s avant l'observation)` : ""}`;
      const r = await enregistrerObservation(
        { type, gravite, description, lat: position.lat, lon: position.lon, precisionM: position.precisionM, missionId: missionId ?? undefined, photos },
        userId,
      );
      if (!r.ok) { toast.error(r.erreurs.join(" ")); return; }
      setNombre((n) => n + 1);
      onEnregistree?.();
      setType(null);
      setPhotos([]);
      toast.success("Observation conservée sur ce téléphone, son envoi sera tenté dès que le réseau le permet.");
    } catch (e) {
      // Ni le type ni les photos ne sont vides : l'agent peut reessayer apres avoir deverrouille ou libere de la place.
      const message = messageStockageLocal(e, "enregistrer") ?? "L'observation n'a pas pu être conservée sur ce téléphone (stockage refusé). La noter autrement.";
      setErreurStockage(message);
      toast.error(message);
    } finally {
      setEnCours(false);
    }
  }

  return (
    <fieldset className="max-w-xl rounded-lg border border-gray-300 bg-white p-3" disabled={enCours}>
      <legend className="flex items-center gap-1 px-1 text-sm font-medium"><MapPinned className="h-4 w-4" aria-hidden="true" />Observation rapide ici</legend>
      {!position ? (
        <p role="status" className="text-sm text-amber-900">Pas encore de position valide : attendre le premier signal GPS. Rien n'est posé sans position.</p>
      ) : !type ? (
        <>
          <p className="text-xs text-gray-600">Appui 1 : le type. Appui 2 : la gravité. La position est celle du GPS à cet instant.</p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {TYPES_OBSERVATION.map((t) => (
              <button
                key={t} type="button" onClick={() => setType(t)}
                className="min-h-12 rounded-lg border border-gray-300 bg-white px-2 text-sm font-medium text-navy hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                {LIBELLES_TYPE[t]}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="text-sm" aria-live="polite">Gravité de « {LIBELLES_TYPE[type]} » ?</p>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {GRAVITES_OBSERVATION.map((g) => (
              <button
                key={g} type="button" onClick={() => void enregistrer(g)}
                className="min-h-12 rounded-lg border border-gray-300 bg-white px-2 text-sm font-semibold text-navy hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
              >
                {LIBELLES_GRAVITE[g]}
              </button>
            ))}
            <button
              type="button" onClick={() => void enregistrer(undefined)}
              className="min-h-12 rounded-lg border border-gray-300 bg-white px-2 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
            >
              Sans gravité
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              ref={champPhoto} id="obs-rapide-photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment"
              className="sr-only" onChange={(e) => ajouterPhotos(e.target.files)}
            />
            <label
              htmlFor="obs-rapide-photo"
              className="inline-flex min-h-12 cursor-pointer items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-navy hover:bg-gray-50 focus-within:ring-2 focus-within:ring-gold/60"
            >
              <Camera className="h-4 w-4" aria-hidden="true" />Prendre une photo (facultatif)
            </label>
            {photos.length > 0 && (
              <span className="flex items-center gap-1 text-sm" role="status">
                {photos.length} photo(s) jointe(s)
                <button type="button" onClick={() => setPhotos([])} aria-label="Retirer les photos" className="rounded p-1 text-gray-700 hover:bg-gray-100"><X className="h-4 w-4" aria-hidden="true" /></button>
              </span>
            )}
          </div>
          <button type="button" onClick={() => { setType(null); setPhotos([]); }} className="mt-2 text-xs text-gray-700 underline">Changer de type</button>
        </>
      )}
      <AlerteStockageLocal message={erreurStockage} className="mt-2" />
      {nombre > 0 && <p className="mt-2 text-xs text-gray-700" role="status">{nombre} observation(s) rapide(s) pendant cette session. Ce sont des propositions : un responsable les valide.</p>}
    </fieldset>
  );
}
