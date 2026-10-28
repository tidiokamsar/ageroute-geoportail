import { z } from "zod";

/**
 * TYPES D'INSPECTION (paragraphe 7.7). Memes valeurs que la contrainte `inspection_type_connu`
 * en base : un type s'ajoute ici ET dans une migration, jamais dans une enumeration.
 *
 * POST_TRAVAUX est le constat d'etat apres travaux : « photos apres, etat mesure, IRI, rattache
 * a la fiche d'intervention [...] un constat d'etat du patrimoine, pas une reception de
 * travaux ». Les trois exigences sont verifiees ICI, avec un message par manque, et EN BASE,
 * par contrainte -- l'une pour que l'agent sache quoi corriger, l'autre pour qu'un acces direct
 * ne puisse pas contourner.
 */
export const TYPES_INSPECTION = ["GENERALE", "PERIODIQUE", "VERIFICATION", "POST_TRAVAUX"] as const;
export type TypeInspection = (typeof TYPES_INSPECTION)[number];

const champsCommuns = {
  tronconId: z.string().uuid().optional(),
  ouvrageId: z.string().uuid().optional(),
  dateInspection: z.coerce.date(),
  etatObserve: z.enum(["BON", "MOYEN", "MAUVAIS", "CRITIQUE", "NON_EVALUE"]),
  defautsConstates: z.string().optional(),
  recommandations: z.string().optional(),
  photos: z.array(z.string()).optional(),
  // Position relevee sur le terrain. Bornes verifiees : une coordonnee hors domaine
  // est un defaut de saisie ou de capteur, et vaut mieux etre refusee que stockee —
  // une position fausse est plus couteuse qu'une position absente.
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  // Incertitude annoncee par l'appareil, en metres. Negative n'a pas de sens.
  precisionM: z.number().nonnegative().optional(),
  // Identifiant genere par le CLIENT avant tout envoi, et inchange d'une tentative a
  // l'autre. C'est la cle d'idempotence : le serveur refuse une seconde creation
  // portant le meme identifiant et renvoie l'inspection deja enregistree.
  //
  // Le correctif client — persister l'identifiant serveur des la creation reussie —
  // supprime la cause la plus frequente du doublon, mais pas toutes : une reponse
  // perdue en chemin laisse le client croire a un echec alors que le serveur a bien
  // enregistre. Seule une garantie SERVEUR ferme ce cas.
  clientInspectionId: z.string().min(8).max(128).optional(),

  type: z.enum(TYPES_INSPECTION).default("GENERALE"),
  interventionRef: z.string().trim().min(1).max(64).optional(),
  // L'IRI porte son caractere ESTIME dans son nom (D8) et n'entre pas sans sa methode.
  iriEstime: z.number().min(0).max(30).optional(),
  iriMethode: z.string().trim().min(1).max(64).optional(),
};

/** Les regles qui croisent plusieurs champs, avec un message par manque. */
function reglesCroisees(d: { type?: TypeInspection; interventionRef?: string; photos?: string[]; etatObserve?: string; iriEstime?: number; iriMethode?: string }, ctx: z.RefinementCtx) {
  if (d.type === "POST_TRAVAUX") {
    if (!d.interventionRef) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["interventionRef"], message: "Une inspection post-travaux cite l'intervention qu'elle constate." });
    if (!d.photos || d.photos.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["photos"], message: "Une inspection post-travaux porte au moins une photo « après »." });
    if (d.etatObserve === "NON_EVALUE") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["etatObserve"], message: "L'état après travaux se mesure : NON_EVALUE n'est pas un constat." });
  }
  if ((d.iriEstime !== undefined) !== (d.iriMethode !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["iriMethode"], message: "Un IRI estimé va avec sa méthode, et une méthode avec sa valeur." });
  }
}

export const inspectionCreateSchema = z.object(champsCommuns).superRefine(reglesCroisees);

/**
 * Les memes regles croisees, jugees sur la ligne FUSIONNEE d'une edition partielle : l'etat
 * persiste recouvert par les champs envoyes. Rend la liste des manques, vide si la ligne est
 * complete.
 *
 * Sans elle, passer une inspection existante en POST_TRAVAUX sans reference serait refuse par
 * la contrainte en base -- donc en erreur 500, sans dire quoi corriger. Le controleur l'appelle
 * avant d'ecrire et rend un 400 avec chaque manque nomme.
 */
export function manquesInspection(fusion: {
  type?: string | null; interventionRef?: string | null; photos?: string[] | null;
  etatObserve?: string | null; iriEstime?: number | string | null; iriMethode?: string | null;
}): { champ: string; message: string }[] {
  const issues: { champ: string; message: string }[] = [];
  const ctx = {
    addIssue: (i: { path?: (string | number)[]; message?: string }) => {
      issues.push({ champ: String(i.path?.[0] ?? ""), message: i.message ?? "" });
    },
  } as unknown as z.RefinementCtx;
  reglesCroisees({
    type: (fusion.type ?? undefined) as TypeInspection | undefined,
    interventionRef: fusion.interventionRef?.trim() ? fusion.interventionRef : undefined,
    photos: fusion.photos ?? undefined,
    etatObserve: fusion.etatObserve ?? undefined,
    iriEstime: fusion.iriEstime === null || fusion.iriEstime === undefined ? undefined : Number(fusion.iriEstime),
    iriMethode: fusion.iriMethode ?? undefined,
  }, ctx);
  return issues;
}

// En edition partielle, AUCUNE regle croisee ne se juge sur le seul corps : corriger la valeur
// d'un IRI dont la methode est deja enregistree est legitime, et un controle sur le corps le
// refuserait. Le controleur les juge toutes sur la ligne fusionnee, par `manquesInspection`.
export const inspectionUpdateSchema = z.object(champsCommuns).partial();

export type InspectionCreateInput = z.infer<typeof inspectionCreateSchema>;
export type InspectionUpdateInput = z.infer<typeof inspectionUpdateSchema>;
