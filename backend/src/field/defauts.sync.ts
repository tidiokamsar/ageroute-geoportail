import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  graviteValide,
  metrer,
  type MesuresDefaut,
  type TypeDefaut,
} from "./defauts.regles";

/**
 * Le client hors ligne envoie le même contrat métier que POST /api/v2/defauts.
 * Les champs d'identité, de validation, de version et de quantité calculée sont
 * volontairement absents : ils sont établis par le serveur.
 */
const mesuresSchema = z.object({
  nombre: z.number().int().positive().nullish(),
  longueurM: z.number().positive().nullish(),
  largeurM: z.number().positive().nullish(),
  profondeurM: z.number().positive().nullish(),
  quantiteSaisie: z.number().positive().nullish(),
}).strict();

export const defautSyncCreationSchema = z.object({
  catalogueCode: z.string().min(1).max(64),
  code: z.string().min(1).max(64).optional(),
  clientOperationId: z.string().uuid().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  precisionM: z.number().positive().max(10_000).optional(),
  tronconId: z.string().min(1).optional(),
  abscisseM: z.number().min(0).optional(),
  pk: z.number().min(0).optional(),
  confianceAppariement: z.number().min(0).max(1).optional(),
  missionId: z.string().uuid().optional(),
  observationId: z.string().uuid().optional(),
  constateA: z.string().datetime().optional(),
  gravite: z.number().int().min(1).optional(),
  etendue: z.enum(["PONCTUEL", "LOCALISE", "ETENDU", "GENERALISE"]).optional(),
  mesures: mesuresSchema.optional(),
}).strict();

export type DefautSyncCreation = z.infer<typeof defautSyncCreationSchema>;

export interface ContexteCreationDefautSync {
  entityId: string;
  operationId: string;
  userId: string;
  appareilId: string;
}

export interface PreparationDefautSync {
  data: Prisma.DefautUncheckedCreateInput;
  codeCatalogue: string;
  lat: number | null;
  lon: number | null;
  tronconId: string | null;
  abscisseM: number | null;
  pk: number | null;
  quantite: number | null;
  unite: TypeDefaut["unite"] | null;
  methode: string | null;
  constateA: Date;
}

export type ResultatPreparationDefautSync =
  | { ok: true; preparation: PreparationDefautSync }
  | { ok: false; motif: string };

type Tx = Prisma.TransactionClient;

function refuser(motif: string): ResultatPreparationDefautSync {
  return { ok: false, motif };
}

/**
 * Valide et prépare une création de défaut dans la transaction du push.
 * Le payload est traité comme une proposition terrain : aucun statut, auteur,
 * horodatage de traitement, tombstone ou résultat de métré fourni par le client
 * ne peut contourner les règles du domaine.
 */
