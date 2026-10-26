import { z } from "zod";
import {
  NATURES, PRIORITES_FILTRE, REGEX_UUID, STATUTS, TYPES, bornesCatalogue, lireDateIso, verifierEmpriseProduit, verifierGeometrieDepot,
} from "../teledetection/api.noyau";
import { CYCLES_VIE_PRODUIT, MOTIF_TRANSITION_MAX } from "../teledetection/teledetection.noyau";

/**
 * Schemas des corps d'ecriture de `/api/v2/teledetection`. TOUS stricts (`.strict()`) : un champ inconnu est refuse, jamais ignore --
 * un client qui envoie `confianceCalibree: true` doit l'apprendre, pas croire qu'il a ete pris en compte. Identifiants en UUID,
 * textes bornes, nombres bornes. Les geometries sont verifiees par le noyau de l'API (type, coordonnees, anneaux fermes, polygone
 * sans auto-intersection, positions dans le globe).
 */

const uuid = z.string().regex(REGEX_UUID, "identifiant UUID attendu");
const texte = (max: number) => z.string().trim().min(1, "texte non vide attendu").max(max);

/** Date ISO stricte (AAAA-MM-JJ ou date et heure avec fuseau), dans les bornes du catalogue ; rend un `Date`. */
const dateIso = (nom: string) => z.string().transform((s, ctx) => {
  const r = lireDateIso(s, nom, bornesCatalogue(new Date()));
  if (!r.ok) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.message }); return z.NEVER; }
  return r.valeur;
});

const geometrie = z.object({ type: z.string(), coordinates: z.unknown() }).strict().superRefine((g, ctx) => {
  const v = verifierGeometrieDepot(g);
  if (!v.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: v.message });
});

const indice01 = z.number().finite().min(0).max(1);

export const corpsTransition = z.object({
  vers: z.enum(STATUTS),
  motif: z.string().trim().min(1, "motif obligatoire").max(MOTIF_TRANSITION_MAX),
  commentaire: z.string().trim().max(2000).optional(),
  motifAttente: z.enum(["INFO_DEMANDEE", "AUTRE"]).optional(),
  observationIds: z.array(uuid).max(20).optional(),
  // complete le contrat : reference libre du constat, pour un verdict qui ne cite pas d'observation
  constatRef: texte(200).optional(),
}).strict();

export const corpsVerification = z.object({
  commentaire: z.string().trim().min(1).max(500).optional(),
  // complete le contrat : le service accepte un agent assigne et un debut prevu pour la mission
  assigneId: uuid.nullish(),
  debutPrevu: dateIso("debutPrevu").nullish(),
}).strict();

export const corpsPreuves = z.object({ observationIds: z.array(uuid).min(1).max(20) }).strict();

export const corpsVide = z.object({}).strict();

const propositionDeposee = z.object({
  type: z.enum(TYPES),
  geometrie,
  score: indice01.nullish(),
  confianceDetection: indice01.nullish(),
  priorite: z.object({ niveau: z.enum(PRIORITES_FILTRE), regle: texte(500) }).strict().nullish(),
  imageCouvertureNuagesPct: z.number().finite().min(0).max(100).nullish(),
  imageNote: texte(500).nullish(),
  limites: z.array(texte(500)).min(1, "au moins une limite (resolution native, nuages, ce qui n'est pas detectable)").max(20),
}).strict();

export const corpsDepotPropositions = z.object({
  produitId: uuid,
  produitReferenceId: uuid.nullish(),
  methodeNom: texte(100),
  methodeVersion: texte(50),
  // Aucune tolerance par defaut : sans elle, aucune proposition n'est rattachee a un troncon.
  toleranceRattachementM: z.number().finite().gt(0).max(5000).nullish(),
  synthetique: z.boolean().optional(),
  propositions: z.array(propositionDeposee).min(1).max(5000),
}).strict();

export const corpsDepotProduit = z.object({
  code: texte(64),
  palier: z.number().int().min(0).max(3),
  source: texte(200),
  nature: z.enum(NATURES),
  dateAcquisition: dateIso("dateAcquisition"),
  dateFin: dateIso("dateFin").nullish(),
  resolutionM: z.number().finite().gt(0).max(100_000),
  couvertureNuagesPct: z.number().finite().min(0).max(100).nullish(),
  incertitude: texte(1000),
  provenance: texte(1000),
  licence: texte(500),
  versionTraitement: texte(200),
  autorisationDepenseRef: texte(200).nullish(),
  emprise: z.unknown(),
  // tracabilite fournisseur (migration 20261028100000), toutes facultatives
  sourceCode: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullish(),
  fournisseur: texte(100).nullish(),
  identifiantFournisseur: texte(300).nullish(),
  collection: texte(100).nullish(),
  capteur: texte(100).nullish(),
  orbite: texte(100).nullish(),
  scene: texte(200).nullish(),
  niveauTraitement: texte(50).nullish(),
  resolutionNativeM: z.number().finite().gt(0).max(100_000).nullish(),
  empreinteSha256: z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 : 64 caracteres hexadecimaux en minuscules").nullish(),
  stockageChemin: texte(500).nullish(),
  cycleVie: z.enum(CYCLES_VIE_PRODUIT).nullish(),
  licenceCode: texte(100).nullish(),
  licenceAttribution: texte(500).nullish(),
  synthetique: z.boolean().optional(),
}).strict().superRefine((p, ctx) => {
  const e = verifierEmpriseProduit(p.emprise);
  if (!e.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["emprise"], message: e.message });
  if (p.dateFin && p.dateFin < p.dateAcquisition) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dateFin"], message: "la fin de la periode suit son debut" });
});

export const corpsSynchro = z.object({
  bbox: z.unknown(),
  // `corridorId` est dans le contrat mais pas dans cette version : sa presence est un refus explicite, pas un champ ignore.
  corridorId: z.unknown().optional(),
  depuis: z.unknown(),
  jusqua: z.unknown(),
  nuagesMax: z.unknown(),
}).strict();

/** Premier message lisible d'une erreur de schema, pour le champ `error` ; le detail va dans `details`. */
export function messageZod(e: z.ZodError): string {
  const i = e.issues[0];
  const chemin = i.path.length ? `${i.path.join(".")} : ` : "";
  return `Corps invalide : ${chemin}${i.message}`;
}
