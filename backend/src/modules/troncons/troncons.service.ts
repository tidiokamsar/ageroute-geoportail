import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { createCrudService, type ListParams } from "../../lib/crud-factory";
import { logAuditTransactionnelle } from "../../utils/audit";
import { chevauchements, couverture, repartition } from "../../reseau/portions";
import { WHERE_RESEAU_CLASSE, clauseSqlReseauClasse } from "../../lib/reseau";
import { buildExportBuffer, parseImportBuffer, formatImportError, type ImportReport } from "../../lib/excel";
import { resolveRegionId } from "../../lib/regions";
import { ApiError } from "../../middleware/error.middleware";
import { tronconCreateSchema, type TronconCreateInput } from "./troncons.schema";
import { EMPRISE_NATIONALE } from "../../referentiel/registre.noyau";

/**
 * Troncon est migre a l'audit transactionnel (ADR 11).
 *
 * C'est le premier des sept services restants, et celui qui eprouve VRAIMENT le mecanisme :
 * `CHAMPS_SUIVIS` suit huit de ses champs, donc chaque ecriture entraine des lignes de
 * provenance qui doivent rejoindre la meme transaction. Inspection, migree avant lui, n'a
 * aucun champ suivi et ne testait donc pas ce point.
 */
const base = createCrudService(prisma.troncon, "Troncon", {
  include: { region: true },
  delegueTransactionnel: (tx) => (tx as typeof prisma).troncon,
  controleTerritorial: true,
});

/**
 * Ecrit le trace. `client` permet de rejoindre une transaction : la geometrie ne passe pas
 * par Prisma (colonne `Unsupported`) mais son `$executeRaw` fonctionne aussi bien sur un
 * client de transaction.
 */
async function setLineGeom(
  id: string,
  geom: { type: string; coordinates: number[][] },
  client: Pick<typeof prisma, "$executeRaw"> = prisma,
): Promise<void> {
  await client.$executeRaw`
    UPDATE troncons SET geom = ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geom)}), 4326)
    WHERE id = ${id}
  `;
}

/**
 * Resume du trace existant, pour que la trace d'audit dise ce qui a ete remplace.
 *
 * On ne journalise PAS la geometrie elle-meme : un tronçon porte couramment des milliers
 * de points, et les recopier dans `audit_logs` a chaque edition gonflerait une table qui
 * doit rester consultable. Le nombre de points et la longueur suffisent a reperer ce qui
 * compte — un trace remplace par un trace plus grossier, ou amputé de dizaines de
 * kilometres, ce qui changerait le lineaire publie sans que rien ne le signale.
 */
async function resumeGeom(
  id: string,
  client: Pick<typeof prisma, "$queryRaw"> = prisma,
): Promise<{ points: number; metres: number } | null> {
  const lignes = await client.$queryRaw<{ points: number | null; metres: number | null }[]>`
    SELECT ST_NPoints(geom)::int AS points, ST_Length(geom::geography) AS metres
    FROM troncons WHERE id = ${id}
  `;
  const r = lignes[0];
  if (!r || r.points == null) return null;
  return { points: Number(r.points), metres: Math.round(Number(r.metres ?? 0)) };
}

export interface TronconListParams extends ListParams {
  search?: string;
  region?: string;
  etat?: string;
  classe?: string;
  revetement?: string;
  /** « non_renseigne » : PK 0 -> 0, la facon dont l'absence a ete saisie (les colonnes sont obligatoires). */
  pk?: "non_renseigne" | "renseigne";
  geometrie?: "absente" | "presente";
  /** Reseau classe par defaut ; "tout" inclut la voirie promue. */
  perimetre?: PerimetreTroncons;
}

export type PerimetreTroncons = "reference" | "tout";

/**
 * Le reseau classe, ecrit UNE fois.
 *
 * Le meme predicat vivait en trois exemplaires — carte, export, indicateurs — et
 * manquait au quatrieme : la liste. Elle rendait 261 387 troncons quand les trois
 * autres en rendaient 1 691. Un ecran annoncait donc 261 387 km de reseau routier
 * pour un pays qui en a 21 000, et c'est par la qu'une classe NON_CLASSEE a atteint
 * `CLASSE_META[...].pill` et fait tomber la page.
 *
 * Le IS NULL est indispensable : les 1 690 troncons anterieurs n'ont pas de
 * `sourceReference`, et un simple `not: { startsWith }` les exclurait tous — en SQL,
 * NULL NOT LIKE '...' vaut NULL, donc faux.
 */
