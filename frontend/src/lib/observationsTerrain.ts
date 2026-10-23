import {
  GRAVITES_OBSERVATION,
  TYPES_OBSERVATION,
  addPendingObservation,
  type GraviteObservation,
  type PendingObservation,
  type TypeObservation,
} from "./offlineDb";
import { refreshPendingCount, syncPendingOfflineData } from "./offlineSync";

/**
 * Saisie d'une observation de terrain dans la file locale.
 *
 * CE FICHIER NE DECIDE RIEN DU PROTOCOLE
 *
 * Les champs, leurs bornes et les valeurs de `type` et `gravite` sont ceux du schema serveur
 * (`backend/src/field/observation-sync-payload.ts`, `creationObservation`), qui est STRICT : une cle de plus
 * ou une valeur hors liste fait refuser l'operation en entier, definitivement. On valide donc ici ce que le
 * serveur validera, pour que l'agent l'apprenne sur le terrain et non au retour du reseau, quand il ne
 * pourra plus corriger. Si le schema serveur change, ce fichier change avec lui.
 *
 * Auteur, statut, version et validation ne sont JAMAIS envoyes : le serveur les pose. Une observation sortie
 * du terrain est une PROPOSITION (`PROPOSEE`), pas une donnee officielle.
 */

export const LIBELLES_TYPE: Record<TypeObservation, string> = {
  DEGRADATION: "Dégradation",
  CHAUSSEE: "Chaussée",
  ASSAINISSEMENT: "Assainissement",
  SIGNALISATION: "Signalisation",
  OUVRAGE: "Ouvrage",
  SECURITE: "Sécurité",
  TRAFIC: "Trafic",
  ENVIRONNEMENT: "Environnement",
  CHANTIER: "Chantier",
  INCIDENT: "Incident",
  AUTRE: "Autre",
};

export const LIBELLES_GRAVITE: Record<GraviteObservation, string> = {
  FAIBLE: "Faible",
  MOYENNE: "Moyenne",
  FORTE: "Forte",
};

export interface SaisieObservation {
  type: string;
  gravite?: string;
  description?: string;
  lat?: number | null;
  lon?: number | null;
  precisionM?: number | null;
  tronconId?: string;
  missionId?: string;
}

