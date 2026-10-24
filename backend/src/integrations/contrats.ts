/**
 * CONTRATS D'ECHANGE DES INTEGRATIONS SORTANTES. AUCUN RESEAU, AUCUNE BASE.
 *
 * D'OU VIENT CHAQUE CHAMP, ET CE QUI RESTE A CONFIRMER
 *
 * Aucun acces a DigitalRoad, a SharePoint ou a l'ONR n'existe (B-11, B-12) et aucun format L2R
 * n'est publie (ONR_BDR_SOURCE_ANALYSIS.md). Ces schemas ne decrivent donc PAS le format d'un
 * systeme reel. Ils reprennent mot pour mot ce que les documents du depot enoncent :
 *
 *   DIGITALROAD    la fiche d'intervention : MAINTENANCE_PROGRAMMING_DESIGN.md, 5.3 (« identifiants
 *                  patrimoniaux, plage lineaire, traitement, quantites, cout estime et classe de
 *                  precision, score et justification, annee, source de financement. Version figee
 *                  a la transmission ») et programmation/cycle-vie.noyau.ts (version figee =
 *                  empreinte de la fiche telle que transmise).
 *   SHAREPOINT     le bulletin routier archive : texte et empreinte SHA-256 verifiee en base
 *                  (migration 20261019010000). SharePoint comme depot securise : option A de
 *                  BDR_INTEROPERABILITY_OPTIONS.md.
 *   BDR_L2R        le FORMAT PIVOT OUVERT (ROAD_SURVEY_IMPORT_SPEC.md, import/pivot.noyau.ts) :
 *                  une FeatureCollection GeoJSON de UNE ligne, en SRID 4326. Le format L2R Mesure
 *                  n'est PAS produit : il n'est pas publie.
 *
 * Tout ce que ces documents ne disent pas est LISTE dans CHAMPS_A_CONFIRMER et n'est PAS invente :
 * ni nom de champ propre a un systeme, ni valeur d'enumeration, ni chemin d'API. Les schemas sont
 * STRICTS (`.strict()`) : une cle inconnue est refusee, parce qu'un schema zod ordinaire ignore
 * en silence ce qu'il ne connait pas, et qu'une fuite de champ interne passerait inapercue.
 *
 * L'ENVELOPPE (cle d'idempotence, destination, version, empreinte, charge) est NOTRE hypothese de
 * travail pour le transport. Elle est testee contre nos simulateurs ; elle n'a aucune valeur
 * normative pour un tiers tant qu'il ne l'a pas confirmee.
 */
import { z } from "zod";
import type { Destination, DemandeEmission, TypeEvenement } from "./types";
import { sha256Hex } from "./canonique";
import { lireGeoJson, verifierLigne } from "../import/pivot.noyau";

/** Etiquette de l'enveloppe. « brouillon » : aucun tiers ne l'a confirmee. */
export const CONTRAT_VERSION = "agroute-sortant-0-brouillon";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 hexadecimal de 64 caracteres attendu");

/* ================================ DigitalRoad ================================ */

