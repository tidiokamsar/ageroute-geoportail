/**
 * Metadonnees ISO 19115 (encodage XML ISO 19139) d'un jeu de donnees.
 *
 * Module PUR : aucun import, aucune base. Il construit un document a partir d'une fiche et du
 * contexte de publication, et dit ce qui MANQUE.
 *
 * LA REGLE QUI COMMANDE TOUT LE MODULE : une valeur que personne n'a arretee n'est pas inventee.
 * ISO 19139 prevoit pour cela l'attribut gco:nilReason (unknown, missing...). Un courriel de
 * contact, une licence de reutilisation, une adresse de service non renseignes sortent donc avec
 * nilReason, et `lacunes()` les enumere pour que le gestionnaire sache quoi decider. Une fiche
 * « complete » dont les champs auraient ete devines serait pire qu'une fiche qui avoue ses vides.
 *
 * Ce qui n'est PAS verifie ici : la validite du document contre les schemas XSD de l'ISO 19139
 * (non disponibles hors ligne dans ce depot). Les tests controlent la bonne formation, l'ordre
 * des elements tel que le schema le prescrit, l'echappement et la presence des elements du
 * noyau de l'ISO 19115 ; ils ne remplacent pas un validateur.
 */

/** Valeurs de MD_TopicCategoryCode utilisees par les fiches (liste fermee de la norme). */
export type CategorieThematique = "transportation" | "structure" | "society" | "planningCadastre";

export interface Emprise { ouest: number; est: number; sud: number; nord: number }

export interface FicheJeu {
  /** Identifiant stable : il fait partie de l'URL et de l'identifiant du document. */
  id: string;
  titre: string;
  resume: string;
  motsCles: string[];
  categorie: CategorieThematique;
  /** Point d'entree HTTP qui sert la donnee, relatif a la base publique. null = non servie. */
  acces: { chemin: string; format: string; nom: string } | null;
  /** D'ou vient la donnee et ce qu'on sait de sa qualite, SANS rien ajouter qu'on n'ait constate. */
  genealogie: string;
  /** Conditions de reutilisation arretees par l'organisme ; null tant que personne ne les a decidees. */
  conditions: string | null;
  /** Producteur de la donnee quand ce n'est pas l'organisme (ex. contributeurs OpenStreetMap). */
  attribution: string | null;
}

export interface Contexte {
  /** Nom de l'organisme responsable de la metadonnee. */
  organisme: string;
  /** Courriel du point de contact ; null = non renseigne, jamais devine. */
  courriel: string | null;
  /** URL publique de base (sans slash final) ; null = adresse du service non renseignee. */
  baseUrl: string | null;
  /** Date de la fiche (jour UTC, AAAA-MM-JJ). */
  dateFiche: string;
  /** Etendue calculee sur les donnees, ou null si elle n'a pu l'etre. */
  emprise: Emprise | null;
  /** Date de derniere modification observee dans les donnees (AAAA-MM-JJ) ou null. */
  derniereRevision: string | null;
}

export type Lacune = { champ: string; raison: string };

const NS = [
  'xmlns:gmd="http://www.isotc211.org/2005/gmd"',
  'xmlns:gco="http://www.isotc211.org/2005/gco"',
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
].join(" ");

const CODELISTS = "http://standards.iso.org/ittf/PubliclyAvailableStandards/ISO_19139_Schemas/resources/codelist/ML_gmxCodelists.xml";

