/**
 * ORCHESTRATION DE L'IMPORT -- etape 1 : reception et validation du schema.
 *
 * Ce service recoit un fichier au format pivot (ROAD_SURVEY_IMPORT_SPEC.md), l'empreinte, le
 * lit, verifie chaque ligne et enregistre le lot avec TOUTES ses lignes, chacune dans un
 * statut, en une seule transaction auditee. Il ne cree RIEN dans le referentiel.
 *
 * POURQUOI S'ARRETER LA, ET LE DIRE
 *
 * L'etape suivante -- l'APPLICATION, qui cree des propositions `A_VALIDER` dans `troncons`,
 * `portions` ou `defauts` -- exige le rapprochement des identifiants (BDR_ID_CROSSWALK_SPEC.md),
 * qui exige lui-meme un premier echantillon approuve. Rien de cela n'existe. Ecrire
 * l'application sans rapprochement creerait des objets sans lien avec le referentiel, c'est-
 * a-dire exactement les doublons que le paragraphe B.4 interdit. Ce service s'arrete donc au
 * statut `VALIDE_SCHEMA`, et aucune fonction `appliquer` n'est exportee : une fonction qui
 * leverait « non implemente » serait une promesse, et une promesse dans une API est une dette.
 *
 * CE QUE L'ETAPE 1 GARANTIT DEJA, ET PAR QUOI
 *
 *   idempotence (T-06)            l'empreinte SHA-256 est calculee ICI, sur les octets recus,
 *                                 jamais fournie par l'appelant ; si (source, empreinte) existe,
 *                                 le lot existant est rendu et RIEN n'est ecrit -- pas meme un
 *                                 audit, car il n'y a pas d'evenement. Les metadonnees envoyees
 *                                 en plus et DIFFERENTES de celles du lot sont nommees dans la
 *                                 reponse (`metadonneesDifferentes`), jamais ecrasees
 *   100 % dans un statut (A28)    VALIDEE, REJETEE ou IGNOREE par ligne ; les compteurs sont
 *                                 calcules puis RE-VERIFIES par la contrainte en base
 *   erreurs exportables (T-04)    `erreursDuLot` rend un CSV pivot des lignes rejetees et
 *                                 ignorees, avec le motif et la charge originale
 *   provenance (E.3)              source, importateur, autorisation, empreinte, methode,
 *                                 version de mapping, charge originale de chaque ligne
 *   audit                         dans la transaction : un echec d'audit annule le lot
 *
 * CE QUE LA RECEPTION REFUSE AVANT D'ECRIRE QUOI QUE CE SOIT (400, aucun lot)
 *
 *   FORMAT_INCOHERENT     le contenu n'a pas la forme du format declare (binaire, JSON en CSV...)
 *   ENCODAGE_NON_UTF8     octets invalides en UTF-8, ou UTF-16 : jamais de U+FFFD en silence
 *   TROP_DE_LIGNES        plus de LIMITE_LIGNES lignes de donnees (comptees en arretant la lecture tot)
 *   FICHIER_VIDE / FICHIER_TROP_GROS / CHAMPS_INVALIDES / FORMAT_NON_ADMIS
 * et, quand le service est occupe, `ServiceOccupe` (503) : au plus deux receptions a la fois par
 * processus (limiteur.ts), parce que chacune garde une connexion pendant sa transaction.
 *
 * LE SEUL JUGEMENT QUE CE SERVICE PORTE est celui du contrat : une ligne est conforme ou ne
 * l'est pas, et un doublon interne au lot est mis a l'ecart. Il ne compare jamais une ligne au
 * referentiel -- c'est une correspondance, pas une validation de schema.
 */

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient, StatutLigneImport, StatutLotImport } from "@prisma/client";
import { logAuditTransactionnelle } from "../utils/audit";
import { nextNumeroLotImport } from "../lib/numero";
import {
  comptabiliser, compteursComplets, decouperLigneCsv, extrait, horsEtendueAttendue, lireCsv, lireGeoJson,
  marquerDoublonsInternes, verifierLigne, SEPARATEUR_CSV,
  type Compteurs, type LignePivot, type StatutLigne, type VerdictLigne,
} from "./pivot.noyau";
import {
  LIMITE_LIGNES, LIMITE_LIGNES_ERREURS, TAILLE_LOT_INSERTION, TAILLE_TRANCHE_TRAITEMENT,
  assainirNomFichier, comparerMetadonnees, construireErreursCsv, decoderUtf8, estImprimable, nettoyerCharge,
  sourceNormalisee, verifierAutorisationRef, verifierCoherenceFormat,
  type MetadonneeDifferente,
} from "./reception.noyau";
import { ServiceOccupe, limiteurReceptions, type Limiteur } from "./limiteur";

