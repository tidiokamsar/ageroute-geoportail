import { useState } from "react";
import { MapPinned } from "lucide-react";
import { GRAVITES_OBSERVATION, TYPES_OBSERVATION, type TypeObservation } from "../lib/offlineDb";
import { LIBELLES_GRAVITE, LIBELLES_TYPE, enregistrerObservation } from "../lib/observationsTerrain";
import { toast } from "../lib/toast";

/**
 * Observation RAPIDE pendant l'enregistrement : deux appuis (le type, puis la gravité), sans formulaire.
 *
 * L'agent est en mouvement : pas de saisie de texte. Le type et la gravité sont ceux de l'observation de terrain existante
 * (même file locale hors ligne, même synchronisation, même validation par un responsable) ; la POSITION est celle du dernier
 * fix GPS retenu par l'enregistreur, avec sa précision. Elle n'est jamais inventée : sans position valide, la saisie est refusée
 * plutôt que posée « quelque part ». Une position ancienne est DITE dans la description (« position de N s »).
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

  async function enregistrer(gravite: string | undefined) {
    if (!type || !position) return;
    setEnCours(true);
    try {
      const age = Math.round(position.ageMs / 1000);
      const description = `Relevé en roulant, session ${sessionId.slice(0, 8)}${position.ageMs > AGE_POSITION_ANCIENNE_MS ? ` (position de ${age} s avant l'observation)` : ""}`;
      const r = await enregistrerObservation(
        { type, gravite, description, lat: position.lat, lon: position.lon, precisionM: position.precisionM, missionId: missionId ?? undefined },
        userId,
      );
      if (!r.ok) { toast.error(r.erreurs.join(" ")); return; }
      setNombre((n) => n + 1);
      onEnregistree?.();
      setType(null);
      toast.success("Observation conservée sur ce téléphone, elle partira avec le réseau.");
    } catch {
      toast.error("L'observation n'a pas pu être conservée sur ce téléphone (stockage refusé). La noter autrement.");
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
          <button type="button" onClick={() => setType(null)} className="mt-2 text-xs text-gray-700 underline">Changer de type</button>
        </>
      )}
      {nombre > 0 && <p className="mt-2 text-xs text-gray-700" role="status">{nombre} observation(s) rapide(s) pendant cette session. Ce sont des propositions : un responsable les valide.</p>}
    </fieldset>
  );
}
