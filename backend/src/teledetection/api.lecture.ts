/**
 * Lecture de l'observation de la Terre pour l'API (chantier EO-API) : listes, detail, GeoJSON, registre des produits,
 * sources. SQL brut parametre (`geom`, `centre` et `emprise` sont des colonnes `Unsupported` pour Prisma).
 *
 * LE PERIMETRE TERRITORIAL EST DANS LA REQUETE, PAS APRES : un compte regional n'obtient que les lignes dont
 * `pt.regionId` est dans ses regions (une proposition non rattachee a une region NULL, donc jamais visible d'un
 * compte regional). Un compte national n'a pas de clause. Ce filtre s'applique aux listes, au comptage, au GeoJSON
 * et a la ressource designee par son identifiant (`chargerVisible`), pour qu'une ressource hors perimetre et une
 * ressource inexistante donnent la MEME reponse.
 *
 * Les donnees SYNTHETIQUES (jeux de test) sont exclues de toute liste, de tout comptage et du GeoJSON : elles
 * n'apparaissent jamais dans une vue de production (contrat, section 9). Le detail par identifiant les rend, avec
 * leur drapeau, pour qui connait l'identifiant.
 *
 * Aucune lecture n'est auditee (les ecritures le sont, dans leurs transactions) : voir API.md.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { observationDansPortee } from "./observation.perimetre";
import {
  dateSql, echapperLike, encoderCurseur, formerApercu, formerProduitRef, formerProposition, formerSource, resumeObservation,
  type FiltresGeo, type FiltresProduits, type FiltresPropositions, type LignePropositionBase, type LigneProduitRef,
} from "./api.noyau";

export type DepotLecture = Pick<PrismaClient, "$queryRaw">;

/** Regions visibles ; `null` = toutes (compte national). */
export type Portee = { regions: readonly number[] | null };

const sansRegion = (portee: Portee): Prisma.Sql =>
  portee.regions === null ? Prisma.empty : Prisma.sql`AND pt."regionId" = ANY(${[...portee.regions]}::int[])`;

// ============================================================ ressource designee par son identifiant

export interface PropositionVisible { id: string; regionId: number | null; statut: string; missionId: string | null }

/**
 * La proposition, si elle existe ET si le compte la voit ; sinon `null` -- la meme reponse pour « n'existe pas » et pour
 * « hors de votre perimetre », afin que le code d'etat ne dise pas laquelle des deux. Les donnees synthetiques sont lisibles
 * par identifiant (le detail porte leur drapeau).
 */
export async function chargerVisible(depot: DepotLecture, id: string, portee: Portee): Promise<PropositionVisible | null> {
  const l = await depot.$queryRaw<PropositionVisible[]>`
    SELECT pt."id", pt."regionId", pt."statut", pt."missionId" FROM "propositions_teledetection" pt
     WHERE pt."id" = ${id} ${sansRegion(portee)}`;
  return l[0] ?? null;
}

// ============================================================ propositions

const COLONNES = Prisma.sql`
  pt."id", pt."type", pt."statut", pt."prioriteNiveau", pt."prioriteRegle", pt."confianceDetection", pt."confianceCalibree",
  pt."imageCouvertureNuagesPct", pt."imageNote", pt."rattachementConfiance", pt."rattachementAlgorithme", pt."distanceTronconM",
  pt."methode", pt."methodeNom", pt."methodeVersion", pt."missionId", pt."synthetique", pt."regionId",
  p."id" AS "produitId", p."dateAcquisition" AS "dateObservation", ref."dateAcquisition" AS "dateReference",
  p."sourceCode", p."source" AS "sourceLibelle", p."capteur" AS "produitCapteur", p."resolutionM", p."resolutionNativeM",
  p."fournisseur", p."identifiantFournisseur", p."collection", p."cycleVie", p."synthetique" AS "produitSynthetique",
  s."nom" AS "sourceNom", s."capteur" AS "sourceCapteur", s."resolutionM" AS "sourceResolutionM",
  t."id" AS "tronconId", t."code" AS "tronconCode", t."nom" AS "tronconNom", r."nom" AS "regionNom",
  ST_Y(pt."centre") AS "lat", ST_X(pt."centre") AS "lon"`;