export async function preparerDefautSync(
  tx: Tx,
  contexte: ContexteCreationDefautSync,
  payload: unknown,
): Promise<ResultatPreparationDefautSync> {
  const parsed = defautSyncCreationSchema.safeParse(payload);
  if (!parsed.success) {
    const champs = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")).filter(Boolean))];
    return refuser(`PAYLOAD_INVALIDE${champs.length ? `:${champs.join(",")}` : ""}`);
  }
  const c = parsed.data;
  if (c.clientOperationId && c.clientOperationId !== contexte.operationId) {
    return refuser("CLE_IDEMPOTENCE_INCOHERENTE");
  }

  const gps = c.lat !== undefined && c.lon !== undefined;
  if ((c.lat !== undefined) !== (c.lon !== undefined)) return refuser("POSITION_GPS_INCOMPLETE");
  if (!gps && !c.tronconId) return refuser("LOCALISATION_REQUISE");
  if (c.abscisseM !== undefined && !c.tronconId) return refuser("ABSCISSE_SANS_TRONCON");
  if (c.abscisseM !== undefined && c.confianceAppariement === undefined) {
    return refuser("CONFIANCE_APPARIEMENT_REQUISE");
  }
  if (c.tronconId && !gps && c.abscisseM === undefined && c.pk === undefined) {
    return refuser("REPERE_TRONCON_REQUIS");
  }

  const constateA = c.constateA ? new Date(c.constateA) : new Date();
  if (constateA.getTime() > Date.now() + 3_600_000) return refuser("DATE_DANS_LE_FUTUR");

  const catalogue = await tx.catalogueDefaut.findUnique({ where: { code: c.catalogueCode } });
  if (!catalogue || !catalogue.actif) return refuser("TYPE_DEFAUT_INCONNU");

  const troncon = c.tronconId
    ? await tx.troncon.findFirst({
        where: { id: c.tronconId, deletedAt: null },
        select: { id: true, longueurKm: true },
      })
    : null;
  if (c.tronconId && !troncon) return refuser("TRONCON_INTROUVABLE");
  if (
    c.abscisseM !== undefined &&
    troncon?.longueurKm != null &&
    c.abscisseM > troncon.longueurKm * 1000
  ) {
    return refuser("ABSCISSE_HORS_TRONCON");
  }

  if (c.missionId) {
    const mission = await tx.mission.findFirst({
      where: {
        id: c.missionId,
        deletedAt: null,
        OR: [
          { createurId: contexte.userId },
          { assigneId: contexte.userId },
          { appareilId: contexte.appareilId },
        ],
      },
      select: { id: true },
    });
    if (!mission) return refuser("MISSION_INTROUVABLE_OU_NON_ASSIGNEE");
  }

  if (c.observationId) {
    const observation = await tx.observation.findFirst({
      where: { id: c.observationId, deletedAt: null, agentId: contexte.userId },
      select: { id: true, missionId: true },
    });
    if (!observation) return refuser("OBSERVATION_INTROUVABLE_OU_NON_AUTORISEE");
    if (c.missionId && observation.missionId && observation.missionId !== c.missionId) {
      return refuser("MISSION_OBSERVATION_INCOHERENTES");
    }
  }

  if (c.code) {
    const codeExistant = await tx.defaut.findUnique({ where: { code: c.code }, select: { id: true } });
    if (codeExistant) return refuser("CODE_DEFAUT_DEJA_UTILISE");
  }

  const type: TypeDefaut = {
    code: catalogue.code,
    unite: catalogue.unite,
    mesuresRequises: catalogue.mesuresRequises,
    graviteMax: catalogue.graviteMax,
  };
  const gravite = graviteValide(c.gravite ?? null, catalogue.graviteMax);
  if (!gravite.permis) return refuser(gravite.motif);

  const mesures: MesuresDefaut = {
    nombre: c.mesures?.nombre ?? null,
    longueurM: c.mesures?.longueurM ?? null,
    largeurM: c.mesures?.largeurM ?? null,
    profondeurM: c.mesures?.profondeurM ?? null,
    quantiteSaisie: c.mesures?.quantiteSaisie ?? null,
  };
  const metre = metrer(mesures, type, troncon?.longueurKm != null ? troncon.longueurKm * 1000 : null);
  if (metre.valeur === null && metre.motif !== "MESURES_INSUFFISANTES") {
    return refuser(metre.motif);
  }

  const data: Prisma.DefautUncheckedCreateInput = {
    id: contexte.entityId,
    code: c.code ?? null,
    clientOperationId: contexte.operationId,
    catalogueId: catalogue.id,
    observationId: c.observationId ?? null,
    missionId: c.missionId ?? null,
    tronconId: c.tronconId ?? null,
    lat: c.lat ?? null,
    lon: c.lon ?? null,
    precisionM: c.precisionM ?? null,
    abscisseM: c.abscisseM ?? null,
    confianceAppariement: c.confianceAppariement ?? null,
    pk: c.pk ?? null,
    nombre: mesures.nombre,
    longueurM: mesures.longueurM,
    largeurM: mesures.largeurM,
    profondeurM: mesures.profondeurM,
    quantiteSaisie: mesures.quantiteSaisie,
    quantite: metre.valeur,
    uniteQuantite: metre.valeur !== null ? catalogue.unite : null,
    methodeQuantite: metre.valeur !== null ? metre.methode : null,
    gravite: c.gravite ?? null,
    etendue: c.etendue ?? null,
    constateA,
    constateParId: contexte.userId,
    etat: "ACTIF",
    statutValidation: "A_VALIDER",
    version: 1,
    deletedAt: null,
  };

  return {
    ok: true,
    preparation: {
      data,
      codeCatalogue: catalogue.code,
      lat: c.lat ?? null,
      lon: c.lon ?? null,
      tronconId: c.tronconId ?? null,
      abscisseM: c.abscisseM ?? null,
      pk: c.pk ?? null,
      quantite: metre.valeur,
      unite: metre.valeur !== null ? catalogue.unite : null,
      methode: metre.valeur !== null ? metre.methode : null,
      constateA,
    },
  };
}
