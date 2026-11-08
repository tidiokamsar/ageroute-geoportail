import { z } from "zod";

export const marcheCreateSchema = z.object({
  intitule: z.string().min(1),
  bailleurId: z.number().int().positive().optional(),
  montantTotal: z.number().nonnegative().optional(),
  devise: z.enum(["GNF", "USD", "EUR"]).default("GNF"),
  dateSignature: z.coerce.date().optional(),
  dateDebutPrevue: z.coerce.date().optional(),
  dateFinPrevue: z.coerce.date().optional(),
  dateReceptionProvisoire: z.coerce.date().optional(),
  garantieBonneExecutionExp: z.coerce.date().optional(),
  tauxPenaliteRetardPct: z.number().min(0).max(100).optional(),
  statut: z.enum(["PLANIFIE", "EN_COURS", "SUSPENDU", "TERMINE", "SOLDE"]).default("PLANIFIE"),
});

export const marcheUpdateSchema = marcheCreateSchema.partial();

export const bailleurCreateSchema = z.object({
  nom: z.string().min(1),
  type: z.enum(["etat", "multilateral", "bilateral", "autre"]).default("autre"),
});

export const attachChantierSchema = z.object({
  chantierId: z.string().min(1),
  tronconId: z.string().min(1).optional(),
});

export const avancementSchema = z.object({
  periode: z.coerce.date(),
  avancementPhysiquePrevu: z.number().min(0).max(100).default(0),
  avancementPhysiqueReel: z.number().min(0).max(100).default(0),
  avancementFinancierPrevu: z.number().min(0).max(100).default(0),
  avancementFinancierReel: z.number().min(0).max(100).default(0),
});

/**
 * Corps de `POST /simulateur/budget`. Le gestionnaire se contentait d'un cast TypeScript :
 * une enveloppe en chaine, un poids negatif ou un NaN passaient jusqu'au calcul, et une
 * classe inconnue faisait lever Prisma (500) au lieu d'un refus lisible.
 *
 * STRICT : une cle inconnue est refusee plutot qu'ignoree, car une faute de frappe sur
 * `enveloppe_md_gnf` retomberait en silence sur l'enveloppe par defaut (2000 Md GNF) et
 * rendrait un plan qui ne correspond pas a la demande. Les bornes sont larges : elles
 * ecartent l'absurde (negatif, infini), pas un arbitrage budgetaire.
 */
const poidsSimulateur = z.number().finite().min(0).max(100);

export const simulateurBudgetSchema = z.object({
  /** En milliards de GNF. */
  enveloppe_md_gnf: z.number().finite().min(0).max(1_000_000).optional(),
  ponderation: z.object({
    etat: poidsSimulateur.optional(),
    trafic: poidsSimulateur.optional(),
    strategique: poidsSimulateur.optional(),
    cout: poidsSimulateur.optional(),
  }).strict().optional(),
  filtres: z.object({
    region: z.string().trim().min(1).max(100).optional(),
    classe: z.enum(["RN", "RR", "RU", "PISTE", "NON_CLASSEE"]).optional(),
  }).strict().optional(),
}).strict();

export type SimulateurBudgetInput = z.infer<typeof simulateurBudgetSchema>;
export type MarcheCreateInput = z.infer<typeof marcheCreateSchema>;
export type MarcheUpdateInput = z.infer<typeof marcheUpdateSchema>;
export type AvancementInput = z.infer<typeof avancementSchema>;