const JOINTURES = Prisma.sql`
  FROM "propositions_teledetection" pt
  JOIN "earth_observation_products" p ON p."id" = pt."produitId"
  LEFT JOIN "earth_observation_products" ref ON ref."id" = pt."produitReferenceId"
  LEFT JOIN "sources_observation" s ON s."code" = p."sourceCode"
  LEFT JOIN "troncons" t ON t."id" = pt."tronconId"
  LEFT JOIN "regions" r ON r."id" = pt."regionId"`;

function conditionsPropositions(f: Omit<FiltresPropositions, "limite" | "curseur">, portee: Portee): Prisma.Sql[] {
  const c: Prisma.Sql[] = [Prisma.sql`NOT pt."synthetique"`];
  if (portee.regions !== null) c.push(Prisma.sql`pt."regionId" = ANY(${[...portee.regions]}::int[])`);
  if (f.statut) c.push(Prisma.sql`pt."statut" = ANY(${f.statut}::text[])`);
  if (f.type) c.push(Prisma.sql`pt."type" = ANY(${f.type}::text[])`);
  if (f.priorite) c.push(Prisma.sql`pt."prioriteNiveau" = ANY(${f.priorite}::text[])`);
  if (f.source) c.push(Prisma.sql`p."sourceCode" = ANY(${f.source}::text[])`);
  if (f.methode) c.push(Prisma.sql`(pt."methodeNom" = ${f.methode} OR pt."methode" = ${f.methode})`);
  if (f.regionId !== undefined) c.push(Prisma.sql`pt."regionId" = ${f.regionId}::int`);
  if (f.tronconId) c.push(Prisma.sql`pt."tronconId" = ${f.tronconId}`);
  if (f.rattachee === true) c.push(Prisma.sql`pt."tronconId" IS NOT NULL`);
  if (f.rattachee === false) c.push(Prisma.sql`pt."tronconId" IS NULL`);
  if (f.depuis) c.push(Prisma.sql`p."dateAcquisition" >= ${dateSql(f.depuis)}::timestamp`);
  if (f.jusqua) c.push(Prisma.sql`p."dateAcquisition" <= ${dateSql(f.jusqua)}::timestamp`);
  if (f.q) {
    const motif = `%${echapperLike(f.q)}%`;
    const debutId = `${echapperLike(f.q)}%`;
    c.push(Prisma.sql`(t."code" ILIKE ${motif} OR t."nom" ILIKE ${motif} OR pt."methode" ILIKE ${motif} OR pt."id" ILIKE ${debutId})`);
  }
  return c;
}

