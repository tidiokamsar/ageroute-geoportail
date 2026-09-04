import { prisma } from "./prisma";

/**
 * Provenance des valeurs saisies dans l'application.
 *
 * LE DEFAUT QUE CE MODULE CORRIGE
 *
 * Constate le 04/09/2026, par accident. Un script comblait les revetements inconnus ;
 * une ligne resistait — « 2e Boulevard », qu'un agent avait corrigee depuis
 * l'interface le matin meme. Sa valeur etait bonne. Sa ligne de `valeurs_qualite`
 * disait toujours « ABSENT_DE_LA_SOURCE ».
 *
 * Autrement dit : les scripts d'import et de promotion entretenaient la tracabilite,
 * l'interface non. Chaque correction faite a la main degradait silencieusement
 * l'appareil meme qui sert a distinguer ce qu'on sait de ce qu'on suppose. Avec
 * 1,2 million de lignes de qualite en base, cette asymetrie l'aurait fait pourrir par
 * le milieu — sans qu'aucune erreur n'apparaisse jamais.
 *
 * UNE SAISIE EST LA MEILLEURE PROVENANCE DISPONIBLE
 *
 * Elle passe en OBSERVED, avec l'auteur et la date. Ce n'est pas une inspection
 * formelle, mais c'est un humain qui affirme, ici et maintenant, contre un import qui
 * ne dit rien de personne. Le champ `observedById` existait deja dans le modele et
 * n'etait alimente nulle part.
 *
 * CE QU'IL NE FAIT PAS
 *
 * Il n'invente pas de ligne pour un champ absent de la requete. Modifier le nom d'un
 * troncon ne dit rien de son revetement, et pretendre le contraire serait le meme
 * genre de mensonge, en sens inverse.
 */

/**
 * Champs dont la provenance est suivie, par type d'entite.
 *
 * Volontairement restreint aux valeurs qui portent une DECISION : l'etat commande la
 * programmation des travaux, le revetement et la longueur commandent les couts. Le
 * reste — observations, coordonnees de contact — n'a pas besoin d'un appareil de
 * confiance, et en suivre trop noierait le signal.
 */
export const CHAMPS_SUIVIS: Record<string, readonly string[]> = {
  Troncon: ["etat", "revetement", "longueurKm", "pkDebut", "pkFin", "regionId", "nom", "classe"],
  Ouvrage: ["etat", "typeOuvrage", "longueurM", "regionId"],
  Chantier: ["regionId", "statut", "avancementPct", "montantGnf"],
};

/**
 * Construit les ecritures de provenance SANS les executer.
 *
 * POURQUOI RENDRE DES PROMESSES PLUTOT QU'ECRIRE
 *
 * L'appelant les passe a `prisma.$transaction([...])` avec sa propre mise a jour :
 * la valeur et sa provenance changent ensemble, ou pas du tout. Un echec entre les
 * deux laisserait une valeur sans provenance, ou une provenance sans valeur, et rien
 * ne permettrait de savoir laquelle croire.
 *
 * Un premier montage passait un client transactionnel a ce module, qui retrouvait le
 * modele par son nom. Il fonctionnait, mais court-circuitait le delegue injecte dans
 * la fabrique CRUD — et le test qui verifie cet appel s'est mis a echouer. Rendre des
 * promesses laisse l'appelant maitre de SON modele.
 */
export function construireSaisies(
  entityType: keyof typeof CHAMPS_SUIVIS | string,
  entityId: string,
  donnees: Record<string, unknown>,
  auteurId: string,
): unknown[] {
  const suivis = CHAMPS_SUIVIS[entityType];
  if (!suivis) return [];

  // Seuls les champs REELLEMENT presents dans la requete. `undefined` signifie « non
  // touche » ; `null` est une valeur, et efface donc bien ce qu'on croyait savoir.
  const champs = suivis.filter((c) => Object.prototype.hasOwnProperty.call(donnees, c));
  if (champs.length === 0) return [];

  const client = prisma as unknown as {
    valeurQualite: { upsert: (args: unknown) => unknown };
  };
  const observedAt = new Date();
  const ecritures: unknown[] = [];

  for (const champ of champs) {
    const commun = {
      statut: "OBSERVED" as const,
      source: "SAISIE_APPLICATIVE",
      methode: "SAISIE_MANUELLE",
      observedAt,
      observedById: auteurId,
      confiance: "MEDIUM" as const,
      // MEDIUM et non HIGH : un agent qui corrige une fiche depuis un bureau sait
      // souvent, mais n'a pas mesure. HIGH reste pour un releve de terrain date.
      note: `Valeur saisie dans l'application le ${observedAt.toISOString().slice(0, 10)}.`,
    };
    ecritures.push(client.valeurQualite.upsert({
      where: { entityType_entityId_champ: { entityType, entityId, champ } },
      create: { entityType, entityId, champ, ...commun },
      update: commun,
    }));
  }
  return ecritures;
}

/** Variante immediate, pour un appelant sans transaction en cours. */
export async function enregistrerSaisie(
  entityType: string,
  entityId: string,
  donnees: Record<string, unknown>,
  auteurId: string,
): Promise<number> {
  const ecritures = construireSaisies(entityType, entityId, donnees, auteurId);
  await Promise.all(ecritures as Promise<unknown>[]);
  return ecritures.length;
}