/** Echappement des cinq caracteres reserves du XML, plus la suppression des caracteres interdits. */
export function echapper(texte: string): string {
  return texte
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const chaine = (t: string) => `<gco:CharacterString>${echapper(t)}</gco:CharacterString>`;
const nil = (balise: string, raison: "unknown" | "missing" = "unknown") => `<${balise} gco:nilReason="${raison}"/>`;
const code = (balise: string, liste: string, valeur: string, texte = valeur) =>
  `<${balise} codeList="${CODELISTS}#${liste}" codeListValue="${echapper(valeur)}">${echapper(texte)}</${balise}>`;

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
function jourValide(j: string): boolean {
  if (!JOUR.test(j)) return false;
  const [a, m, d] = j.split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function emprisePlausible(e: Emprise): boolean {
  return [e.ouest, e.est, e.sud, e.nord].every(Number.isFinite)
    && e.ouest >= -180 && e.est <= 180 && e.sud >= -90 && e.nord <= 90
    && e.ouest <= e.est && e.sud <= e.nord;
}

/** Ce qui manque pour qu'une fiche soit complete. Vide = rien a decider, pas = « conforme ». */
export function lacunes(fiche: FicheJeu, ctx: Contexte): Lacune[] {
  const l: Lacune[] = [];
  if (!ctx.courriel) l.push({ champ: "contact.courriel", raison: "adresse du point de contact non renseignee (METADATA_CONTACT_EMAIL)" });
  if (!ctx.baseUrl && fiche.acces) l.push({ champ: "distribution.url", raison: "adresse publique du service non renseignee (PUBLIC_BASE_URL)" });
  if (!fiche.acces) l.push({ champ: "distribution", raison: "aucun point d'acces public pour ce jeu" });
  if (!fiche.conditions) l.push({ champ: "contraintes.reutilisation", raison: "conditions de reutilisation non arretees par AGEROUTE" });
  if (!ctx.emprise) l.push({ champ: "etendue.geographique", raison: "etendue non calculee (aucune geometrie ou base indisponible)" });
  if (!ctx.derniereRevision) l.push({ champ: "date.revision", raison: "aucune date de derniere modification observee" });
  l.push({ champ: "maintenance.frequence", raison: "frequence de mise a jour non arretee" });
  return l;
}

function responsable(ctx: Contexte): string {
  const courriel = ctx.courriel
    ? `<gmd:electronicMailAddress>${chaine(ctx.courriel)}</gmd:electronicMailAddress>`
    : nil("gmd:electronicMailAddress");
  return `<gmd:CI_ResponsibleParty>
      <gmd:organisationName>${chaine(ctx.organisme)}</gmd:organisationName>
      <gmd:contactInfo><gmd:CI_Contact><gmd:address><gmd:CI_Address>${courriel}</gmd:CI_Address></gmd:address></gmd:CI_Contact></gmd:contactInfo>
      <gmd:role>${code("gmd:CI_RoleCode", "CI_RoleCode", "pointOfContact")}</gmd:role>
    </gmd:CI_ResponsibleParty>`;
}

function dateCitation(ctx: Contexte): string {
  // Une date de citation est obligatoire dans le noyau ; on cite la derniere revision observee, et si
  // elle manque on le dit plutot que de la remplacer par la date du jour.
  if (ctx.derniereRevision && jourValide(ctx.derniereRevision)) {
    return `<gmd:date><gmd:CI_Date>
          <gmd:date><gco:Date>${ctx.derniereRevision}</gco:Date></gmd:date>
          <gmd:dateType>${code("gmd:CI_DateTypeCode", "CI_DateTypeCode", "revision")}</gmd:dateType>
        </gmd:CI_Date></gmd:date>`;
  }
  return nil("gmd:date", "missing");
}

function etendue(e: Emprise | null): string {
  if (!e || !emprisePlausible(e)) return nil("gmd:extent", "unknown");
  const d = (n: number) => `<gco:Decimal>${Number(n.toFixed(6))}</gco:Decimal>`;
  return `<gmd:extent><gmd:EX_Extent><gmd:geographicElement><gmd:EX_GeographicBoundingBox>
        <gmd:westBoundLongitude>${d(e.ouest)}</gmd:westBoundLongitude>
        <gmd:eastBoundLongitude>${d(e.est)}</gmd:eastBoundLongitude>
        <gmd:southBoundLatitude>${d(e.sud)}</gmd:southBoundLatitude>
        <gmd:northBoundLatitude>${d(e.nord)}</gmd:northBoundLatitude>
      </gmd:EX_GeographicBoundingBox></gmd:geographicElement></gmd:EX_Extent></gmd:extent>`;
}

function contraintes(fiche: FicheJeu): string {
  const reutilisation = fiche.conditions
    ? `<gmd:otherConstraints>${chaine(fiche.conditions)}</gmd:otherConstraints>`
    : nil("gmd:otherConstraints");
  const attribution = fiche.attribution
    ? `<gmd:useLimitation>${chaine(fiche.attribution)}</gmd:useLimitation>`
    : "";
  return `<gmd:resourceConstraints><gmd:MD_LegalConstraints>
        ${attribution}
        <gmd:accessConstraints>${code("gmd:MD_RestrictionCode", "MD_RestrictionCode", "otherRestrictions")}</gmd:accessConstraints>
        ${reutilisation}
      </gmd:MD_LegalConstraints></gmd:resourceConstraints>`;
}

function distribution(fiche: FicheJeu, ctx: Contexte): string {
  if (!fiche.acces || !ctx.baseUrl) return "";
  const url = `${ctx.baseUrl}${fiche.acces.chemin}`;
  return `<gmd:distributionInfo><gmd:MD_Distribution>
    <gmd:distributionFormat><gmd:MD_Format>
      <gmd:name>${chaine(fiche.acces.format)}</gmd:name>
      <gmd:version gco:nilReason="unknown"/>
    </gmd:MD_Format></gmd:distributionFormat>
    <gmd:transferOptions><gmd:MD_DigitalTransferOptions><gmd:onLine><gmd:CI_OnlineResource>
      <gmd:linkage><gmd:URL>${echapper(url)}</gmd:URL></gmd:linkage>
      <gmd:protocol>${chaine("WWW:DOWNLOAD-1.0-http--download")}</gmd:protocol>
      <gmd:name>${chaine(fiche.acces.nom)}</gmd:name>
      <gmd:function>${code("gmd:CI_OnLineFunctionCode", "CI_OnLineFunctionCode", "download")}</gmd:function>
    </gmd:CI_OnlineResource></gmd:onLine></gmd:MD_DigitalTransferOptions></gmd:transferOptions>
  </gmd:MD_Distribution></gmd:distributionInfo>`;
}

/** Document ISO 19139 (gmd:MD_Metadata) d'une fiche. Leve si la date de la fiche n'est pas un jour valide. */
export function construireXml(fiche: FicheJeu, ctx: Contexte): string {
  if (!jourValide(ctx.dateFiche)) throw new RangeError(`dateFiche invalide : ${ctx.dateFiche}`);
  const mots = fiche.motsCles.map((m) => `<gmd:keyword>${chaine(m)}</gmd:keyword>`).join("");
  const id = `ageroute-bdri-${fiche.id}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<gmd:MD_Metadata ${NS}>
  <gmd:fileIdentifier>${chaine(id)}</gmd:fileIdentifier>
  <gmd:language>${code("gmd:LanguageCode", "LanguageCode", "fre")}</gmd:language>
  <gmd:characterSet>${code("gmd:MD_CharacterSetCode", "MD_CharacterSetCode", "utf8")}</gmd:characterSet>
  <gmd:hierarchyLevel>${code("gmd:MD_ScopeCode", "MD_ScopeCode", "dataset")}</gmd:hierarchyLevel>
  <gmd:contact>
    ${responsable(ctx)}
  </gmd:contact>
  <gmd:dateStamp><gco:Date>${ctx.dateFiche}</gco:Date></gmd:dateStamp>
  <gmd:metadataStandardName>${chaine("ISO 19115:2003/Cor 1:2006 (encodage ISO 19139:2007)")}</gmd:metadataStandardName>
  <gmd:referenceSystemInfo><gmd:MD_ReferenceSystem><gmd:referenceSystemIdentifier><gmd:RS_Identifier>
    <gmd:code>${chaine("4326")}</gmd:code>
    <gmd:codeSpace>${chaine("EPSG")}</gmd:codeSpace>
  </gmd:RS_Identifier></gmd:referenceSystemIdentifier></gmd:MD_ReferenceSystem></gmd:referenceSystemInfo>
  <gmd:identificationInfo><gmd:MD_DataIdentification>
    <gmd:citation><gmd:CI_Citation>
      <gmd:title>${chaine(fiche.titre)}</gmd:title>
      ${dateCitation(ctx)}
    </gmd:CI_Citation></gmd:citation>
    <gmd:abstract>${chaine(fiche.resume)}</gmd:abstract>
    <gmd:pointOfContact>
      ${responsable(ctx)}
    </gmd:pointOfContact>
    <gmd:descriptiveKeywords><gmd:MD_Keywords>${mots}</gmd:MD_Keywords></gmd:descriptiveKeywords>
    ${contraintes(fiche)}
    <gmd:spatialRepresentationType>${code("gmd:MD_SpatialRepresentationTypeCode", "MD_SpatialRepresentationTypeCode", "vector")}</gmd:spatialRepresentationType>
    <gmd:language>${code("gmd:LanguageCode", "LanguageCode", "fre")}</gmd:language>
    <gmd:characterSet>${code("gmd:MD_CharacterSetCode", "MD_CharacterSetCode", "utf8")}</gmd:characterSet>
    <gmd:topicCategory><gmd:MD_TopicCategoryCode>${fiche.categorie}</gmd:MD_TopicCategoryCode></gmd:topicCategory>
    ${etendue(ctx.emprise)}
  </gmd:MD_DataIdentification></gmd:identificationInfo>
  ${distribution(fiche, ctx)}
  <gmd:dataQualityInfo><gmd:DQ_DataQuality>
    <gmd:scope><gmd:DQ_Scope><gmd:level>${code("gmd:MD_ScopeCode", "MD_ScopeCode", "dataset")}</gmd:level></gmd:DQ_Scope></gmd:scope>
    <gmd:lineage><gmd:LI_Lineage><gmd:statement>${chaine(fiche.genealogie)}</gmd:statement></gmd:LI_Lineage></gmd:lineage>
  </gmd:DQ_DataQuality></gmd:dataQualityInfo>
</gmd:MD_Metadata>
`;
}
