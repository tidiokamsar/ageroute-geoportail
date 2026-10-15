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
 *                                 audit, car il n'y a pas d'evenement
 *   100 % dans un statut (A28)    VALIDEE, REJETEE ou IGNOREE par ligne ; les compteurs sont
 *                                 calcules puis RE-VERIFIES par la contrainte en base
 *   erreurs exportables (T-04)    `erreursDuLot` rend un CSV pivot des lignes rejetees et
 *                                 ignorees, avec le motif et la charge originale
 *   provenance (E.3)              source, importateur, autorisation, empreinte, methode,
 *                                 version de mapping, charge originale de chaque ligne
 *   audit                         dans la transaction : un echec d'audit annule le lot
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
  comptabiliser, compteursComplets, decouperLigneCsv, lireCsv, lireGeoJson,
  marquerDoublonsInternes, verifierLigne, SEPARATEUR_CSV,
  type Compteurs, type LignePivot, type StatutLigne,
} from "./pivot.noyau";

/** Formats que l'etape 1 sait lire. Le GeoPackage est un ecart consigne (pivot.noyau.ts). */
export const FORMATS_ADMIS = ["csv", "geojson"] as const;
export type FormatAdmis = (typeof FORMATS_ADMIS)[number];

/** Taille maximale d'un fichier recu. Au-dela, c'est un transfert a decouper, pas un lot. */
export const TAILLE_MAX_OCTETS = 50 * 1024 * 1024;

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

export interface LotRecu {
  id: string;
  reference: string;
  statut: StatutLotImport;
  compteurs: Compteurs;
  /** Vrai si le fichier avait deja ete recu : rien n'a ete ecrit. */
  dejaRecu: boolean;
  /** Pourquoi un lot est REJETE dans son ensemble (fichier illisible, CRS refuse). */
  motifRejetLot: string | null;
}

export class DemandeInvalide extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** Le minimum de Prisma dont ce service a besoin, pour qu'un test le remplace sans base. */
export type DepotImport = Pick<PrismaClient, "$transaction" | "lotImport" | "ligneImport">;

export function empreinteSha256(octets: Buffer): string {
  return createHash("sha256").update(octets).digest("hex");
}

/**
 * Lit le fichier selon son format et rend les lignes BRUTES, ou le motif pour lequel le fichier
 * entier est irrecevable. Un CRS refuse rejette le fichier, pas ses lignes : aucune d'elles
 * n'est en 4326.
 */
function lireFichier(format: FormatAdmis, octets: Buffer): { ok: true; lignes: Record<string, unknown>[] } | { ok: false; motif: string } {
  const texte = octets.toString("utf8");
  if (format === "csv") {
    const { entete, lignes } = lireCsv(texte, SEPARATEUR_CSV);
    if (entete.length === 0) return { ok: false, motif: "CSV vide : aucun en-tete" };
    for (const requis of ["systeme_source", "type_objet", "identifiant_source"]) {
      if (!entete.includes(requis)) return { ok: false, motif: `CSV : colonne obligatoire absente de l'en-tete : ${requis}` };
    }
    return { ok: true, lignes };
  }
  let doc: unknown;
  try { doc = JSON.parse(texte); } catch { return { ok: false, motif: "GeoJSON : JSON invalide" }; }
  return lireGeoJson(doc);
}

function verifierDemande(d: DemandeReception): void {
  if (!(FORMATS_ADMIS as readonly string[]).includes(d.format)) {
    throw new DemandeInvalide("FORMAT_NON_ADMIS", `format non admis : ${d.format} ; admis : ${FORMATS_ADMIS.join(", ")}`);
  }
  if (d.fichier.length === 0) throw new DemandeInvalide("FICHIER_VIDE", "fichier vide");
  if (d.fichier.length > TAILLE_MAX_OCTETS) {
    throw new DemandeInvalide("FICHIER_TROP_GROS", `fichier de ${d.fichier.length} octets, maximum ${TAILLE_MAX_OCTETS}`);
  }
  for (const [k, v] of Object.entries({
    systemeSource: d.systemeSource, methodeSource: d.methodeSource,
    versionMapping: d.versionMapping, autorisationRef: d.autorisationRef, nomFichier: d.nomFichier,
  })) {
    if (typeof v !== "string" || v.trim().length === 0) throw new DemandeInvalide("CHAMP_MANQUANT", `${k} manquant`);
  }
}