export { ServiceOccupe };

/** Formats que l'etape 1 sait lire. Le GeoPackage est un ecart consigne (pivot.noyau.ts). */
export const FORMATS_ADMIS = ["csv", "geojson"] as const;
export type FormatAdmis = (typeof FORMATS_ADMIS)[number];

/** Taille maximale d'un fichier recu. Au-dela, c'est un transfert a decouper, pas un lot. */
export const TAILLE_MAX_OCTETS = 25 * 1024 * 1024;

export { LIMITE_LIGNES };

export interface DemandeReception {
  fichier: Buffer;
  nomFichier: string;
  format: FormatAdmis;
  systemeSource: string;
  methodeSource: string;
  versionMapping: string;
  /** Reference de l'autorisation ecrite (paragraphe B.4). Jamais vide. */
  autorisationRef: string;
  auteurSource?: string | null;
  dateSource?: Date | null;
  importeParId: string;
  ipAddress?: string;
}

export interface AutreSource { reference: string; systemeSource: string }

export interface LotRecu {
  id: string;
  reference: string;
  statut: StatutLotImport;
  compteurs: Compteurs;
  /** Vrai si le fichier avait deja ete recu : rien n'a ete ecrit. */
  dejaRecu: boolean;
  /** Pourquoi un lot est REJETE dans son ensemble (fichier illisible, CRS refuse). */
  motifRejetLot: string | null;
  /** Remarques non bloquantes sur le contenu (source des lignes, coordonnees hors du pays...). */
  avertissements: string[];
  /** Metadonnees envoyees pour un fichier DEJA recu et differentes de celles du lot (conservees). */
  metadonneesDifferentes: MetadonneeDifferente[];
  /** Les memes octets existent sous une AUTRE source : un nouveau lot est cree, mais il est signale. */
  memeEmpreinteAutresSources: AutreSource[];
}

export class DemandeInvalide extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** Le minimum de Prisma dont ce service a besoin, pour qu'un test le remplace sans base. */
export type DepotImport = Pick<PrismaClient, "$transaction" | "lotImport" | "ligneImport">;

export function empreinteSha256(octets: Buffer): string {
  return createHash("sha256").update(octets).digest("hex");
}

/** Cede la main a la boucle d'evenements : un traitement long ne doit pas affamer les autres requetes. */
const cedre = () => new Promise<void>((r) => setImmediate(r));

type Lecture =
  | { ok: true; lignes: Record<string, unknown>[]; anomalies: Map<number, string> }
  | { ok: false; motif: string };

/**
 * Lit le fichier selon son format et rend les lignes BRUTES, ou le motif pour lequel le fichier
 * entier est irrecevable. Un CRS refuse rejette le fichier, pas ses lignes : aucune d'elles
 * n'est en 4326. Un fichier de plus de LIMITE_LIGNES lignes est une DEMANDE refusee (400).
 */
function lireFichier(format: FormatAdmis, texte: string): Lecture {
  if (format === "csv") {
    const { entete, lignes, anomalies, entetesDupliques, depasse } = lireCsv(texte, SEPARATEUR_CSV, { maxLignes: LIMITE_LIGNES });
    if (depasse) throw trop();
    if (entete.length === 0) return { ok: false, motif: "CSV vide : aucun en-tete" };
    if (entete.some((h) => !estImprimable(h) || h.includes("\u0000"))) return { ok: false, motif: "CSV : l'en-tete contient un caractere de controle" };
    if (entetesDupliques.length > 0) {
      return { ok: false, motif: `CSV : colonne presente plusieurs fois dans l'en-tete : ${entetesDupliques.slice(0, 5).map((h) => extrait(h, 40)).join(", ")}` };
    }
    for (const requis of ["systeme_source", "type_objet", "identifiant_source"]) {
      if (!entete.includes(requis)) return { ok: false, motif: `CSV : colonne obligatoire absente de l'en-tete : ${requis}` };
    }
    return { ok: true, lignes, anomalies };
  }
  let doc: unknown;
  try { doc = JSON.parse(texte); } catch { return { ok: false, motif: "GeoJSON : JSON invalide" }; }
  const g = lireGeoJson(doc, { maxLignes: LIMITE_LIGNES });
  if (!g.ok) return g;
  if (g.depasse) throw trop();
  return { ok: true, lignes: g.lignes, anomalies: new Map() };
}