export const ChargeFicheIntervention = z.object({
  /** Identifiant de la fiche COTE AGEROUTE. La cle stable de DigitalRoad n'a jamais ete communiquee. */
  ficheId: z.string().trim().min(1).max(200),
  /** Empreinte de la fiche telle que transmise (cycle-vie.noyau.ts, `versionFigee`). */
  versionFigee: sha256,
  /** Seul statut emissible : APPROUVE, le dernier saisi dans le Geoportail avant TRANSMIS. */
  statutGeoportail: z.literal("APPROUVE"),
  identifiantsPatrimoniaux: z.array(z.object({
    typeObjet: z.enum(["troncon", "portion", "ouvrage"]),
    identifiant: z.string().trim().min(1).max(200),
    /** Cle d'echange `code Route-Type-PK` des ouvrages, la seule en service vers DigitalRoad. */
    codeEchange: z.string().trim().min(1).max(200).nullable(),
  }).strict()).min(1).max(500),
  plageLineaire: z.object({
    debutM: z.number().finite().min(0),
    finM: z.number().finite().min(0),
  }).strict().refine((p) => p.finM > p.debutM, "finM doit depasser debutM").nullable(),
  traitement: z.object({
    code: z.string().trim().min(1).max(80),
    libelle: z.string().trim().min(1).max(200).nullable(),
  }).strict(),
  quantites: z.array(z.object({
    valeur: z.number().finite().min(0),
    unite: z.string().trim().min(1).max(20),
  }).strict()).max(50),
  coutEstime: z.object({
    /** Entier en GNF, en CHAINE : un montant depasse 2^53. */
    montantGnf: z.string().regex(/^\d+$/, "chiffres attendus, en chaine (GNF entiers)"),
    /** Valeurs admises A CONFIRMER : le document parle de classes de precision sans les fixer. */
    classePrecision: z.string().trim().min(1).max(60),
  }).strict(),
  score: z.number().finite().nullable(),
  justification: z.string().trim().min(1).max(2000),
  annee: z.number().int().min(2000).max(2100),
  sourceFinancement: z.string().trim().min(1).max(120),
}).strict();
export type ChargeFicheIntervention = z.infer<typeof ChargeFicheIntervention>;

/* ================================== SharePoint ================================ */

export const ChargeDepotBulletin = z.object({
  nomFichier: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/, "nom de fichier : lettres, chiffres, point, tiret, tiret bas"),
  typeMime: z.literal("text/plain; charset=utf-8"),
  contenu: z.string().min(1).max(200_000),
  tailleOctets: z.number().int().positive(),
  empreinteSha256: sha256,
  numeroBulletin: z.string().trim().min(1).max(64),
  jour: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "AAAA-MM-JJ attendu"),
}).strict().superRefine((c, ctx) => {
  if (sha256Hex(c.contenu) !== c.empreinteSha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["empreinteSha256"], message: "l'empreinte n'est pas celle du contenu" });
  }
  if (Buffer.byteLength(c.contenu, "utf8") !== c.tailleOctets) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tailleOctets"], message: "la taille n'est pas celle du contenu" });
  }
});
export type ChargeDepotBulletin = z.infer<typeof ChargeDepotBulletin>;

/* ================================== BDR / L2R ================================= */

/**
 * La charge est le pivot GeoJSON lui-meme, a UNE ligne. Elle doit etre RELUE ET ACCEPTEE par le
 * lecteur du pivot (`lireGeoJson` puis `verifierLigne`) : ce qu'AGEROUTE emet est ce qu'AGEROUTE
 * saurait importer. C'est la lecture, ici, du test X-02 de ONR_BDR_TEST_PLAN.md.
 */
export const ChargePivot = z.object({
  type: z.literal("FeatureCollection"),
  crs: z.object({
    type: z.literal("name"),
    properties: z.object({ name: z.literal("urn:ogc:def:crs:OGC:1.3:CRS84") }).strict(),
  }).strict(),
  features: z.array(z.object({
    type: z.literal("Feature"),
    geometry: z.unknown(),
    properties: z.record(z.unknown()),
  }).strict()).length(1),
}).strict().superRefine((c, ctx) => {
  const lecture = lireGeoJson(c);
  if (!lecture.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: lecture.motif });
    return;
  }
  const verdict = verifierLigne(lecture.lignes[0]);
  if (!verdict.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ligne pivot refusee : ${verdict.motif}` });
});
export type ChargePivot = z.infer<typeof ChargePivot>;

/* ============================ Registre par destination ============================ */

const CONTRATS: Record<Destination, z.ZodTypeAny> = {
  DIGITALROAD: ChargeFicheIntervention,
  SHAREPOINT: ChargeDepotBulletin,
  BDR_L2R: ChargePivot,
};

export function verifierChargeContrat(destination: Destination, charge: unknown): { ok: true } | { ok: false; motif: string } {
  const r = CONTRATS[destination].safeParse(charge);
  if (r.success) return { ok: true };
  const premieres = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`);
  return { ok: false, motif: premieres.join(" ; ") };
}