const RESEAU_CLASSE: Prisma.TronconWhereInput = WHERE_RESEAU_CLASSE;

/**
 * Identifiants des troncons SANS trace. La geometrie est une colonne `Unsupported` : Prisma ne sait pas la
 * filtrer, d'ou cette lecture SQL, plafonnee (au-dela, le filtre le dit au lieu de rendre une liste fausse).
 */
const PLAFOND_SANS_GEOMETRIE = 50_000;
async function idsSansGeometrie(): Promise<string[]> {
  const lignes = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM troncons WHERE geom IS NULL LIMIT ${PLAFOND_SANS_GEOMETRIE + 1}`;
  if (lignes.length > PLAFOND_SANS_GEOMETRIE) throw new ApiError(422, "Trop de tronçons sans tracé pour ce filtre : restreignez d'abord par région.");
  return lignes.map((l) => l.id);
}

/** Un PK cherche : « 12,5 » ou « 12.5 ». Le texte reste cherche dans le code et le nom. */
export function pkCherche(search: string): number | null {
  const t = search.trim();
  return /^\d{1,4}([.,]\d{1,3})?$/.test(t) ? Number(t.replace(",", ".")) : null;
}

/** Le filtre de la liste, partage avec l'export : ce qu'on exporte est ce qu'on voit. */
async function whereListe(params: TronconListParams): Promise<Record<string, unknown>> {
  const where: Record<string, unknown> = { ...params.where };
  const et: unknown[] = [];
  if (params.region) where.region = { nom: params.region };
  if (params.etat) where.etat = params.etat;
  if (params.classe) where.classe = params.classe;
  if (params.revetement) where.revetement = params.revetement;
  if (params.search) {
    const pk = pkCherche(params.search);
    where.OR = [
      { code: { contains: params.search, mode: "insensitive" } },
      { nom: { contains: params.search, mode: "insensitive" } },
      ...(pk === null ? [] : [{ AND: [{ pkDebut: { lte: pk } }, { pkFin: { gte: pk } }] }]),
    ];
  }
  if (params.pk === "non_renseigne") et.push({ pkDebut: 0, pkFin: 0 });
  if (params.pk === "renseigne") et.push({ NOT: { pkDebut: 0, pkFin: 0 } });
  if (params.geometrie) {
    const ids = await idsSansGeometrie();
    et.push(params.geometrie === "absente" ? { id: { in: ids } } : { id: { notIn: ids } });
  }
  // Par AND et non par OR : `where.OR` porte deja la recherche texte, et fusionner
  // les deux listes rendrait toute la voirie des qu'un utilisateur tape un caractere.
  if ((params.perimetre ?? "reference") !== "tout") et.push(RESEAU_CLASSE);
  if (et.length) where.AND = [...((where.AND as unknown[]) ?? []), ...et];
  return where;
}

async function list(params: TronconListParams) {
  const resultat = await base.list({ ...params, where: await whereListe(params) });
  // Chaque ligne dit si elle a un trace et sa longueur geometrique : la liste ne propose pas « Carte » pour un
  // troncon que la carte ne peut pas montrer, et ne confond pas longueur declaree et longueur du trace.
  const lignes = resultat.data as { id: string }[];
  const ids = lignes.map((t) => t.id);
  const geo = ids.length === 0 ? [] : await prisma.$queryRaw<{ id: string; a: boolean; km: number | null }[]>`
    SELECT id, (geom IS NOT NULL) AS a,
           CASE WHEN geom IS NOT NULL AND ST_IsValid(geom) THEN ST_Length(geom::geography) / 1000.0 END AS km
      FROM troncons WHERE id = ANY(${ids}::text[])
  `;
  const parId = new Map(geo.map((g) => [g.id, g]));
  return {
    ...resultat,
    data: lignes.map((t) => {
      const g = parId.get(t.id);
      return { ...t, aGeometrie: g?.a ?? false, longueurGeometriqueKm: g?.km == null ? null : Math.round(Number(g.km) * 1000) / 1000 };
    }),
  };
}

// Estimation "a vol d'oiseau" entre deux troncons (centroides de leurs traces), PAS un
// vrai calcul d'itineraire route par route (necessiterait un graphe topologique du reseau,
// non construit ici) : libelle explicitement comme une estimation cote frontend pour ne
// pas induire en erreur sur la precision. Liste aussi les regions traversees par simple
// test d'intersection avec un tampon autour du segment droit reliant les deux points.
async function itineraire(fromId: string, toId: string) {
  const rows = await prisma.$queryRaw<
    { distanceKm: number; fromNom: string; fromCode: string; toNom: string; toCode: string; regionsTraversees: string[] }[]
  >`
    WITH a AS (SELECT ST_Centroid(geom) AS g, code, nom FROM troncons WHERE id = ${fromId}),
         b AS (SELECT ST_Centroid(geom) AS g, code, nom FROM troncons WHERE id = ${toId}),
         ligne AS (SELECT ST_MakeLine((SELECT g FROM a), (SELECT g FROM b)) AS g)
    SELECT
      ST_Distance((SELECT g FROM a)::geography, (SELECT g FROM b)::geography) / 1000 AS "distanceKm",
      (SELECT nom FROM a) AS "fromNom", (SELECT code FROM a) AS "fromCode",
      (SELECT nom FROM b) AS "toNom", (SELECT code FROM b) AS "toCode",
      ARRAY(
        SELECT DISTINCT r.nom FROM regions r
        JOIN troncons t ON t."regionId" = r.id
        WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
          AND ST_DWithin(t.geom::geography, (SELECT g FROM ligne)::geography, 20000)
      ) AS "regionsTraversees"
  `;
  const row = rows[0];
  if (!row || row.distanceKm == null) throw new ApiError(404, "Tronçon de départ ou d'arrivée introuvable");
  return row;
}

/**
 * Geometrie LineString exposee en GeoJSON (Prisma ne lit pas les colonnes
 * "Unsupported(geometry...)" nativement).
 *
 * LE RESEAU DE REFERENCE, ET POURQUOI IL EST LE DEFAUT
 *
 * La promotion de la voirie porte cette table a environ 264 000 lignes. Les cartes
 * qui appellent cette fonction ne demandent aucune emprise : elles peignent tout.
 *
 * Mesure du 03/09/2026 : 2 040 troncons pesent 3,0 Mo bruts ; les 262 306 voies
 * restantes representent 132 Mo de GeoJSON. Servies ici, elles rendraient la carte
 * publique inutilisable, d'abord sur les connexions mobiles.
 *
 * Le defaut exclut donc les troncons issus de la voirie locale. Ce n'est pas un
 * masquage : ils sont au registre, dans les exports, et peuvent porter des chantiers.
 * Ils sont aussi DEJA affiches — par la couche voirie, cadree par emprise au-dela du
 * zoom 12, ou chacun s'ouvre en fiche et renvoie a son troncon. Les servir une
 * seconde fois, sans emprise, n'ajouterait rien et couterait 132 Mo.
 *
 * `tout: true` leve l'exclusion, pour un appelant qui sait ce qu'il demande.
 *
 * `simplification` : TOLERANCE EN DEGRES, ET CE QU'ELLE COUTE
 *
 * Le poids de cette reponse vient de la geometrie, pas du nombre d'objets. Mesure du
 * 04/09/2026 sur le reseau de reference :
 *
 *     brut          2 366 ko   106 856 sommets   21 156 km
 *     0,0001 deg    1 075 ko    46 989 sommets   21 142 km   (-14 km, 0,07 %)
 *     0,0005 deg      603 ko    25 106 sommets   21 071 km   (-85 km, 0,40 %)
 *     0,002  deg      307 ko    11 422 sommets   20 784 km   (-372 km, 1,76 %)
 *
 * A l'echelle du pays, 220 m est inferieur au pixel : transporter 106 856 sommets
 * pour en dessiner 11 000 de visibles est du gaspillage pur, paye par le visiteur sur
 * une connexion mobile guineenne.
 *
 * ST_SimplifyPreserveTopology et non ST_Simplify : le second peut rendre une ligne
 * vide ou auto-secante sur un trace court, ce qui casserait l'affichage sans
 * prevenir.
 *
 * Zero signifie « aucune simplification » — a ce niveau de zoom, c'est la forme
 * exacte qu'on regarde.
 *
 * `decimales` : CHIFFRES APRES LA VIRGULE DES COORDONNEES (PostGIS `maxdecimaldigits`)
 *
 * Le defaut est celui de PostGIS (9, soit 0,1 mm) : sans cet argument la reponse est inchangee.
 * Un appelant qui a deja simplifie a une tolerance de T degres n'a aucun besoin de coordonnees
 * plus fines que T : la carte publique arrondit en consequence (voir `decimalesSelonZoom`). Les
 * chiffres inutiles pesaient sur une reponse destinee a des connexions mobiles ; la mesure est
 * dans docs/performance/MESURES-A15-A20.md.
 */
const DECIMALES_PAR_DEFAUT = 9;

async function listGeo({ tout = false, simplification = 0, decimales = DECIMALES_PAR_DEFAUT }: { tout?: boolean; simplification?: number; decimales?: number } = {}) {
  return prisma.$queryRaw`
    SELECT t.id, t.code, t.nom, t.classe, t.etat, t."longueurKm", r.nom AS region,
           t.revetement, t."pkDebut", t."pkFin", t."traficMoyenJma",
           -- Un etat DECLARE n'est pas un etat CONSTATE. La carte affiche la meme
           -- pastille verte dans les deux cas ; sans ce drapeau, un « bon etat »
           -- annonce par un gestionnaire serait indiscernable d'une inspection.
           --
           -- Vrai UNIQUEMENT si valeurs_qualite porte la mention explicite. L'absence
           -- de ligne ne vaut pas verification : elle ne dit rien, et on ne fait donc
           -- rien dire aux 1 690 troncons anterieurs.
           EXISTS (
             SELECT 1 FROM valeurs_qualite q
              WHERE q."entityType" = 'Troncon' AND q."entityId" = t.id
                AND q.champ = 'etat' AND q.statut = 'IMPORTED_UNVERIFIED'
           ) AS "etatDeclare",
           ST_AsGeoJSON(
             CASE WHEN ${simplification}::float8 > 0
                  THEN ST_SimplifyPreserveTopology(t.geom, ${simplification}::float8)
                  ELSE t.geom END,
             ${decimales}::int
           ) AS geometry
    FROM troncons t
    LEFT JOIN regions r ON r.id = t."regionId"
    WHERE t."deletedAt" IS NULL AND t.geom IS NOT NULL
      AND (${tout}::boolean OR ${Prisma.raw(clauseSqlReseauClasse('t."sourceReference"'))})
  `;
}

const EXPORT_COLUMNS = [
  { key: "code", header: "Code" },
  { key: "nom", header: "Nom" },
  { key: "classe", header: "Classe" },
  { key: "region", header: "Région" },
  { key: "longueurKm", header: "Longueur (km)" },
  { key: "revetement", header: "Revêtement" },
  { key: "etat", header: "État" },
  { key: "pkDebut", header: "PK Début" },
  { key: "pkFin", header: "PK Fin" },
  { key: "traficMoyenJma", header: "Trafic moyen (jma)" },
];

/**
 * Plafond d'export.
 *
 * Excel accepte un million de lignes, mais ce n'est pas la contrainte : construire le
 * classeur en memoire l'est. Le tas du conteneur fait 2 Go, et charger 261 386
 * troncons avec leurs relations pour les serialiser y tient mal.
 *
 * Personne ne veut d'ailleurs ce fichier : on exporte le reseau AGEROUTE, pas un
 * vidage d'OpenStreetMap.
 */
const PLAFOND_EXPORT = 20_000;

/**
 * Export du RESEAU CLASSE par defaut.
 *
 * Avant la promotion de la voirie, `troncons` comptait 1 690 lignes et l'export sans
 * filtre etait sans danger. Il en compte 261 386 : le meme code aurait produit un
 * fichier inexploitable, apres avoir probablement fait tomber le conteneur.
 *
 * `perimetre: "tout"` reste possible pour un appelant qui sait ce qu'il demande, et
 * se heurte alors au plafond plutot qu'a une panne.
 */
async function exportXlsx(params: TronconListParams = {}): Promise<Buffer> {
  const where = { ...(await whereListe(params)), deletedAt: params.archived ? { not: null } : null } as Prisma.TronconWhereInput;

  const total = await prisma.troncon.count({ where });
  if (total > PLAFOND_EXPORT) {
    throw new ApiError(
      413,
      `Export de ${total.toLocaleString("fr-FR")} tronçons refusé : au-delà de `
      + `${PLAFOND_EXPORT.toLocaleString("fr-FR")}, le fichier serait inexploitable. `
      + "Restreignez le périmètre.",
    );
  }

  const rows = await prisma.troncon.findMany({
    where,
    include: { region: true },
    orderBy: { code: "asc" },
  });
  const mapped = rows.map((r: { region: { nom: string } | null } & Record<string, unknown>) => ({
    ...r,
    region: r.region?.nom ?? "",
  }));
  return buildExportBuffer(mapped, EXPORT_COLUMNS);
}

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

/** Champs comparés pour dire si une ligne d'import CHANGE un tronçon existant, et quoi. */
const CHAMPS_IMPORT = ["nom", "classe", "regionId", "longueurKm", "revetement", "etat", "pkDebut", "pkFin", "traficMoyenJma"] as const;

export interface LigneImport {
  row: number;
  code: string;
  action: "CREER" | "METTRE_A_JOUR" | "INCHANGE" | "ERREUR";
  /** Pour une mise a jour : chaque champ qui change, avec sa valeur actuelle et la nouvelle. */
  changements?: { champ: string; actuelle: unknown; nouvelle: unknown }[];
  message?: string;
}

export interface RapportImportTroncons extends ImportReport {
  simulation: boolean;
  /** Creations seulement (avant ce lot, les mises a jour etaient comptees ici). */
  created: number;
  updated: number;
  unchanged: number;
  /** Signalements qui n'empechent pas l'import : doublon potentiel par nom et region. */
  avertissements: { row: number; message: string }[];
  lignes: LigneImport[];
}

/**
 * IMPORT XLSX DES TRONÇONS, SIMULABLE ET REJOUABLE (BDRI, lot H).
 *
 * `simulation` : chaque ligne est verifiee et classee (creer, mettre a jour avec la liste des champs qui changent,
 * inchangee, erreur) SANS RIEN ECRIRE. L'import reel fait le meme examen et :
 *   - n'ecrit pas une ligne inchangee : rejouer le meme fichier ne cree ni ne modifie rien ;
 *   - refuse les MISES A JOUR de troncons existants sans `confirmer` (la simulation les a montrees) ;
 *   - refuse un code present deux fois dans le fichier (laquelle des deux lignes croire ?) ;
 *   - signale, sans bloquer, un nom deja porte dans la meme region par un autre code (doublon potentiel).
 * Les identifiants existants sont conserves : la cle d'import est le `code`, l'`id` ne change jamais.
 */
async function importXlsx(buffer: Buffer, userId: string, options: { simulation?: boolean; confirmer?: boolean } = {}): Promise<RapportImportTroncons> {
  const rows = await parseImportBuffer(buffer);
  const report: RapportImportTroncons = { simulation: options.simulation === true, created: 0, updated: 0, unchanged: 0, errors: [], avertissements: [], lignes: [] };
  const codes = new Map<string, number>();
  const prets: { rowNum: number; payload: TronconCreateInput; existantId: string | null }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    const rowNum = i + 2; // ligne Excel reelle (entete = ligne 1)
    const codeBrut = String(row["Code"] ?? "").trim();
    try {
      if (codeBrut && codes.has(codeBrut)) throw new Error(`Code ${codeBrut} déjà présent ligne ${codes.get(codeBrut)} du fichier : laquelle croire ? Corriger le fichier.`);
      if (codeBrut) codes.set(codeBrut, rowNum);
      const regionId = await resolveRegionId(String(row["Région"] ?? ""));
      if (!regionId) throw new Error(`Région "${row["Région"]}" introuvable`);

      const payload = tronconCreateSchema.parse({
        code: String(row["Code"] ?? "").trim(),
        nom: String(row["Nom"] ?? "").trim(),
        classe: String(row["Classe"] ?? "").trim(),
        regionId,
        longueurKm: toNumber(row["Longueur (km)"]),
        revetement: String(row["Revêtement"] ?? "").trim(),
        etat: row["État"] ? String(row["État"]).trim() : undefined,
        pkDebut: toNumber(row["PK Début"]) ?? 0,
        pkFin: toNumber(row["PK Fin"]) ?? 0,
        traficMoyenJma: toNumber(row["Trafic moyen (jma)"]),
      });

      const existing = await prisma.troncon.findUnique({ where: { code: payload.code } });
      if (existing?.deletedAt) throw new Error(`Le tronçon ${payload.code} est archivé : le restaurer avant de l'importer (l'import ne fait renaître aucune donnée archivée).`);
      if (existing) {
        const changements = CHAMPS_IMPORT
          .filter((c) => payload[c] !== undefined && payload[c] !== (existing as Record<string, unknown>)[c])
          .map((c) => ({ champ: c, actuelle: (existing as Record<string, unknown>)[c], nouvelle: payload[c] }));
        if (changements.length === 0) {
          report.unchanged++;
          report.lignes.push({ row: rowNum, code: payload.code, action: "INCHANGE" });
          continue;
        }
        report.lignes.push({ row: rowNum, code: payload.code, action: "METTRE_A_JOUR", changements });
      } else {
        const homonyme = await prisma.troncon.findFirst({
          where: { deletedAt: null, regionId: payload.regionId, nom: { equals: payload.nom, mode: "insensitive" } },
          select: { code: true },
        });
        if (homonyme) report.avertissements.push({ row: rowNum, message: `Doublon potentiel : le nom « ${payload.nom} » est déjà porté dans cette région par ${homonyme.code}. Un nom identique n'est pas une preuve ; vérifier avant d'importer.` });
        report.lignes.push({ row: rowNum, code: payload.code, action: "CREER" });
      }
      prets.push({ rowNum, payload, existantId: existing?.id ?? null });
    } catch (err) {
      const message = formatImportError(err);
      report.errors.push({ row: rowNum, message });
      report.lignes.push({ row: rowNum, code: codeBrut, action: "ERREUR", message });
    }
  }

  const misesAJour = prets.filter((p) => p.existantId).length;
  if (report.simulation) {
    report.created = prets.length - misesAJour;
    report.updated = misesAJour;
    return report;
  }
  if (misesAJour > 0 && options.confirmer !== true) {
    throw new ApiError(409, `${misesAJour} tronçon(s) existant(s) seraient modifiés : simuler l'import, vérifier les changements, puis confirmer. Rien n'a été écrit.`);
  }
  for (const p of prets) {
    try {
      if (p.existantId) { await base.update(p.existantId, p.payload, userId); report.updated++; }
      else { await base.create(p.payload, userId); report.created++; }
    } catch (err) {
      const message = formatImportError(err);
      report.errors.push({ row: p.rowNum, message });
      const ligne = report.lignes.find((l) => l.row === p.rowNum);
      if (ligne) { ligne.action = "ERREUR"; ligne.message = message; }
    }
  }
  return report;
}

// Fiche consolidee : le troncon + tout ce qui lui est rattache (vue patrimoniale).
/**
 * Fiche 360 d'un troncon.
 *
 * ETENDUE et non remplacee : la fiche existait avec cinq collections, et le paragraphe 20
 * du cahier en demande davantage. En construire une seconde aurait laisse deux verites sur
 * le meme objet, dont une seule serait maintenue.
 *
 * CE QUE L'EXTENSION AJOUTE
 *
 * Les PORTIONS, leur couverture et les repartitions par revetement et par etat : c'est ce
 * qui transforme une liste d'objets rattaches en description de l'etat du troncon.
 *
 * Les DEFAUTS et les MISSIONS, que la fiche ignorait alors qu'ils sont la matiere du
 * terrain.
 *
 * TROIS HONNETETES QUE CETTE FICHE DOIT PORTER
 *
 * `longueurGeometriqueM` est rendue A COTE de `longueurKm`, jamais a sa place. L'une est
 * declaree par AGEROUTE, l'autre mesuree sur la numerisation. Mesure du 13/10/2026 : elles
 * s'accordent a moins de 20 % sur tous les troncons comparables, mais 1 028 des 1 029
 * troncons regionaux n'ont AUCUNE longueur declaree — rendre la seule geometrique les
 * ferait passer pour documentes.
 *
 * `couverture` nomme les TROUS par leurs abscisses. « 60 % qualifie » n'envoie personne
 * nulle part ; « non qualifie de 8 000 a 13 000 » envoie une equipe au bon endroit.
 *
 * `repartitions` distingue `NON_QUALIFIE` de `NON_RENSEIGNE`, et les deux d'une valeur
 * connue. Les confondre laisserait croire le troncon inventorie.
 */
async function fiche(id: string) {
  const troncon = await base.getById(id);
  const notDeleted = { tronconId: id, deletedAt: null };
  const [ouvrages, pointsNoirs, postes, chantiers, inspections, portions, defauts, missions, mesure] =
    await Promise.all([
      prisma.ouvrage.findMany({ where: notDeleted, orderBy: { nom: "asc" } }),
      prisma.pointNoir.findMany({ where: notDeleted, orderBy: { createdAt: "desc" } }),
      prisma.poste.findMany({ where: notDeleted, orderBy: { nom: "asc" } }),
      prisma.chantier.findMany({ where: notDeleted, orderBy: { createdAt: "desc" } }),
      prisma.inspection.findMany({
        where: { tronconId: id, deletedAt: null },
        include: { inspecteur: { select: { nomComplet: true } } },
        orderBy: { dateInspection: "desc" },
      }),
      // Les COURANTES seulement : melanger l'etat courant et ses versions anterieures
      // ferait apparaitre plusieurs portions sur les memes metres.
      prisma.portion.findMany({
        where: { tronconId: id, remplaceeLe: null, deletedAt: null },
        orderBy: { debutM: "asc" },
        include: {
          revetementRef: { select: { code: true, libelle: true, bitumineux: true } },
          etatRef: { select: { code: true, libelle: true, critique: true } },
          praticabiliteRef: { select: { code: true, libelle: true, franchissable: true } },
          creePar: { select: { id: true, nomComplet: true } },
        },
      }),
      prisma.defaut.findMany({
        where: notDeleted,
        orderBy: { createdAt: "desc" },
        take: 200,
        include: {
          catalogue: { select: { code: true, libelle: true, unite: true, famille: true } },
          constatePar: { select: { nomComplet: true } },
        },
      }),
      prisma.mission.findMany({
        where: { observations: { some: { tronconId: id } } },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, code: true, intitule: true, statut: true, type: true, createdAt: true },
      }),
      longueurGeometriqueM(id),
    ]);

  const longueurM = mesure;
  const portionsDomaine = portions.map((p) => ({
    id: p.id, tronconId: p.tronconId, debutM: p.debutM, finM: p.finM,
    revetement: p.revetement, etat: p.etat, praticabilite: p.praticabilite,
    largeurM: p.largeurM, source: p.source, observeeLe: p.observeeLe,
    confiance: p.confiance, statutValidation: p.statutValidation,
    origine: p.origine, clientOperationId: p.clientOperationId,
    remplaceeLe: p.remplaceeLe, deletedAt: p.deletedAt,
  }));

  return {
    troncon,
    /**
     * Longueur MESUREE sur la geometrie, a cote de `troncon.longueurKm` qui est declaree.
     * NULLE quand le trace n'est pas exploitable, jamais remplacee par la declaree.
     */
    longueurGeometriqueM: longueurM,
    ouvrages, pointsNoirs, postes, chantiers, inspections,
    portions,
    defauts,
    missions,
    // Nulles quand la longueur geometrique manque : sans denominateur mesure, un
    // pourcentage serait invente.
    couverture: longueurM === null ? null : couverture(portionsDomaine, longueurM),
    repartitions: longueurM === null ? null : {
      revetement: repartition(portionsDomaine, longueurM, "revetement"),
      etat: repartition(portionsDomaine, longueurM, "etat"),
      praticabilite: repartition(portionsDomaine, longueurM, "praticabilite"),
    },
    // Les chevauchements sont SIGNALES, jamais corriges : deux portions qui se recouvrent
    // disent deux choses du meme metre, et trancher appartient a un humain.
    chevauchements: chevauchements(portionsDomaine),
  };
}

/** Longueur geodesique du trace, ou `null` quand il n'y en a pas d'exploitable. */
async function longueurGeometriqueM(id: string): Promise<number | null> {
  const r = await prisma.$queryRaw<{ m: number | null }[]>`
    SELECT ST_Length(geom::geography) AS m
      FROM troncons WHERE id = ${id}::text AND geom IS NOT NULL
  `;
  const v = r[0]?.m ?? null;
  return v !== null && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

type Trace = { type: string; coordinates: number[][] };

/**
 * UN TRACE EST CONTROLE AVANT D'ETRE ECRIT (BDRI, lot I).
 *
 * Aucun chemin d'ecriture ne verifiait le trace : une ligne invalide pour PostGIS, ou des coordonnees inversees
 * (latitude a la place de la longitude, qui posent la route au large de l'Afrique australe), entraient en base
 * et ne se decouvraient qu'a la carte ou au metre. Le controle lit le trace TEL QU'IL SERAIT ECRIT et refuse
 * avec la raison donnee par PostGIS ; il ne repare rien.
 */
async function verifierTrace(geom: Trace, client: Pick<typeof prisma, "$queryRaw"> = prisma): Promise<void> {
  const [v] = await client.$queryRaw<{ valide: boolean; raison: string; xmin: number; ymin: number; xmax: number; ymax: number }[]>`
    WITH g AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geom)}), 4326) AS g)
    SELECT ST_IsValid(g) AS valide, ST_IsValidReason(g) AS raison, ST_XMin(g) AS xmin, ST_YMin(g) AS ymin, ST_XMax(g) AS xmax, ST_YMax(g) AS ymax FROM g
  `;
  if (!v.valide) throw new ApiError(422, `Tracé refusé : géométrie invalide (${v.raison}). Rien n'a été écrit.`);
  const e = EMPRISE_NATIONALE;
  if (v.xmin < e.xmin || v.xmax > e.xmax || v.ymin < e.ymin || v.ymax > e.ymax) {
    throw new ApiError(422, "Tracé refusé : coordonnées hors de l'emprise de la Guinée (longitude et latitude inversées, ou autre système de coordonnées ?). Rien n'a été écrit.");
  }
}