const trop = () => new DemandeInvalide("TROP_DE_LIGNES",
  `le fichier contient plus de ${LIMITE_LIGNES} lignes de donnees (limite provisoire) : decoupez-le en plusieurs lots`);

function verifierDemande(d: DemandeReception): void {
  if (!(FORMATS_ADMIS as readonly string[]).includes(d.format)) {
    throw new DemandeInvalide("FORMAT_NON_ADMIS", `format non admis : ${extrait(d.format, 20)} ; admis : ${FORMATS_ADMIS.join(", ")}`);
  }
  if (d.fichier.length === 0) throw new DemandeInvalide("FICHIER_VIDE", "fichier vide");
  if (d.fichier.length > TAILLE_MAX_OCTETS) {
    throw new DemandeInvalide("FICHIER_TROP_GROS", `fichier de ${d.fichier.length} octets, maximum ${TAILLE_MAX_OCTETS}`);
  }
  for (const [k, v] of Object.entries({
    systemeSource: d.systemeSource, methodeSource: d.methodeSource,
    versionMapping: d.versionMapping, autorisationRef: d.autorisationRef, nomFichier: d.nomFichier,
  })) {
    if (typeof v !== "string" || v.trim().length === 0) throw new DemandeInvalide("CHAMPS_INVALIDES", `${k} manquant`);
    // Un caractere de controle (NUL surtout) faisait echouer l'ecriture en 500 : c'est une demande invalide.
    if (k !== "nomFichier" && !estImprimable(v)) throw new DemandeInvalide("CHAMPS_INVALIDES", `${k} : caracteres imprimables uniquement`);
  }
  const refAutorisation = verifierAutorisationRef(d.autorisationRef);
  if (refAutorisation) throw new DemandeInvalide("CHAMPS_INVALIDES", `autorisationRef : ${refAutorisation}`);
  if (d.auteurSource && !estImprimable(d.auteurSource)) throw new DemandeInvalide("CHAMPS_INVALIDES", "auteurSource : caracteres imprimables uniquement");
  if (d.dateSource && (Number.isNaN(d.dateSource.getTime()) || d.dateSource.getUTCFullYear() < 1900 || d.dateSource.getUTCFullYear() > 2100)) {
    throw new DemandeInvalide("CHAMPS_INVALIDES", "dateSource : date hors de la plage 1900-2100");
  }
}

type LotExistant = NonNullable<Awaited<ReturnType<DepotImport["lotImport"]["findUnique"]>>>;

/** Le lot deja enregistre pour ce fichier : rien n'est ecrit, pas meme un audit. */
function lotDejaRecu(existant: LotExistant): LotRecu {
  const rapport = (existant.rapport ?? {}) as { motifRejetLot?: string; avertissements?: unknown };
  return {
    id: existant.id, reference: existant.reference, statut: existant.statut, dejaRecu: true,
    motifRejetLot: rapport.motifRejetLot ?? null,
    compteurs: {
      lues: existant.lignesLues, validees: existant.lignesValidees, importees: existant.lignesImportees,
      rejetees: existant.lignesRejetees, enConflit: existant.lignesEnConflit, ignorees: existant.lignesIgnorees,
    },
    avertissements: Array.isArray(rapport.avertissements) ? rapport.avertissements.filter((a): a is string => typeof a === "string") : [],
    metadonneesDifferentes: [], memeEmpreinteAutresSources: [],
  };
}

/** Les lots qui portent les MEMES octets sous une autre source (au plus vingt). */
async function autresSources(depot: DepotImport, empreinte: string, source: string): Promise<AutreSource[]> {
  return depot.lotImport.findMany({
    where: { empreinteFichier: empreinte, NOT: { systemeSource: source } },
    select: { reference: true, systemeSource: true },
    orderBy: { importeLe: "asc" }, take: 20,
  });
}

/** Un avertissement par source qui ne differe que par la casse ou les blancs : c'est presque sur un doublon. */
function avertissementsVariantesDeSource(source: string, autres: AutreSource[]): string[] {
  const n = sourceNormalisee(source);
  return autres.filter((a) => sourceNormalisee(a.systemeSource) === n).map((a) =>
    `Ce fichier existe deja sous la source « ${extrait(a.systemeSource, 64)} » (lot ${a.reference}), qui ne differe de « ${extrait(source, 64)} » que par la casse ou les espaces : verifiez qu'il ne s'agit pas d'un doublon.`);
}