/**
 * Recoit un lot : empreinte, idempotence, lecture, verification, enregistrement transactionnel.
 */
export async function recevoirLot(depot: DepotImport, d: DemandeReception): Promise<LotRecu> {
  verifierDemande(d);
  const empreinte = empreinteSha256(d.fichier);

  // IDEMPOTENCE : avant toute lecture. Le meme fichier, pour la meme source, est deja un lot.
  const existant = await depot.lotImport.findUnique({
    where: { systemeSource_empreinteFichier: { systemeSource: d.systemeSource, empreinteFichier: empreinte } },
  });
  if (existant) {
    return {
      id: existant.id, reference: existant.reference, statut: existant.statut, dejaRecu: true,
      motifRejetLot: (existant.rapport as { motifRejetLot?: string } | null)?.motifRejetLot ?? null,
      compteurs: {
        lues: existant.lignesLues, validees: existant.lignesValidees, importees: existant.lignesImportees,
        rejetees: existant.lignesRejetees, enConflit: existant.lignesEnConflit, ignorees: existant.lignesIgnorees,
      },
    };
  }

  const lecture = lireFichier(d.format, d.fichier);

  // Lignes verifiees une a une, puis doublons internes marques.
  const marquees = lecture.ok
    ? marquerDoublonsInternes(lecture.lignes.map((brute, i) => ({ numeroLigne: i + 1, verdict: verifierLigne(brute) })))
    : [];
  const compteurs = comptabiliser(marquees.map((m) => m.statut));
  if (!compteursComplets(compteurs)) {
    // Impossible par construction ; si cela arrivait, mieux vaut un echec franc qu'un lot faux.
    throw new Error("comptabilisation incoherente : une ligne sans statut");
  }

  const statut: StatutLotImport = !lecture.ok || compteurs.validees === 0 ? "REJETE" : "VALIDE_SCHEMA";
  const motifRejetLot = !lecture.ok ? lecture.motif : compteurs.validees === 0 && compteurs.lues > 0
    ? "aucune ligne conforme au contrat" : compteurs.lues === 0 ? "aucune ligne" : null;

  const rapport = {
    motifRejetLot,
    compteurs,
    // Les dix premiers motifs de rejet, pour que le rapport se lise sans le CSV d'erreurs.
    premiersRejets: marquees.filter((m) => m.statut !== "VALIDEE").slice(0, 10)
      .map((m) => ({ numeroLigne: m.numeroLigne, statut: m.statut, motif: m.motif })),
  };

  return depot.$transaction(async (tx) => {
    const reference = await nextNumeroLotImport((s) => tx.lotImport.count({ where: { reference: { startsWith: s } } }));

    const lot = await tx.lotImport.create({
      data: {
        reference,
        systemeSource: d.systemeSource.trim(),
        format: d.format,
        empreinteFichier: empreinte,
        nomFichier: d.nomFichier.trim(),
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

    if (marquees.length > 0 && lecture.ok) {
      await tx.ligneImport.createMany({
        data: marquees.map((m, i) => ({
          lotId: lot.id,
          numeroLigne: m.numeroLigne,
          identifiantSource: m.ligne?.identifiantSource ?? null,
          chargeOriginale: lecture.lignes[i] as unknown as Prisma.InputJsonValue,
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

    return { id: lot.id, reference, statut, compteurs, dejaRecu: false, motifRejetLot };
  });
}

/**
 * Les lignes rejetees et ignorees d'un lot, en CSV pivot d'erreurs (T-04) : une ligne par
 * erreur, la regle violee, et la charge originale pour que la source retrouve la sienne.
 */
export async function erreursDuLot(depot: DepotImport, lotId: string): Promise<string> {
  const lignes = await depot.ligneImport.findMany({
    where: { lotId, statut: { in: ["REJETEE", "IGNOREE"] } },
    orderBy: { numeroLigne: "asc" },
  });
  const sep = SEPARATEUR_CSV;
  const citer = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /["\r\n]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const entete = ["numero_ligne", "statut", "motif", "identifiant_source", "charge_originale"].join(sep);
  const corps = lignes.map((l) => [l.numeroLigne, l.statut, l.motifRejet, l.identifiantSource, l.chargeOriginale].map(citer).join(sep));
  return [entete, ...corps].join("\n") + "\n";
}

/** Reexporte pour la route, qui n'a pas a connaitre le noyau. */
export { decouperLigneCsv };
export type { LignePivot, StatutLigne };