export type ResultatConstruction =
  | { ok: true; observation: PendingObservation }
  | { ok: false; erreurs: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UUID v4. `crypto.randomUUID` n'existe qu'en contexte securise (HTTPS) : sur une page servie autrement,
 * l'appel leve. Le repli garde la saisie possible plutot que de la refuser, et reste un v4 valide pour le
 * serveur (`z.string().uuid()`).
 */
export function nouvelIdentifiant(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const octets = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(octets);
  else for (let i = 0; i < 16; i++) octets[i] = Math.floor(Math.random() * 256);
  octets[6] = (octets[6] & 0x0f) | 0x40;
  octets[8] = (octets[8] & 0x3f) | 0x80;
  const hex = [...octets].map((o) => o.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function estUuid(valeur: string): boolean {
  return UUID.test(valeur);
}

/**
 * Construit l'observation locale, ou dit ce qui manque. N'ecrit rien.
 *
 * `maintenant` est injectable : la date du CONSTAT est celle de la saisie, et un test doit pouvoir la figer.
 */
export function construireObservation(
  saisie: SaisieObservation,
  contexte: { userId: string; maintenant?: Date; identifiant?: string },
): ResultatConstruction {
  const erreurs: string[] = [];
  const type = TYPES_OBSERVATION.find((t) => t === saisie.type);
  if (!type) erreurs.push("Choisissez le type d'observation.");

  let gravite: GraviteObservation | undefined;
  if (saisie.gravite) {
    gravite = GRAVITES_OBSERVATION.find((g) => g === saisie.gravite);
    if (!gravite) erreurs.push("La gravité choisie n'existe pas.");
  }

  const description = saisie.description?.trim() ?? "";
  if (description.length > 5000) erreurs.push("La description dépasse 5 000 caractères.");

  const { lat, lon, precisionM } = saisie;
  const aLat = lat !== undefined && lat !== null;
  const aLon = lon !== undefined && lon !== null;
  if (aLat !== aLon) erreurs.push("La latitude et la longitude vont ensemble : renseignez les deux ou aucune.");
  if (aLat && (!Number.isFinite(lat) || lat < -90 || lat > 90)) erreurs.push("La latitude doit être comprise entre -90 et 90.");
  if (aLon && (!Number.isFinite(lon) || lon < -180 || lon > 180)) erreurs.push("La longitude doit être comprise entre -180 et 180.");
  if (precisionM !== undefined && precisionM !== null && (!Number.isFinite(precisionM) || precisionM < 0 || precisionM > 100_000)) {
    erreurs.push("La précision doit être un nombre de mètres positif.");
  }
  if (saisie.tronconId && saisie.tronconId.length > 128) erreurs.push("L'identifiant du tronçon est trop long.");
  if (saisie.missionId && !estUuid(saisie.missionId)) erreurs.push("L'identifiant de mission n'est pas valide.");

  if (!description && !aLat && !saisie.tronconId) {
    erreurs.push("Décrivez l'observation, ou localisez-la (position GPS ou tronçon) : une observation sans rien ne se retrouve pas.");
  }
  if (erreurs.length > 0 || !type) return { ok: false, erreurs };

  const identifiant = contexte.identifiant ?? nouvelIdentifiant();
  const maintenant = contexte.maintenant ?? new Date();
  // Aucune cle n'est emise sans valeur : le schema serveur est strict, mais une cle absente vaut mieux qu'un
  // `undefined` que JSON.stringify omettrait de toute facon, et que le test d'egalite verrait differemment.
  const payload: PendingObservation["payload"] = { type, observeA: maintenant.toISOString() };
  if (gravite) payload.gravite = gravite;
  if (description) payload.description = description;
  if (aLat && aLon) { payload.lat = lat; payload.lon = lon; }
  if (precisionM !== undefined && precisionM !== null) payload.precisionM = precisionM;
  if (saisie.tronconId) payload.tronconId = saisie.tronconId;
  if (saisie.missionId) payload.missionId = saisie.missionId;

  return {
    ok: true,
    observation: {
      localId: identifiant,
      ownerUserId: contexte.userId,
      payload,
      createdAt: maintenant.toISOString(),
      status: "pending",
    },
  };
}

/**
 * Met l'observation en file locale, PUIS tente la remontee. L'ordre compte : la saisie est durable avant
 * tout envoi, un reseau qui tombe a la ligne suivante ne la perd pas.
 */
export async function enregistrerObservation(
  saisie: SaisieObservation,
  userId: string,
): Promise<ResultatConstruction> {
  const construit = construireObservation(saisie, { userId });
  if (!construit.ok) return construit;
  await addPendingObservation(construit.observation);
  await refreshPendingCount();
  if (navigator.onLine) void syncPendingOfflineData();
  return construit;
}

/** Le statut d'une saisie locale, en mots que l'agent comprend, et l'action qui lui revient. */
export function libelleStatutObservation(o: Pick<PendingObservation, "status" | "refusDefinitif">): { libelle: string; action: string } {
  switch (o.status) {
    case "conflit":
      return { libelle: "En conflit", action: "Un responsable doit trancher. Rien à refaire : votre saisie est conservée." };
    case "abandonnee":
      return {
        libelle: o.refusDefinitif ? "Refusée" : "Abandonnée",
        action: "Plus retentée automatiquement. Lisez le motif ; vous pouvez la relancer après correction.",
      };
    case "error":
      return { libelle: "Erreur, nouvel essai prévu", action: "Elle sera renvoyée au prochain retour du réseau." };
    default:
      return { libelle: "En attente d'envoi", action: "Elle partira dès que le réseau le permet." };
  }
}