/**
 * La creation ou la modification d'un troncon AVEC trace est UNE transaction : l'entite, sa provenance, son audit
 * ET le trace avec son propre audit. Avant, le trace s'ecrivait apres coup, hors transaction et sans trace d'audit :
 * seul `PATCH /:id/geom` etait audite.
 */
function ecrireTrace(geom: Trace, userId: string) {
  return async (tx: unknown, enregistrement: Record<string, unknown>) => {
    const client = tx as Pick<typeof prisma, "$executeRaw" | "$queryRaw">;
    const id = enregistrement.id as string;
    const avant = await resumeGeom(id, client);
    await setLineGeom(id, geom, client);
    await logAuditTransactionnelle(tx as never, {
      userId, action: "UPDATE", entityType: "Troncon", entityId: id,
      before: { geom: avant }, after: { geom: { points: geom.coordinates.length } },
    });
  };
}

async function createWithGeom(data: TronconCreateInput & { geom?: Trace }, userId: string) {
  const { geom, ...rest } = data;
  if (geom) await verifierTrace(geom);
  return base.create(rest, userId, geom ? ecrireTrace(geom, userId) : undefined);
}

async function updateWithGeom(id: string, data: Partial<TronconCreateInput & { geom?: Trace }>, userId: string) {
  const { geom, ...rest } = data;
  if (geom) await verifierTrace(geom);
  return base.update(id, rest, userId, geom ? ecrireTrace(geom, userId) : undefined);
}