/** Resume non bloquant des lignes dont `systeme_source` n'est pas celui du lot (jamais corrige en silence). */
function avertissementSourceDesLignes(source: string, comptes: Map<string, number>): string[] {
  if (comptes.size === 0) return [];
  const total = [...comptes.values()].reduce((a, b) => a + b, 0);
  const valeurs = [...comptes.keys()].slice(0, 5).map((v) => `« ${extrait(v, 40)} »`).join(", ");
  return [`${total} ligne${total > 1 ? "s portent" : " porte"} un systeme_source different de la source du lot « ${extrait(source, 64)} » : ${valeurs}. Les valeurs ne sont pas corrigees.`];
}

interface Annexes { metadonneesDifferentes: MetadonneeDifferente[]; memeEmpreinteAutresSources: AutreSource[]; avertissements: string[] }

async function annexesDuDejaRecu(depot: DepotImport, d: DemandeReception, existant: LotExistant, empreinte: string, source: string): Promise<Annexes> {
  const autres = await autresSources(depot, empreinte, source);
  return {
    metadonneesDifferentes: comparerMetadonnees(
      { autorisationRef: d.autorisationRef, versionMapping: d.versionMapping, methodeSource: d.methodeSource, auteurSource: d.auteurSource, dateSource: d.dateSource },
      { autorisationRef: existant.autorisationRef, versionMapping: existant.versionMapping, methodeSource: existant.methodeSource, auteurSource: existant.auteurSource, dateSource: existant.dateSource },
    ),
    memeEmpreinteAutresSources: autres,
    avertissements: avertissementsVariantesDeSource(source, autres),
  };
}

export interface OptionsReception { limiteur?: Limiteur }

/**
 * Recoit un lot : empreinte, idempotence, lecture, verification, enregistrement transactionnel.
 */