export async function listerPropositions(depot: DepotLecture, f: FiltresPropositions, portee: Portee) {
  const base = conditionsPropositions(f, portee);
  const pageConds = [...base];
  if (f.curseur) {
    const d = `${f.curseur.d.replace("T", " ").replace("Z", "")}`;
    pageConds.push(Prisma.sql`(p."dateAcquisition" < ${d}::timestamp OR (p."dateAcquisition" = ${d}::timestamp AND pt."id" > ${f.curseur.id}))`);
  }
  // un de plus que la page : sa presence dit s'il y a une suite, sans compter
  const lignes = await depot.$queryRaw<LignePropositionBase[]>`
    SELECT ${COLONNES} ${JOINTURES} WHERE ${Prisma.join(pageConds, " AND ")}
     ORDER BY p."dateAcquisition" DESC, pt."id" ASC LIMIT ${f.limite + 1}`;
  const total = (await depot.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" ${JOINTURES} WHERE ${Prisma.join(base, " AND ")}`)[0]?.n ?? 0;
  const page = lignes.slice(0, f.limite);
  const derniere = page[page.length - 1];
  const suivant = lignes.length > f.limite && derniere
    ? encoderCurseur({ d: new Date(derniere.dateObservation).toISOString(), id: derniere.id }) : null;
  return { items: page.map(formerProposition), suivant, total };
}

// ------------------------------------------------------------ GeoJSON

export async function geoPropositions(depot: DepotLecture, f: FiltresGeo, portee: Portee) {
  const [o, s, e, n] = f.bbox;
  const c: Prisma.Sql[] = [
    Prisma.sql`NOT pt."synthetique"`,
    Prisma.sql`pt."geom" && ST_MakeEnvelope(${o}::double precision, ${s}::double precision, ${e}::double precision, ${n}::double precision, 4326)`,
    Prisma.sql`ST_Intersects(pt."geom", ST_MakeEnvelope(${o}::double precision, ${s}::double precision, ${e}::double precision, ${n}::double precision, 4326))`,
  ];
  if (portee.regions !== null) c.push(Prisma.sql`pt."regionId" = ANY(${[...portee.regions]}::int[])`);
  if (f.statut) c.push(Prisma.sql`pt."statut" = ANY(${f.statut}::text[])`);
  if (f.type) c.push(Prisma.sql`pt."type" = ANY(${f.type}::text[])`);
  if (f.priorite) c.push(Prisma.sql`pt."prioriteNiveau" = ANY(${f.priorite}::text[])`);
  const quand = Prisma.join(c, " AND ");
  // ordre de plafonnement du contrat : priorite haute, puis A_VERIFIER, puis identifiant (deterministe)
  const lignes = await depot.$queryRaw<{ id: string; type: string; statut: string; prioriteNiveau: string | null; rattachee: boolean; geometrie: unknown }[]>`
    SELECT pt."id", pt."type", pt."statut", pt."prioriteNiveau", (pt."tronconId" IS NOT NULL) AS "rattachee",
           ST_AsGeoJSON(pt."geom", 6)::jsonb AS "geometrie"
      FROM "propositions_teledetection" pt
     WHERE ${quand}
     ORDER BY coalesce(pt."prioriteNiveau" = 'HAUTE', false) DESC, (pt."statut" = 'A_VERIFIER') DESC, pt."id" ASC
     LIMIT ${f.limite}`;
  const total = (await depot.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "propositions_teledetection" pt WHERE ${quand}`)[0]?.n ?? 0;
  return {
    type: "FeatureCollection" as const,
    features: lignes.map((l) => ({
      type: "Feature" as const,
      geometry: typeof l.geometrie === "string" ? JSON.parse(l.geometrie) : l.geometrie,
      properties: { id: l.id, type: l.type, statut: l.statut, priorite: l.prioriteNiveau, rattachee: l.rattachee },
    })),
    tronque: total > lignes.length,
    total,
  };
}

// ------------------------------------------------------------ detail

const COLONNES_PRODUIT = (alias: string) => Prisma.raw(
  `${alias}."id" AS "${alias}_id", ${alias}."code" AS "${alias}_code", ${alias}."sourceCode" AS "${alias}_sourceCode", ${alias}."source" AS "${alias}_source",
   ${alias}."fournisseur" AS "${alias}_fournisseur", ${alias}."identifiantFournisseur" AS "${alias}_identifiantFournisseur",
   ${alias}."collection" AS "${alias}_collection", ${alias}."capteur" AS "${alias}_capteur", ${alias}."nature" AS "${alias}_nature",
   ${alias}."niveauTraitement" AS "${alias}_niveauTraitement", ${alias}."dateAcquisition" AS "${alias}_dateAcquisition",
   ${alias}."resolutionM" AS "${alias}_resolutionM", ${alias}."resolutionNativeM" AS "${alias}_resolutionNativeM",
   ${alias}."couvertureNuagesPct" AS "${alias}_couvertureNuagesPct", ${alias}."cycleVie" AS "${alias}_cycleVie",
   ${alias}."scene" AS "${alias}_scene", ${alias}."synthetique" AS "${alias}_synthetique"`,
);

function produitDepuisLigne(l: Record<string, unknown>, alias: string): LigneProduitRef | null {
  if (l[`${alias}_id`] === null || l[`${alias}_id`] === undefined) return null;
  const g = (k: string) => l[`${alias}_${k}`];
  return {
    id: g("id") as string, code: g("code") as string, sourceCode: g("sourceCode") as string | null, source: g("source") as string,
    fournisseur: g("fournisseur") as string | null, identifiantFournisseur: g("identifiantFournisseur") as string | null,
    collection: g("collection") as string | null, capteur: g("capteur") as string | null, nature: g("nature") as string,
    niveauTraitement: g("niveauTraitement") as string | null, dateAcquisition: g("dateAcquisition") as Date,
    resolutionM: Number(g("resolutionM")), resolutionNativeM: g("resolutionNativeM") === null ? null : Number(g("resolutionNativeM")),
    couvertureNuagesPct: g("couvertureNuagesPct") === null ? null : Number(g("couvertureNuagesPct")),
    cycleVie: g("cycleVie") as string, scene: g("scene") as string | null, synthetique: g("synthetique") as boolean,
  };
}

/** Detail complet du contrat (section 6). `null` si la proposition n'existe pas (la visibilite a ete controlee avant). */
export async function detailProposition(depot: DepotLecture, id: string, portee: Portee) {
  const [l] = await depot.$queryRaw<(LignePropositionBase & Record<string, unknown>)[]>`
    SELECT ${COLONNES},
           pt."limites", pt."motifAttente", pt."verifieeLe", pt."motifVerdict", pt."constatRef", pt."rattachementCandidats",
           p."versionTraitement", p."licence", p."licenceCode", p."licenceAttribution", p."empreinteSha256", p."provenance",
           ST_AsGeoJSON(pt."geom", 7)::jsonb AS "geometrie",
           ${COLONNES_PRODUIT("p")}, ${COLONNES_PRODUIT("ref")}
      ${JOINTURES}
     WHERE pt."id" = ${id}`;
  if (!l) return null;

  const transitions = await depot.$queryRaw<{ de: string; vers: string; auteurId: string; auteurNom: string | null; creeLe: Date; motif: string; commentaire: string | null; motifAttente: string | null }[]>`
    SELECT tr."de", tr."vers", tr."auteurId", u."nomComplet" AS "auteurNom", tr."creeLe", tr."motif", tr."commentaire", tr."motifAttente"
      FROM "propositions_teledetection_transitions" tr LEFT JOIN "users" u ON u."id" = tr."auteurId"
     WHERE tr."propositionId" = ${id} ORDER BY tr."creeLe" ASC, tr."id" ASC`;
  const mission = l.missionId
    ? (await depot.$queryRaw<{ id: string; statut: string; assigneNom: string | null }[]>`
        SELECT m."id", m."statut"::text AS "statut", u."nomComplet" AS "assigneNom" FROM "missions" m LEFT JOIN "users" u ON u."id" = m."assigneId"
         WHERE m."id" = ${l.missionId}`)[0] ?? null
    : null;
  // Les preuves sont des observations d'AUTRES agents, possiblement d'une autre region que celle de la proposition (citees avant ce controle,
  // ou par un compte national). Le droit de les LIRE est controle ici, a la lecture, et pas seulement a leur citation : un compte regional ne
  // recoit ni l'auteur, ni le type, ni la description d'une observation hors de son perimetre. Elle est comptee (`observationsMasquees`), pas
  // omise en silence.
  const preuves = await depot.$queryRaw<{ id: string; date: Date; auteur: string | null; type: string | null; description: string | null; visible: boolean }[]>`
    SELECT o."id", o."observeA" AS "date", u."nomComplet" AS "auteur", o."type"::text AS "type", o."description",
           ${observationDansPortee("o", portee.regions)} AS "visible"
      FROM "propositions_teledetection_preuves" pr JOIN "observations" o ON o."id" = pr."observationId" LEFT JOIN "users" u ON u."id" = o."agentId"
     WHERE pr."propositionId" = ${id} ORDER BY pr."ajouteeLe" ASC, pr."id" ASC`;
  const lisibles = preuves.filter((o) => o.visible !== false);

  const apres = produitDepuisLigne(l, "p");
  const avant = produitDepuisLigne(l, "ref");
  const base = formerProposition(l);
  const verdict = l.statut === "CONFIRMEE" || l.statut === "INFIRMEE"
    ? { statut: l.statut, le: l.verifieeLe ? new Date(l.verifieeLe as Date).toISOString() : null, motif: l.motifVerdict as string | null, constatRef: l.constatRef as string | null }
    : null;
  return {
    ...base,
    motifAttente: l.motifAttente as string | null,
    verdict,
    produitApres: formerProduitRef(apres),
    produitAvant: formerProduitRef(avant),
    // NULL = non renseignees (ligne d'avant la migration du workflow) : ce n'est PAS « aucune limite ». On rend null et on le dit.
    limites: (l.limites as string[] | null) ?? null,
    limitesNonRenseignees: (l.limites as string[] | null) == null,
    provenance: {
      fournisseur: apres?.fournisseur ?? null,
      identifiantFournisseur: apres?.identifiantFournisseur ?? null,
      licence: (l.licence as string | null) ?? null,
      attribution: (l.licenceAttribution as string | null) ?? null,
      versionTraitement: (l.versionTraitement as string | null) ?? null,
      empreinteSha256: (l.empreinteSha256 as string | null) ?? null,
    },
    rattachementCandidats: (l.rattachementCandidats as unknown[] | null) ?? [],
    geometrie: typeof l.geometrie === "string" ? JSON.parse(l.geometrie) : (l.geometrie ?? null),
    historique: transitions.map((t) => ({
      de: t.de, vers: t.vers, auteur: { id: t.auteurId, nom: t.auteurNom ?? t.auteurId }, date: new Date(t.creeLe).toISOString(),
      motif: t.motif, commentaire: t.commentaire,
    })),
    mission: mission ? { id: mission.id, statut: mission.statut, assigneNom: mission.assigneNom } : null,
    terrain: {
      observations: lisibles.map((o) => ({ id: o.id, date: new Date(o.date).toISOString(), auteur: o.auteur, resume: resumeObservation(o.type, o.description) })),
      observationsMasquees: preuves.length - lisibles.length,
    },
    apercus: { avant: formerApercu(avant, l.dateReference), apres: formerApercu(apres, l.dateObservation) },
  };
}

// ============================================================ produits

export async function listerProduits(depot: DepotLecture, f: FiltresProduits) {
  const c: Prisma.Sql[] = [Prisma.sql`p."deletedAt" IS NULL`, Prisma.sql`NOT p."synthetique"`];
  if (f.source) c.push(Prisma.sql`p."sourceCode" = ANY(${f.source}::text[])`);
  if (f.nature) c.push(Prisma.sql`p."nature" = ANY(${f.nature}::text[])`);
  if (f.depuis) c.push(Prisma.sql`p."dateAcquisition" >= ${dateSql(f.depuis)}::timestamp`);
  if (f.jusqua) c.push(Prisma.sql`p."dateAcquisition" <= ${dateSql(f.jusqua)}::timestamp`);
  if (f.bbox) {
    const [o, s, e, n] = f.bbox;
    c.push(Prisma.sql`ST_Intersects(p."emprise", ST_MakeEnvelope(${o}::double precision, ${s}::double precision, ${e}::double precision, ${n}::double precision, 4326))`);
  }
  const page = [...c];
  if (f.curseur) {
    const d = f.curseur.d.replace("T", " ").replace("Z", "");
    page.push(Prisma.sql`(p."dateAcquisition" < ${d}::timestamp OR (p."dateAcquisition" = ${d}::timestamp AND p."id" > ${f.curseur.id}))`);
  }
  const lignes = await depot.$queryRaw<Record<string, unknown>[]>`
    SELECT p."id", p."code", p."sourceCode", p."source", p."fournisseur", p."identifiantFournisseur", p."collection", p."capteur", p."nature",
           p."niveauTraitement", p."scene", p."dateAcquisition", p."dateFin", p."resolutionM", p."resolutionNativeM", p."couvertureNuagesPct",
           p."cycleVie", p."licence", p."licenceCode", p."licenceAttribution", p."versionTraitement", p."empreinteSha256", p."orbite",
           s."nom" AS "sourceNom"
      FROM "earth_observation_products" p LEFT JOIN "sources_observation" s ON s."code" = p."sourceCode"
     WHERE ${Prisma.join(page, " AND ")}
     ORDER BY p."dateAcquisition" DESC, p."id" ASC LIMIT ${f.limite + 1}`;
  const total = (await depot.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS "n" FROM "earth_observation_products" p WHERE ${Prisma.join(c, " AND ")}`)[0]?.n ?? 0;
  const pageLignes = lignes.slice(0, f.limite);
  const derniere = pageLignes[pageLignes.length - 1];
  const suivant = lignes.length > f.limite && derniere
    ? encoderCurseur({ d: new Date(derniere.dateAcquisition as Date).toISOString(), id: derniere.id as string }) : null;
  return {
    items: pageLignes.map((p) => ({
      id: p.id, code: p.code, source: { code: p.sourceCode ?? p.source, nom: p.sourceNom ?? p.source }, fournisseur: p.fournisseur,
      identifiantFournisseur: p.identifiantFournisseur, collection: p.collection, capteur: p.capteur, nature: p.nature,
      niveauTraitement: p.niveauTraitement, scene: p.scene, orbite: p.orbite,
      dateAcquisition: new Date(p.dateAcquisition as Date).toISOString(), dateFin: p.dateFin ? new Date(p.dateFin as Date).toISOString() : null,
      resolutionM: Number(p.resolutionM), resolutionNativeM: p.resolutionNativeM === null ? null : Number(p.resolutionNativeM),
      couvertureNuagesPct: p.couvertureNuagesPct === null ? null : Number(p.couvertureNuagesPct),
      cycleVie: p.cycleVie, licence: p.licence, licenceCode: p.licenceCode, licenceAttribution: p.licenceAttribution,
      versionTraitement: p.versionTraitement, empreinteSha256: p.empreinteSha256,
      apercuDisponible: !!p.identifiantFournisseur && !!p.collection && !!p.sourceCode,
    })),
    suivant, total,
  };
}

export interface ProduitApercu {
  id: string; sourceCode: string | null; fournisseur: string | null; identifiantFournisseur: string | null; collection: string | null;
  cycleVie: string; synthetique: boolean;
}

export async function produitPourApercu(depot: DepotLecture, id: string): Promise<ProduitApercu | null> {
  const l = await depot.$queryRaw<ProduitApercu[]>`
    SELECT p."id", p."sourceCode", p."fournisseur", p."identifiantFournisseur", p."collection", p."cycleVie", p."synthetique"
      FROM "earth_observation_products" p WHERE p."id" = ${id} AND p."deletedAt" IS NULL`;
  return l[0] ?? null;
}

// ============================================================ sources

export async function listerSources(depot: DepotLecture, adaptateurDe: (code: string) => string | null) {
  const l = await depot.$queryRaw<Parameters<typeof formerSource>[0][]>`
    SELECT "code", "nom", "fournisseur", "capteur", "resolutionM", "etat", "derniereVerificationLe", "derniereAcquisitionLe", "dernierMessage", "requiertIdentifiants"
      FROM "sources_observation" WHERE "deletedAt" IS NULL ORDER BY "code" ASC`;
  return l.map((s) => formerSource(s, adaptateurDe(s.code)));
}
