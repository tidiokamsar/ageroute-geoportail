import { z } from "zod";

/**
 * La date d'effet d'une portion : DEPUIS QUAND son contenu est vrai SUR LE TERRAIN.
 *
 * Distincte de `observeeLe` (quand on a regarde) et de `createdAt` (quand le systeme l'a
 * enregistre) : voir `bitemporel.ts`. Une route reprise le 15 mars et relevee le 2 avril porte
 * une date d'effet au 15/03.
 *
 * C'EST UN JOUR, PAS UN INSTANT. La colonne est `DATE`. Toute heure recue est ramenee a
 * minuit UTC, sinon le meme jour saisi depuis deux fuseaux donnerait deux dates.
 *
 * JAMAIS DANS LE FUTUR. Un fait de terrain est deja vrai : une date a venir decrirait une
 * prevision, et les previsions relevent d'une autre fonction (scenarios de programmation).
 * La refuser ici evite qu'une faute de frappe sur l'annee place une portion apres tout curseur.
 */

/** Ramene un instant au jour UTC correspondant, a minuit. */
export function jourUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export const dateEffet = z.coerce
  .date()
  .nullish()
  .transform((d) => (d instanceof Date ? jourUtc(d) : d))
  .refine((d) => d == null || d.getTime() <= Date.now(), {
    message: "La date d'effet ne peut pas etre dans le futur : un fait de terrain est deja vrai.",
  });