export async function recevoirLot(depot: DepotImport, demande: DemandeReception, options: OptionsReception = {}): Promise<LotRecu> {
  verifierDemande(demande);
  const d: DemandeReception = { ...demande, systemeSource: demande.systemeSource.trim(), nomFichier: assainirNomFichier(demande.nomFichier) };

  // La FORME du contenu d'abord : avant l'empreinte, avant toute lecture, avant toute ecriture.
  const coherence = verifierCoherenceFormat(d.format, d.fichier);
  if (!coherence.ok) throw new DemandeInvalide("FORMAT_INCOHERENT", coherence.motif);

  const empreinte = empreinteSha256(d.fichier);
  const cleUnique = { systemeSource_empreinteFichier: { systemeSource: d.systemeSource, empreinteFichier: empreinte } };

  // IDEMPOTENCE : avant toute lecture. Le meme fichier, pour la meme source, est deja un lot.
  const existant = await depot.lotImport.findUnique({ where: cleUnique });
  if (existant) return { ...lotDejaRecu(existant), ...(await annexesDuDejaRecu(depot, d, existant, empreinte, d.systemeSource)) };

  // ENCODAGE : strict. Un octet invalide n'est jamais remplace en silence par U+FFFD.
  const decode = decoderUtf8(d.fichier);
  if (!decode.ok) throw new DemandeInvalide("ENCODAGE_NON_UTF8", decode.motif);

  return (options.limiteur ?? limiteurReceptions).executer(async () => {
    const aujourdhui = new Date();
    await cedre();
    const lecture = lireFichier(d.format, decode.texte);
    await cedre();

    // Lignes nettoyees (NUL, substituts isoles), verifiees une a une, puis doublons internes marques.
    // Par tranches : la boucle d'evenements reprend la main entre deux tranches.
    const charges: Record<string, unknown>[] = [];
    const entrees: { numeroLigne: number; verdict: VerdictLigne }[] = [];
    const sourcesDifferentes = new Map<string, number>();
    let horsPays = 0; let premiereHorsPays = 0;
    if (lecture.ok) {
      const brutes = lecture.lignes;
      for (let debut = 0; debut < brutes.length; debut += TAILLE_TRANCHE_TRAITEMENT) {
        for (let i = debut; i < Math.min(debut + TAILLE_TRANCHE_TRAITEMENT, brutes.length); i += 1) {
          const nettoyee = nettoyerCharge(brutes[i]);
          charges.push(nettoyee.propre);
          let verdict: VerdictLigne;
          if (lecture.anomalies.has(i)) {
            // Un enregistrement de forme douteuse (colonnes en trop ou en moins, guillemet ouvert) est
            // refuse AVANT toute verification de contenu : ses valeurs ne sont pas fiables.
            verdict = { ok: false, motif: lecture.anomalies.get(i)! };
          } else if (nettoyee.motif) {
            verdict = { ok: false, motif: nettoyee.motif };
          } else {
            try { verdict = verifierLigne(nettoyee.propre, { aujourdhui }); }
            catch { verdict = { ok: false, motif: "ligne illisible : sa structure ne peut pas etre verifiee" }; }
          }
          entrees.push({ numeroLigne: i + 1, verdict });
          const src = typeof nettoyee.propre.systeme_source === "string" ? nettoyee.propre.systeme_source.trim() : "";
          if (src !== "" && src !== d.systemeSource) sourcesDifferentes.set(src, (sourcesDifferentes.get(src) ?? 0) + 1);
          if (verdict.ok && verdict.ligne.geometrie && horsEtendueAttendue(verdict.ligne.geometrie)) {
            horsPays += 1; if (premiereHorsPays === 0) premiereHorsPays = i + 1;
          }
        }
        await cedre();
      }
    }
    const marquees = marquerDoublonsInternes(entrees);
    const compteurs = comptabiliser(marquees.map((m) => m.statut));
    if (!compteursComplets(compteurs)) {
      // Impossible par construction ; si cela arrivait, mieux vaut un echec franc qu'un lot faux.
      throw new Error("comptabilisation incoherente : une ligne sans statut");
    }

    const statut: StatutLotImport = !lecture.ok || compteurs.validees === 0 ? "REJETE" : "VALIDE_SCHEMA";
    const motifRejetLot = !lecture.ok ? lecture.motif : compteurs.validees === 0 && compteurs.lues > 0
      ? "aucune ligne conforme au contrat" : compteurs.lues === 0 ? "aucune ligne" : null;

    const avertissements = [
      ...avertissementSourceDesLignes(d.systemeSource, sourcesDifferentes),
      ...(horsPays > 0
        ? [`${horsPays} ligne${horsPays > 1 ? "s ont" : " a"} des coordonnees hors de l'etendue attendue du pays (premiere : ligne ${premiereHorsPays}). Verifiez l'ordre longitude, latitude. Les lignes sont conservees telles quelles.`]
        : []),
    ];

    const rapport = {
      motifRejetLot,
      compteurs,
      // Les dix premiers motifs de rejet, pour que le rapport se lise sans le CSV d'erreurs.
      premiersRejets: marquees.filter((m) => m.statut !== "VALIDEE").slice(0, 10)
        .map((m) => ({ numeroLigne: m.numeroLigne, statut: m.statut, motif: m.motif })),
      avertissements,
    };

    // Les memes octets sous une autre source : signale, jamais bloquant.
    const autres = await autresSources(depot, empreinte, d.systemeSource);

    const enregistrer = () => depot.$transaction(async (tx) => {
      const reference = await nextNumeroLotImport((s) => tx.lotImport.count({ where: { reference: { startsWith: s } } }));

      const lot = await tx.lotImport.create({
        data: {
          reference,
          systemeSource: d.systemeSource,
          format: d.format,
          empreinteFichier: empreinte,
          nomFichier: d.nomFichier,
          tailleOctets: BigInt(d.fichier.length),
          importeParId: d.importeParId,
          auteurSource: d.auteurSource?.trim() || null,
          dateSource: d.dateSource ?? null,
          methodeSource: d.methodeSource.trim(),
          versionMapping: d.versionMapping.trim(),
          autorisationRef: d.autorisationRef.trim(),
          statut,
          lignesLues: compteurs.lues,
          lignesValidees: compteurs.validees,
          lignesImportees: 0,
          lignesRejetees: compteurs.rejetees,
          lignesEnConflit: 0,
          lignesIgnorees: compteurs.ignorees,
          rapport: rapport as unknown as Prisma.InputJsonValue,
        },
      });

      // Par lots de TAILLE_LOT_INSERTION : une seule requete de 20 000 lignes monopolisait la
      // connexion, la memoire et la base. Meme transaction : tout ou rien.
      for (let debut = 0; debut < marquees.length; debut += TAILLE_LOT_INSERTION) {
        await tx.ligneImport.createMany({
          data: marquees.slice(debut, debut + TAILLE_LOT_INSERTION).map((m, k) => ({
            lotId: lot.id,
            numeroLigne: m.numeroLigne,
            identifiantSource: m.ligne?.identifiantSource ?? null,
            chargeOriginale: charges[debut + k] as unknown as Prisma.InputJsonValue,
            transformations: [] as unknown as Prisma.InputJsonValue,
            statut: m.statut as StatutLigneImport,
            motifRejet: m.motif,
          })),
        });
      }

      // CREATE et non une valeur « IMPORT » : `AuditAction` ne la connait pas, et l'ajouter serait
      // un ALTER TYPE ADD VALUE irreversible (lecon D-06). Ce qui est cree est un lot ; ce qu'il
      // contient -- source, empreinte, autorisation, compteurs -- est dans `after`.
      await logAuditTransactionnelle(tx, {
        userId: d.importeParId,
        action: "CREATE",
        entityType: "LotImport",
        entityId: lot.id,
        after: { reference, systemeSource: lot.systemeSource, empreinteFichier: empreinte, statut, compteurs, autorisationRef: lot.autorisationRef },
        ipAddress: d.ipAddress,
      });

      const recu: LotRecu = {
        id: lot.id, reference, statut, compteurs, dejaRecu: false, motifRejetLot,
        avertissements: [...avertissements, ...avertissementsVariantesDeSource(d.systemeSource, autres)],
        metadonneesDifferentes: [], memeEmpreinteAutresSources: autres,
      };
      return recu;
      // Les 120 s d'origine tenaient une connexion deux minutes : avec la limite de lignes, 60 s suffisent largement.
    }, { timeout: 60_000, maxWait: 30_000 });

    /**
     * DEUX ENVOIS SIMULTANES PEUVENT SE CROISER. Chacun a lu « pas encore recu », chacun enregistre :
     * l'unicite en base laisse passer le premier et refuse le second (violation d'unicite). Sans
     * traitement, le second repondait par une erreur, alors que son fichier venait d'etre recu.
     *   - si le lot du meme fichier existe maintenant, c'est lui qui est rendu (rien n'est ecrit) ;
     *   - sinon l'unicite violee est celle de la REFERENCE (numero compte pendant que l'autre
     *     transaction numerotait la sienne) : on recommence avec un numero a jour. Apres huit
     *     essais, c'est un service OCCUPE (503), pas un conflit de valeur unique (409).
     */
    for (let essai = 1; ; essai += 1) {
      try {
        return await enregistrer();
      } catch (err) {
        const code = typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
        if (code === "P2024" || code === "P2028") throw new ServiceOccupe("Le service est surcharge (connexion ou delai de traitement) : reessayez dans quelques instants.");
        if (code !== "P2002") throw err;
        const recu = await depot.lotImport.findUnique({ where: cleUnique });
        if (recu) return { ...lotDejaRecu(recu), ...(await annexesDuDejaRecu(depot, d, recu, empreinte, d.systemeSource)) };
        if (essai >= 8) throw new ServiceOccupe("Le service numerote deja d'autres lots : reessayez dans quelques instants.");
        // Un court delai aleatoire disperse les concurrents : sans lui, ils recomptent ensemble et se heurtent a nouveau.
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 40));
      }
    }
  });
}

