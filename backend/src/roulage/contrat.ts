import { z } from "zod";

/**
 * Contrat d'une session de roulage envoyee par un telephone (entityType `SessionRoulage`).
 *
 * Le miroir cote appareil est `frontend/src/roulage/contrat.ts`. Un banc d'integration fait passer la
 * charge produite par le NOYAU DE L'APPAREIL par CE schema : si les deux divergent, il echoue.
 *
 * ZOD IGNORE EN SILENCE LES CLES INCONNUES. Un champ ajoute cote appareil et oublie ici serait perdu
 * a la synchronisation sans aucune erreur. Toute cle du contrat est donc declaree ; la seule cle
 * interdite, `iri`, l'est explicitement (voir plus bas).
 */

export const VERSION_CONTRAT = 1;

/** Plafonds de forme. Ils protegent le serveur, ils ne sont pas des seuils metier. */
export const POINTS_MAX_SESSION = 36_000; // dix heures a 1 Hz
export const MARQUEURS_MAX = 2_000;
export const EVENEMENTS_MAX = 2_000;
export const LISTES_MAX = 5_000;

/** 2000-01-01 et 2100-01-01, en ms : tout horodatage hors de cette plage est une erreur de saisie ou d'horloge. */
const T_MIN = 946_684_800_000;
const T_MAX = 4_102_444_800_000;
const tMs = z.number().int().min(T_MIN).max(T_MAX);

const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const code = z.string().regex(/^[A-Z0-9_]{1,40}$/);
const codeReferentiel = z.string().min(1).max(64);

const repere = z.object({
  tMs,
  lat: lat.nullable(),
  lon: lon.nullable(),
  precisionM: z.number().min(0).max(10_000).nullable(),
  ageFixMs: z.number().int().min(0).max(86_400_000).nullable(),
  positionPerimee: z.boolean(),
}).refine((r) => (r.lat === null) === (r.lon === null), { message: "lat et lon vont ensemble" });

/** [tMs, lat, lon, precisionM, vitesseMs, segment] */
const point = z.tuple([
  tMs,
  lat,
  lon,
  z.number().min(0).max(10_000).nullable(),
  z.number().min(0).max(200).nullable(),
  z.number().int().min(0).max(10_000),
]);

const qualification = z.object({
  revetement: codeReferentiel.nullish(),
  etat: codeReferentiel.nullish(),
  praticabilite: codeReferentiel.nullish(),
  largeurM: z.number().positive().max(100).nullish(),
});

const marqueur = z.object({
  id: z.string().uuid(),
  code,
  note: z.string().max(500).nullable(),
  repere,
  latenceLogicielleMs: z.number().min(0).max(3_600_000),
});

const evenement = z.object({
  id: z.string().uuid(),
  code,
  note: z.string().max(500).nullable(),
  statut: z.enum(["CLOS", "CLOS_PAR_ARRET", "ABANDONNE"]),
  qualification: qualification.nullable(),
  debut: repere,
  fin: repere.nullable(),
  couvertureGnss: z.number().min(0).max(1).nullable(),
  distanceDirecteM: z.number().min(0).max(10_000_000).nullable(),
  avertissements: z.array(z.string().max(64)).max(32),
  motifAbandon: z.string().max(200).nullable(),
});

const trou = z.object({ debutMs: tMs, finMs: tMs, dureeMs: z.number().int().min(0), coupeSegment: z.boolean() });
const interruption = z.object({
  cause: z.enum(["APPEL", "VEILLE", "GNSS_PERDU", "PERMISSION_RETIREE", "REDEMARRAGE"]),
  debutMs: tMs,
  finMs: tMs.nullable(),
  closePar: z.enum(["ARRET", "REDEMARRAGE"]).optional(),
});
const pause = z.object({ debutMs: tMs, finMs: tMs.nullable() });

export const payloadSessionRoulage = z.object({
  versionContrat: z.literal(VERSION_CONTRAT),
  sessionId: z.string().uuid(),
  missionId: z.string().uuid().nullable(),
  debutMs: tMs,
  finMs: tMs,
  provenanceParametres: z.string().min(1).max(64),
  /** Seuils appliques par l'appareil, conserves tels quels : ils sont provisoires et ne sont pas relus ici. */
  parametres: z.record(z.string().max(64), z.union([z.number(), z.boolean()])).refine((o) => Object.keys(o).length <= 50),
  points: z.array(point).min(2).max(POINTS_MAX_SESSION),
  marqueurs: z.array(marqueur).max(MARQUEURS_MAX),
  evenements: z.array(evenement).max(EVENEMENTS_MAX),
  trous: z.array(trou).max(LISTES_MAX),
  interruptions: z.array(interruption).max(LISTES_MAX),
  pauses: z.array(pause).max(LISTES_MAX),
  compteurs: z.object({
    rejets: z.record(z.string().max(64), z.number().int().min(0)),
    sansPrecision: z.number().int().min(0),
    alertes: z.number().int().min(0),
  }),
  /**
   * AUCUN IRI N'EST ACCEPTE. Il n'existe ni etalon approuve ni donnee d'accelerometre reelle : un
   * indice de regularite recu ici serait un nombre sans origine metrologique. La cle est declaree pour
   * que sa presence soit REFUSEE (PAYLOAD_INVALIDE) au lieu d'etre ignoree en silence.
   */
  iri: z.never().optional(),
}).superRefine((s, ctx) => {
  const ajouter = (message: string, path: (string | number)[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (s.finMs < s.debutMs) ajouter("finMs precede debutMs", ["finMs"]);

  let segmentPrecedent = 0;
  for (let i = 0; i < s.points.length; i += 1) {
    const [t, , , , , seg] = s.points[i];
    if (i > 0) {
      if (t <= s.points[i - 1][0]) { ajouter("les horodatages des points doivent etre strictement croissants", ["points", i]); break; }
      if (seg < segmentPrecedent || seg > segmentPrecedent + 1) { ajouter("les segments doivent croitre de 0 ou 1", ["points", i]); break; }
    } else if (seg !== 0) {
      ajouter("le premier point appartient au segment 0", ["points", 0]); break;
    }
    segmentPrecedent = seg;
  }

  const ids = (liste: { id: string }[], nom: string) => {
    if (new Set(liste.map((x) => x.id)).size !== liste.length) ajouter(`identifiants de ${nom} en double`, [nom]);
  };
  ids(s.marqueurs, "marqueurs");
  ids(s.evenements, "evenements");

  s.evenements.forEach((e, i) => {
    if (e.statut === "ABANDONNE") {
      if (e.fin !== null) ajouter("un evenement abandonne n'a pas de fin", ["evenements", i, "fin"]);
      return;
    }
    if (e.fin === null) ajouter("un evenement clos porte un repere de fin", ["evenements", i, "fin"]);
    else if (e.fin.tMs <= e.debut.tMs) ajouter("la fin d'un evenement doit etre posterieure a son debut", ["evenements", i, "fin"]);
  });
});

export type PayloadSessionRoulage = z.infer<typeof payloadSessionRoulage>;
export type EvenementPayload = PayloadSessionRoulage["evenements"][number];
export type MarqueurPayload = PayloadSessionRoulage["marqueurs"][number];