/**
 * UNE GEOMETRIE NE SE REECRIT PLUS SANS TRACE.
 *
 * Constat du 13/10/2026 : cette fonction ecrivait le trace et n'auditait RIEN. Le
 * controleur ne lui transmettait meme pas l'identifiant de l'utilisateur, pourtant
 * verifie juste au-dessus. Le trace d'un tronçon — celui qui commande la carte, la
 * longueur, l'appariement GPS et donc le lineaire publie — pouvait donc etre remplace
 * sans qu'on puisse dire par qui ni quand.
 *
 * C'est la regle 3 d'AGENTS.md, « toute ecriture est auditee », manquee sur le champ le
 * plus consequent de la base.
 *
 * Le resume de l'ancien trace est lu DANS la transaction, avant l'ecriture : le lire
 * avant l'ouvrir laisserait une fenetre ou une autre edition s'intercale, et l'audit
 * comparerait alors a un etat qui n'a jamais precede celui-ci.
 */
async function updateGeomOnly(
  id: string,
  geom: { type: string; coordinates: number[][] },
  userId: string,
): Promise<void> {
  await verifierTrace(geom);
  await prisma.$transaction(async (tx) => {
    const avant = await resumeGeom(id, tx);
    await setLineGeom(id, geom, tx);
    await logAuditTransactionnelle(tx, {
      userId,
      action: "UPDATE",
      entityType: "Troncon",
      entityId: id,
      before: { geom: avant },
      after: { geom: { points: geom.coordinates.length } },
    });
  });
}

export const tronconsService = { ...base, list, listGeo, exportXlsx, importXlsx, fiche, itineraire, createWithGeom, updateWithGeom, updateGeomOnly };
