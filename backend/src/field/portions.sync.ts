import { z } from "zod";
import { creerPortion, type DemandeCreation } from "../reseau/portions.service";
import { depotDans } from "../reseau/portions.depot";
import type { Portion } from "../reseau/portions";

/**
 * Qualification de portion arrivee par la file de synchronisation.
 *
 * CE MODULE NE REIMPLEMENTE AUCUNE REGLE
 *
 * Il valide la forme du payload, puis appelle `creerPortion`, le MEME service que la route
 * en ligne. Les refus, l'idempotence, le statut `A_VALIDER` et le controle de chevauchement
 * avec une portion validee viennent donc de la meme source pour les deux chemins.
 *
 * La tentation etait de projeter le payload directement en `prisma.portion.create`, comme
 * un premier jet l'aurait fait. Cela aurait double les regles, et c'est exactement ainsi
 * qu'un chemin finit par accepter ce que l'autre refuse — `field/observations.regles.ts`
 * portait deja un duplicata de la regle de validation qui avait DIVERGE, `MOTIF_REQUIS`
 * contre `COMMENTAIRE_REQUIS`.
 *
 * TROIS CHOSES QUE LE TELEPHONE NE DECIDE PAS
 *
 * Le STATUT : le schema ne le connait pas, donc zod le retire. Une portion arrivee du
 * terrain sort en `A_VALIDER`, comme toute autre.
 *
 * L'AUTEUR : il vient du contexte de l'appareil authentifie, jamais du payload.
 *
 * LA CLE D'IDEMPOTENCE : c'est `operationId`, celui du protocole, et non un champ libre du
 * corps. Deux operations distinctes ne peuvent donc pas se faire passer l'une pour l'autre,
 * et une reprise apres coupure retrouve la portion deja ecrite.
 */

/** Ce qu'un appareil peut envoyer. Tout le reste est refuse par zod. */
export const payloadPortion = z.object({
  tronconId: z.string().uuid(),
  debutM: z.number().min(0).max(10_000_000),
  finM: z.number().min(0).max(10_000_000),
  revetement: z.string().max(64).nullish(),
  etat: z.string().max(64).nullish(),
  praticabilite: z.string().max(64).nullish(),
  largeurM: z.number().positive().max(100).nullish(),
  /** D'ou vient l'observation, tel que l'appareil l'a note. */
  source: z.string().max(200).nullish(),
  /** Date du CONSTAT, pas de l'envoi : une portion relevee lundi et remontee vendredi
   *  decrit lundi. Confondre les deux ferait vieillir toute la collecte hors ligne. */
  observeeLe: z.coerce.date().nullish(),
  confiance: z.enum(["HIGH", "MEDIUM", "LOW"]).nullish(),
  observationId: z.string().uuid().nullish(),
});

export type RefusSyncPortion =
  | { ok: false; motif: string };

export type ResultatSyncPortion =
  | { ok: true; portion: Portion }
  | RefusSyncPortion;

/**
 * Applique une qualification de portion dans la transaction de l'appelant.
 *
 * `tx` est le client de transaction du service de synchronisation. L'ecriture rejoint donc
 * la trace de l'operation et le conflit eventuel : aucun etat intermediaire ou la portion
 * existe sans que l'operation soit marquee traitee.
 */
export async function appliquerPortionSync(
  tx: Parameters<typeof depotDans>[0],
  payload: unknown,
  contexte: { userId: string; operationId: string },
): Promise<ResultatSyncPortion> {
  const parse = payloadPortion.safeParse(payload);
  if (!parse.success) {
    // Le detail zod n'est pas renvoye au telephone : il nommerait des champs internes. Le
    // motif suffit a decider de ne pas reessayer.
    return { ok: false, motif: "PAYLOAD_INVALIDE" };
  }

  const demande: DemandeCreation = {
    ...parse.data,
    // LA CLE D'IDEMPOTENCE EST CELLE DU PROTOCOLE. Un champ libre du corps aurait permis a
    // deux operations distinctes de se faire passer l'une pour l'autre.
    clientOperationId: contexte.operationId,
  };

  const r = await creerPortion(demande, contexte.userId, depotDans(tx));
  if (r.refus !== null) return { ok: false, motif: r.refus };
  return { ok: true, portion: r.valeur };
}

/**
 * Un refus de synchronisation est-il DEFINITIF ?
 *
 * POURQUOI CETTE DISTINCTION COMPTE PLUS QU'IL N'Y PARAIT
 *
 * Un appareil qui reessaie un refus definitif le reessaiera a chaque retour de reseau,
 * indefiniment, et la file ne se videra jamais. Un appareil qui abandonne un refus
 * TEMPORAIRE perd une observation de terrain.
 *
 * `CHEVAUCHE_UNE_VALIDEE` est le cas interessant : il est definitif pour CETTE emprise, et
 * l'agent doit requalifier la portion existante au lieu d'en proposer une seconde. Le
 * reessayer ne changerait rien.
 *
 * `LONGUEUR_TRONCON_INCONNUE` est definitif aussi : le troncon n'a pas de trace
 * exploitable, et cela ne changera pas sans une correction de geometrie.
 */
export function refusDefinitif(motif: string): boolean {
  return [
    "PAYLOAD_INVALIDE",
    "BORNES_INVERSEES",
    "HORS_TRONCON",
    "TROP_COURTE",
    "LONGUEUR_TRONCON_INCONNUE",
    "CHEVAUCHE_UNE_VALIDEE",
  ].includes(motif);
}