/* ================================== Enveloppe ================================= */

export interface Enveloppe {
  contrat: typeof CONTRAT_VERSION;
  cleIdempotence: string;
  destination: Destination;
  typeEvenement: TypeEvenement;
  version: number;
  empreinteCharge: string;
  charge: unknown;
}

export function construireEnveloppe(d: DemandeEmission): Enveloppe {
  return {
    contrat: CONTRAT_VERSION,
    cleIdempotence: d.cleIdempotence,
    destination: d.destination,
    typeEvenement: d.typeEvenement,
    version: d.version,
    empreinteCharge: d.empreinteCharge,
    charge: d.charge,
  };
}

export const SchemaEnveloppe = z.object({
  contrat: z.literal(CONTRAT_VERSION),
  cleIdempotence: sha256,
  destination: z.enum(["DIGITALROAD", "SHAREPOINT", "BDR_L2R"]),
  typeEvenement: z.enum(["FICHE_INTERVENTION_PROGRAMMEE", "DEPOT_BULLETIN_ROUTIER", "PIVOT_OBJET_VALIDE"]),
  version: z.number().int().min(1),
  empreinteCharge: sha256,
  charge: z.unknown(),
}).strict();

/**
 * Accuse de reception ATTENDU. Notre hypothese, a confirmer avec chaque destinataire. On n'exige
 * que ce dont l'outbox a besoin ; une cle de plus dans la reponse est ignoree (une reponse n'est
 * pas une charge : la rejeter sur une cle inconnue romprait l'echange pour rien).
 */
export const AccuseReception = z.object({
  reference: z.string().trim().min(1).max(200),
  doublon: z.boolean().optional(),
});
export type AccuseReception = z.infer<typeof AccuseReception>;

/* ============================== Ce qui reste a confirmer ============================== */

export interface ChampAConfirmer {
  champ: string;
  constat: string;
  /** Le document ou le blocage qui l'etablit. */
  reference: string;
}

/**
 * LISTE EXACTE de ce que le depot ne permet pas d'etablir, par destination. Elle est servie par
 * `GET /api/v2/integrations/contrats` et reprise dans docs/integrations/SORTANTS.md. Elle n'est
 * jamais vide : un contrat sans « a confirmer » serait un contrat invente.
 */