/**
 * Les lignes rejetees et ignorees d'un lot, en CSV pivot d'erreurs (T-04) : une ligne par
 * erreur, la regle violee, et la charge originale pour que la source retrouve la sienne.
 * Formules neutralisees (cellule precedee d'une apostrophe) et volume borne : voir reception.noyau.ts.
 */
export async function exporterErreurs(depot: DepotImport, lotId: string): Promise<{ csv: string; exportees: number; total: number; tronque: boolean }> {
  const where = { lotId, statut: { in: ["REJETEE", "IGNOREE"] as StatutLigneImport[] } };
  const [total, lignes] = await Promise.all([
    depot.ligneImport.count({ where }),
    // Une de plus que la limite d'export suffit a savoir si l'export est tronque ; le reste n'est pas lu.
    depot.ligneImport.findMany({ where, orderBy: { numeroLigne: "asc" }, take: LIMITE_LIGNES_ERREURS + 1 }),
  ]);
  const r = construireErreursCsv(lignes, total, SEPARATEUR_CSV);
  return { ...r, total };
}

export async function erreursDuLot(depot: DepotImport, lotId: string): Promise<string> {
  return (await exporterErreurs(depot, lotId)).csv;
}

/** Reexporte pour la route, qui n'a pas a connaitre le noyau. */
export { decouperLigneCsv };
export type { LignePivot, StatutLigne };
