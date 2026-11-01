/**
 * FICHE D'INTERVENTION FIGEE (paragraphe 7.7). Aucun acces base.
 *
 * « Fiche d'intervention = objet unitaire transmis a DigitalRoad ; VERSION FIGEE a la
 * transmission. » (MAINTENANCE_PROGRAMMING_DESIGN.md, paragraphe 5.3.) Ce qui a ete decide ne
 * change pas de sens parce que les parametres, les baremes ou le catalogue changent ensuite : la
 * fiche embarque donc tout ce qu'il faut pour la relire seule, y compris une COPIE INTEGRALE des
 * parametres de programmation, et elle est scellee par l'empreinte SHA-256 de son texte canonique
 * (voir `canonique.ts`). Cette empreinte est la « version figee » exigee par
 * `cycle-vie.noyau.ts` a l'entree en TRANSMIS.
 *
 * L'HORODATAGE N'EST PAS DANS LE CONTENU. L'instant du gel est pose par le serveur de base de
 * donnees (declencheur) a cote du texte. S'il etait dans le texte, deux gels du meme scenario
 * donneraient deux empreintes et le « meme contenu, meme empreinte » ne se verifierait plus. Le
 * contenu, lui, ne depend que du scenario : memes entrees, meme fiche, octet pour octet.
 *
 * UNE LIGNE ECARTEE NE SE FIGE PAS : une fiche decrit une intervention retenue, avec son cout.
 *
 * Le niveau de financement n'est pas calcule : le moteur ne sait pas quelle enveloppe (FER, budget
 * national, bailleur) paiera. La fiche porte `financement.source` tel que l'agent le declare au
 * moment du gel, ou `null`.
 */

import { canonique, estCanonique, sha256Hex } from "./canonique";
import { AVERTISSEMENT_SANS_ENGAGEMENT, type LigneScenario, type Scenario } from "./scenario.noyau";
import { etiquetteParametres, type ParametresProgrammation } from "./parametres.noyau";

export const SCHEMA_FICHE = "fiche-intervention/1";

export interface ContexteFiche {
  /** Identifiant du scenario en base (provenance). `null` hors persistance. */
  scenarioId: string | null;
  /** Empreinte SHA-256 du resultat canonique du scenario d'ou la ligne est tiree. */
  empreinteScenario: string;
  /** Source de financement declaree par l'agent, ou `null`. Jamais deduite. */
  sourceFinancement: string | null;
  /** Les parametres utilises : ils sont recopies en entier dans la fiche. */
  parametres: ParametresProgrammation;
}

export type CodeRefusFiche = "LIGNE_NON_RETENUE" | "LIGNE_INCOMPLETE";

export type ContenuFiche = Record<string, unknown>;

export type ResultatContenu = { ok: true; contenu: ContenuFiche } | { ok: false; code: CodeRefusFiche; motif: string };

export function contenuFiche(ligne: LigneScenario, scenario: Scenario, ctx: ContexteFiche): ResultatContenu {
  if (ligne.decision !== "RETENUE") {
    return { ok: false, code: "LIGNE_NON_RETENUE", motif: `le troncon ${ligne.troncon.code} est ecarte (${ligne.motifExclusion?.code ?? "?"}) : une fiche ne decrit qu'une intervention retenue` };
  }
  if (!ligne.cout || !ligne.cout.ok || !ligne.traitement || !ligne.traitement.ok || !ligne.risque.ok || ligne.troncon.longueurM === null) {
    return { ok: false, code: "LIGNE_INCOMPLETE", motif: `la ligne retenue du troncon ${ligne.troncon.code} n'a pas tous ses elements (risque, traitement, cout, longueur)` };
  }
  const t = ligne.troncon;
  return {
    ok: true,
    contenu: {
      schema: SCHEMA_FICHE,
      methode: scenario.methode,
      annee: scenario.annee,
      scenario: { id: ctx.scenarioId, empreinteResultat: ctx.empreinteScenario, budgetGnf: scenario.budgetGnf },
      parametres: {
        version: ctx.parametres.version, source: ctx.parametres.source, approuveeLe: ctx.parametres.approuveeLe,
        approuveeParId: ctx.parametres.approuveeParId, etiquette: etiquetteParametres(ctx.parametres),
        valeurs: ctx.parametres.valeurs,
      },
      patrimoine: {
        tronconId: t.id, code: t.code, nom: t.nom, regionId: t.regionId, classe: t.classe, revetement: t.revetement, etat: t.etat,
        plage: { debutM: 0, finM: t.longueurM, unite: "m" },
      },
      traitement: ligne.traitement,
      quantites: { longueurM: t.longueurM, unite: "m", niveauMesure: "REFERENTIEL" },
      cout: ligne.cout,
      score: {
        risque: ligne.risque, risqueAttendu: ligne.risqueAttendu, projection: ligne.projection, priorite: ligne.priorite,
        rangPriorite: ligne.rangPriorite, rangRetenu: ligne.rangRetenu,
      },
      budget: ligne.budget,
      justification: ligne.justification,
      financement: { source: ctx.sourceFinancement, note: "source de financement declaree par l'agent au gel ; le moteur ne l'a pas deduite" },
      provisoire: scenario.provisoire,
      etiquette: scenario.etiquette,
      motifsProvisoire: scenario.motifsProvisoire,
      limites: scenario.limites,
      avertissement: AVERTISSEMENT_SANS_ENGAGEMENT,
    },
  };
}

export interface FicheFigee {
  contenuCanonique: string;
  empreinteSha256: string;
  reference: string;
}

/** Texte canonique, empreinte et reference lisible (annee + dix premiers caracteres de l'empreinte). */
export function figer(contenu: ContenuFiche): FicheFigee {
  const contenuCanonique = canonique(contenu);
  const empreinteSha256 = sha256Hex(contenuCanonique);
  return { contenuCanonique, empreinteSha256, reference: `FI-${String(contenu.annee)}-${empreinteSha256.slice(0, 10).toUpperCase()}` };
}

export type VerdictFiche = { ok: true } | { ok: false; code: "EMPREINTE_DIFFERENTE" | "TEXTE_NON_CANONIQUE" | "SCHEMA_INCONNU"; motif: string };

/** Relit une fiche stockee : texte canonique, bon schema, empreinte egale a celle du texte. */
export function verifierFiche(contenuCanonique: string, empreinteAttendue: string): VerdictFiche {
  if (!estCanonique(contenuCanonique)) return { ok: false, code: "TEXTE_NON_CANONIQUE", motif: "le texte stocke n'est pas sous sa forme canonique" };
  if ((JSON.parse(contenuCanonique) as { schema?: unknown }).schema !== SCHEMA_FICHE) return { ok: false, code: "SCHEMA_INCONNU", motif: `schema different de ${SCHEMA_FICHE}` };
  const calculee = sha256Hex(contenuCanonique);
  if (calculee !== empreinteAttendue) return { ok: false, code: "EMPREINTE_DIFFERENTE", motif: `empreinte recalculee ${calculee} differente de l'empreinte stockee ${empreinteAttendue}` };
  return { ok: true };
}