export const CHAMPS_A_CONFIRMER: Record<Destination, readonly ChampAConfirmer[]> = {
  DIGITALROAD: [
    { champ: "transport", constat: "methode, chemin, en-tetes et corps de l'appel : aucune documentation de l'API DigitalRoad ; l'enveloppe est notre hypothese", reference: "BLOCKERS.md B-11" },
    { champ: "authentification", constat: "mecanisme (jeton, mTLS, OIDC) inconnu ; le jeton porte par Authorization: Bearer est une hypothese", reference: "BLOCKERS.md B-11" },
    { champ: "idempotence cote destinataire", constat: "rien n'etablit que DigitalRoad honore une cle d'idempotence (en-tete Idempotency-Key supposee)", reference: "BDR_INTEROPERABILITY_OPTIONS.md, option B" },
    { champ: "ficheId / identifiant DigitalRoad", constat: "la cle stable de DigitalRoad n'a jamais ete communiquee", reference: "DATA_SOURCE_OF_TRUTH.md, section 5" },
    { champ: "coutEstime.classePrecision", constat: "valeurs admises non fixees (la matrice cite +-30 / +-15 / metre sans les arreter)", reference: "ONR_BDR_COMPLIANCE_MATRIX.md, domaine 9" },
    { champ: "traitement.code", constat: "les traitements du catalogue ne sont pas approuves ; leur code d'echange n'est pas arrete", reference: "ONR_BDR_COMPLIANCE_MATRIX.md, domaine 8" },
    { champ: "accuse de reception", constat: "forme et semantique (equivaut-il au message TRANSMIS du cycle de vie ?) non etablies ; l'outbox ne fait JAMAIS passer une fiche en TRANSMIS", reference: "MAINTENANCE_PROGRAMMING_DESIGN.md 5.2, D-08" },
    { champ: "retractation", constat: "annuler ou remplacer une fiche deja transmise : non specifie ; un nouvel evenement (version + 1) est emis, rien n'est retire", reference: "MAINTENANCE_PROGRAMMING_DESIGN.md 5.3" },
    { champ: "source des fiches", constat: "aucune table de fiches d'intervention : aucun evenement DigitalRoad ne peut etre inscrit aujourd'hui", reference: "ONR_BDR_COMPLIANCE_MATRIX.md, domaine 10 ; D-07" },
  ],
  SHAREPOINT: [
    { champ: "transport", constat: "API Microsoft Graph, depot dans un dossier synchronise ou autre : non decide ; l'enveloppe est notre hypothese", reference: "BLOCKERS.md B-12" },
    { champ: "authentification", constat: "fournisseur d'identite Entra ID non confirme ; aucun OIDC / SAML dans backend/src", reference: "BLOCKERS.md B-12 ; D-09" },
    { champ: "cible", constat: "site, bibliotheque, dossier, convention de nommage, ecrasement ou versionnement : aucun document ne les fixe", reference: "DATA_SOURCE_OF_TRUTH.md, 2.6 (proposition)" },
    { champ: "metadonnees de colonne", constat: "colonnes de la bibliotheque non connues ; seuls nom, type, taille et empreinte sont emis", reference: "BLOCKERS.md B-12" },
    { champ: "autorisation de diffusion", constat: "le bulletin n'est diffuse par aucun canal autorise ; l'emission vers SharePoint exige une autorisation ecrite d'AGEROUTE", reference: "REQUIREMENTS_TRACEABILITY.md 7.17 ; migration 20261019010000" },
    { champ: "taille maximale", constat: "limite de fichier du site cible inconnue (200 000 caracteres retenus ici)", reference: "BLOCKERS.md B-12" },
  ],
  BDR_L2R: [
    { champ: "format L2R (Mesure, Base, Programme)", constat: "non publie : seul le pivot ouvert est emis, jamais un format L2R", reference: "ONR_BDR_TEST_PLAN.md, IO-02 ; ONR_BDR_SOURCE_ANALYSIS.md" },
    { champ: "mecanisme d'echange", constat: "fichiers controles (A), API officielle (B) ou passerelle institutionnelle (C) : trois options documentees SANS CHOIX ; aucune API ONR n'est etablie", reference: "BDR_INTEROPERABILITY_OPTIONS.md" },
    { champ: "identifiantSource", constat: "aucun identifiant institutionnel officiel ; l'identifiant technique du Geoportail est emis tel quel", reference: "BDR_ID_CROSSWALK_SPEC.md, section 5 ; D-06" },
    { champ: "systeme_source", constat: "la valeur AGEROUTE_GEOPORTAIL est une proposition ; le vocabulaire est administrable", reference: "ROAD_SURVEY_IMPORT_SPEC.md, section 2" },
    { champ: "noms d'attributs", constat: "BDR_FIELD_MAPPING_TEMPLATE.csv est vide par construction : aucun nom de champ ONR n'est connu", reference: "BDR_FIELD_MAPPING_TEMPLATE.csv" },
    { champ: "GeoPackage", constat: "ecart consigne : aucune dependance SQLite ; le pivot est emis en GeoJSON", reference: "import/pivot.noyau.ts" },
    { champ: "autorisation d'echange", constat: "aucune convention AGEROUTE - ONR ; autorisation ecrite de la source requise", reference: "INSTITUTIONAL_DATA_GOVERNANCE.md ; ONR_BDR_COMPLIANCE_MATRIX.md, domaine 14" },
    { champ: "degradations", constat: "les defauts (type 'degradation' du pivot) ne sont pas emis : leur emission suppose le format L2R Mesure", reference: "ONR_BDR_TEST_PLAN.md, IO-02" },
  ],
};
