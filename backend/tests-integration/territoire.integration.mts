// Banc d'integration du controle d'acces territorial (A10, « 403 hors zone »), avec de VRAIS comptes a
// perimetre regional. Voir tests-integration/README.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/territoire.integration.mts
//
// CE QUE LE BANC FAIT PASSER PAR LE CODE REEL : les routeurs v1 (troncons, ouvrages, chantiers, points noirs,
// postes, inspections, ordres de travaux) et le routeur v2 montes comme en production, des jetons signes par des
// secrets aleatoires tires a chaque lancement, le perimetre LU EN BASE (`perimetres_comptes`) a chaque requete,
// l'audit transactionnel, contre un clone PostGIS jetable. Rien n'est simule cote serveur : avant ce banc, le
// controle n'etait eprouve qu'en route avec un perimetre simule (tests unitaires) et en SQL (5 assertions).
// Les verifications relisent la BASE (ligne inchangee, ligne creee, trace d'audit), jamais la seule reponse.
//
// COUVERT : un compte regional (une region), un compte a deux regions, un compte national sans rattachement, un
// ADMIN ; les cinq entites de la fabrique CRUD (creation, modification avant ET apres, archivage, restauration,
// archivage et restauration en masse ligne a ligne) ; les routes v1 hors fabrique (geometrie, geolocalisation,
// inspection, conversion d'OT) ; les routes v2 (portions, defauts, decision sur un defaut) ; la synchronisation
// (operation hors perimetre rejetee seule) ; le perimetre vide, la region inconnue ; la lecture refusee hors
// perimetre (fiche 360) et la portee du tableau de bord.
//
// NON COUVERT (dit honnetement) : les imports Excel ligne a ligne (le controle y passe par `create` et `update`,
// verifies ici par la fabrique mais pas par un fichier reel), les photos d'ouvrage (televersement), la validation
// d'une proposition de localisation (T-32 la garde), les observations (`/observations/:id/validate`), les routes
// du roulage et des taches internes (bancs `roulage` et `taches-internes`). La LECTURE des listes et fiches v1 n'est
// pas filtree par region : c'est le comportement actuel (consigne par une verification « CONSTAT »), pas une exigence
// que le banc defend. Aucun compte de production n'a de perimetre (D-11) : ce banc prouve le mecanisme, pas la
// configuration d'AGEROUTE.
import { randomUUID } from "node:crypto";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_territoire");
const { prisma } = await banc.imp("lib/prisma");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const { signAccessToken } = await banc.imp("utils/jwt");
const { tronconsRouter } = await banc.imp("modules/troncons/troncons.routes");
const { ouvragesRouter } = await banc.imp("modules/ouvrages/ouvrages.routes");
const { chantiersRouter } = await banc.imp("modules/chantiers/chantiers.routes");
const { pointsNoirsRouter } = await banc.imp("modules/points-noirs/points-noirs.routes");
const { postesRouter } = await banc.imp("modules/postes/postes.routes");
const { inspectionsRouter } = await banc.imp("modules/inspections/inspections.routes");
const { otRouter } = await banc.imp("modules/ordres-travaux/ot.routes");
const { apiV2Router } = await banc.imp("api-v2/index");
const express = (await import("express")).default;
const request = (await import("supertest")).default;

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/troncons", tronconsRouter);
app.use("/api/ouvrages", ouvragesRouter);
app.use("/api/chantiers", chantiersRouter);
app.use("/api/points-noirs", pointsNoirsRouter);
app.use("/api/postes", postesRouter);
app.use("/api/inspections", inspectionsRouter);
app.use("/api/ordres-travaux", otRouter);
app.use("/api/v2", apiV2Router);
app.use(errorHandler);

const MODULES = ["troncons", "ouvrages", "points-noirs", "postes", "chantiers", "inspections", "geoportail", "ordres-travaux", "dashboard", "programmation"];
const sql = async <T = Record<string, unknown>>(texte: string, ...params: unknown[]): Promise<T[]> => prisma.$queryRawUnsafe(texte, ...params);
const compter = async (texte: string, ...params: unknown[]): Promise<number> => Number((await sql<{ n: bigint }>(texte, ...params))[0].n);
const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });

type Verbe = "get" | "post" | "put" | "patch" | "delete";
const appeler = (verbe: Verbe, url: string, token: string, corps?: unknown) => {
  const r = request(app)[verbe](url).set("Authorization", `Bearer ${token}`);
  return corps === undefined ? r : r.send(corps as object);
};
const refus = (r: { status: number; body: { code?: string } }, code?: string) => r.status === 403 && (code === undefined || r.body.code === code);
const ecritOk = (r: { status: number }) => r.status >= 200 && r.status < 300;

async function main() {
  // ---------------------------------------------------------------- Fixtures : regions, comptes, perimetres
  await sql(`INSERT INTO regions (nom) VALUES ('Region territoire 1'), ('Region territoire 2'), ('Region territoire 3')`);
  const regionId = async (nom: string) => Number((await sql<{ id: number }>(`SELECT id FROM regions WHERE nom = $1`, nom))[0].id);
  const [R1, R2, R3] = [await regionId("Region territoire 1"), await regionId("Region territoire 2"), await regionId("Region territoire 3")];

  const mkUser = (email: string, role: string) =>
    prisma.user.create({ data: { email, nomComplet: email, passwordHash: "x", role, modulesAutorises: MODULES } });
  const admin = await mkUser("admin@terr.invalid", "ADMIN");
  const regional = await mkUser("regional@terr.invalid", "GESTIONNAIRE");     // R1 seulement
  const biregional = await mkUser("biregional@terr.invalid", "GESTIONNAIRE");  // R1 et R2
  const national = await mkUser("national@terr.invalid", "GESTIONNAIRE");      // aucun rattachement = national
  const lecteur = await mkUser("lecteur@terr.invalid", "LECTEUR");
  const T = { admin: jeton(admin), regional: jeton(regional), bi: jeton(biregional), national: jeton(national), lecteur: jeton(lecteur) };
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $5), ($3, $2, $5), ($3, $4, $5)`, regional.id, R1, biregional.id, R2, admin.id);

  // ---------------------------------------------------------------- Fixtures : une fiche par region et par entite
  const geomT = `ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.58, 9.64)), 4326)`;
  const mkTroncon = async (code: string, rid: number) => {
    const id = randomUUID();
    await sql(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
               VALUES ($1, $2, 'Troncon ' || $2, 'RR', $3, 2.2, 'BITUME', 0, 2.2, ${geomT}, now())`, id, code, rid);
    return id;
  };
  const T1 = await mkTroncon("TERR-T1", R1);
  const T2 = await mkTroncon("TERR-T2", R2);

  interface Entite {
    nom: string; base: string; table: string; champ: string; valeurChamp: unknown;
    corps: (rid: number, marque: string) => Record<string, unknown>;
    fixture: (rid: number, marque: string) => Promise<string>;
    marque: (marque: string) => Promise<number>;
  }
  const ENTITES: Entite[] = [
    {
      nom: "troncon", base: "/api/troncons", table: "troncons", champ: "nom", valeurChamp: "Nom modifie",
      corps: (rid, m) => ({ code: m, nom: `Troncon ${m}`, classe: "RR", regionId: rid, longueurKm: 3, revetement: "BITUME", pkDebut: 0, pkFin: 3 }),
      fixture: async (rid, m) => (await prisma.troncon.create({ data: { code: m, nom: `Troncon ${m}`, classe: "RR", regionId: rid, longueurKm: 3, revetement: "BITUME", pkDebut: 0, pkFin: 3 } })).id,
      marque: (m) => compter(`SELECT count(*) n FROM troncons WHERE code = $1`, m),
    },
    {
      nom: "ouvrage", base: "/api/ouvrages", table: "ouvrages", champ: "remarques", valeurChamp: "Remarque modifiee",
      corps: (rid, m) => ({ nom: m, type: "PONT", regionId: rid }),
      fixture: async (rid, m) => (await prisma.ouvrage.create({ data: { nom: m, type: "PONT", regionId: rid } })).id,
      marque: (m) => compter(`SELECT count(*) n FROM ouvrages WHERE nom = $1`, m),
    },
    {
      nom: "chantier", base: "/api/chantiers", table: "chantiers", champ: "observations", valeurChamp: "Observation modifiee",
      corps: (rid, m) => ({ intitule: m, entreprise: "Entreprise banc", regionId: rid }),
      fixture: async (rid, m) => (await prisma.chantier.create({ data: { intitule: m, entreprise: "Entreprise banc", regionId: rid } })).id,
      marque: (m) => compter(`SELECT count(*) n FROM chantiers WHERE intitule = $1`, m),
    },
    {
      nom: "point noir", base: "/api/points-noirs", table: "points_noirs", champ: "causes", valeurChamp: "Causes modifiees",
      corps: (rid, m) => ({ description: m, regionId: rid, gravite: "FAIBLE" }),
      fixture: async (rid, m) => (await prisma.pointNoir.create({ data: { description: m, regionId: rid, gravite: "FAIBLE" } })).id,
      marque: (m) => compter(`SELECT count(*) n FROM points_noirs WHERE description = $1`, m),
    },
    {
      nom: "poste", base: "/api/postes", table: "postes", champ: "traficJma", valeurChamp: 4242,
      corps: (rid, m) => ({ nom: m, type: "PEAGE", regionId: rid }),
      fixture: async (rid, m) => (await prisma.poste.create({ data: { nom: m, type: "PEAGE", regionId: rid } })).id,
      marque: (m) => compter(`SELECT count(*) n FROM postes WHERE nom = $1`, m),
    },
  ];
  const ligne = async (e: Entite, id: string) => (await sql<{ regionId: number; deletedAt: Date | null; v: unknown }>(`SELECT "regionId", "deletedAt", "${e.champ}" AS v FROM ${e.table} WHERE id = $1`, id))[0];
  const audits = (id: string, action?: string) => compter(`SELECT count(*) n FROM audit_logs WHERE "entityId" = $1 ${action ? `AND action = '${action}'` : ""}`, id);

  // ================================================================ 1. Fabrique CRUD : cinq entites, cinq comptes
  console.log("\n== 1. Fabrique CRUD (troncons, ouvrages, chantiers, points noirs, postes) ==");
  for (const e of ENTITES) {
    const m = (s: string) => `${e.nom.replace(" ", "-")}-${s}`.toUpperCase();
    // creation
    const horsZone = await appeler("post", e.base, T.regional, e.corps(R2, m("CREE-R2")));
    verifier(`${e.nom} : le compte regional (R1) ne cree pas en R2 : 403, et aucune ligne n'est creee`, refus(horsZone) && await e.marque(m("CREE-R2")) === 0, horsZone.body);
    const dansZone = await appeler("post", e.base, T.regional, e.corps(R1, m("CREE-R1")));
    verifier(`${e.nom} : il cree en R1 : 201, ligne en R1, creation auditee par ce compte`,
      dansZone.status === 201 && await e.marque(m("CREE-R1")) === 1
      && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityId" = $1 AND action = 'CREATE' AND "userId" = $2`, dansZone.body.id, regional.id) === 1, dansZone.body);

    // modification : avant, apres
    const fR1 = await e.fixture(R1, m("FICHE-R1")), fR2 = await e.fixture(R2, m("FICHE-R2")), fR3 = await e.fixture(R3, m("FICHE-R3"));
    const majHors = await appeler("put", `${e.base}/${fR2}`, T.regional, { [e.champ]: e.valeurChamp });
    verifier(`${e.nom} : modifier une fiche de R2 : 403, fiche inchangee, aucune trace d'ecriture`,
      refus(majHors) && (await ligne(e, fR2)).v !== e.valeurChamp && await audits(fR2, "UPDATE") === 0, majHors.body);
    const deplace = await appeler("put", `${e.base}/${fR1}`, T.regional, { regionId: R2 });
    verifier(`${e.nom} : deplacer sa propre fiche vers R2 (region d'APRES hors zone) : 403, la fiche reste en R1`,
      refus(deplace) && (await ligne(e, fR1)).regionId === R1, deplace.body);
    const majDans = await appeler("put", `${e.base}/${fR1}`, T.regional, { [e.champ]: e.valeurChamp });
    verifier(`${e.nom} : modifier une fiche de R1 : 2xx, valeur ecrite, modification auditee par ce compte`,
      ecritOk(majDans) && (await ligne(e, fR1)).v == e.valeurChamp
      && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityId" = $1 AND action = 'UPDATE' AND "userId" = $2`, fR1, regional.id) === 1, majDans.body);

    // compte a deux regions : R1 -> R2 permis, R1 -> R3 refuse
    const f2 = await e.fixture(R1, m("FICHE-BI")), f2b = await e.fixture(R1, m("FICHE-BI2"));
    const biOk = await appeler("put", `${e.base}/${f2}`, T.bi, { regionId: R2 });
    const biKo = await appeler("put", `${e.base}/${f2b}`, T.bi, { regionId: R3 });
    verifier(`${e.nom} : le compte a deux regions deplace R1 vers R2 (2xx) mais pas vers R3 (403)`,
      ecritOk(biOk) && (await ligne(e, f2)).regionId === R2 && refus(biKo) && (await ligne(e, f2b)).regionId === R1, [biOk.body, biKo.body]);
    const biHors = await appeler("put", `${e.base}/${fR3}`, T.bi, { [e.champ]: e.valeurChamp });
    verifier(`${e.nom} : le compte a deux regions ne modifie pas une fiche de R3 : 403`, refus(biHors) && (await ligne(e, fR3)).v !== e.valeurChamp, biHors.body);

    // comptes nationaux : inchanges
    const nat = await appeler("put", `${e.base}/${fR3}`, T.national, { [e.champ]: e.valeurChamp });
    const adm = await appeler("put", `${e.base}/${fR2}`, T.admin, { [e.champ]: e.valeurChamp });
    verifier(`${e.nom} : le compte sans rattachement (national) et l'ADMIN modifient hors de toute zone : 2xx`, ecritOk(nat) && ecritOk(adm) && (await ligne(e, fR3)).v == e.valeurChamp && (await ligne(e, fR2)).v == e.valeurChamp, [nat.body, adm.body]);

    // archivage et restauration
    const aR2 = await e.fixture(R2, m("ARCH-R2")), aR1 = await e.fixture(R1, m("ARCH-R1"));
    const supHors = await appeler("delete", `${e.base}/${aR2}`, T.regional);
    verifier(`${e.nom} : archiver une fiche de R2 : 403, jamais archivee (suppression logique : deletedAt reste nul)`, refus(supHors) && (await ligne(e, aR2)).deletedAt === null && await audits(aR2, "DELETE") === 0, supHors.body);
    const supDans = await appeler("delete", `${e.base}/${aR1}`, T.regional);
    verifier(`${e.nom} : archiver une fiche de R1 : 2xx, deletedAt pose (la ligne reste en base), archivage audite`, ecritOk(supDans) && (await ligne(e, aR1)).deletedAt !== null && await audits(aR1, "DELETE") === 1, supDans.body);
    // archive en masse, ligne a ligne : une fiche de R1 et une de R2 dans le meme lot
    const lotR1 = await e.fixture(R1, m("LOT-R1")), lotR2 = await e.fixture(R2, m("LOT-R2"));
    const masse = await appeler("post", `${e.base}/bulk-archive`, T.regional, { ids: [lotR1, lotR2] });
    verifier(`${e.nom} : archivage en masse : la ligne de R1 passe, celle de R2 est rapportee en echec, sans arreter le lot`,
      masse.status === 200 && masse.body.success === 1 && masse.body.failed?.length === 1 && masse.body.failed[0].id === lotR2
      && (await ligne(e, lotR1)).deletedAt !== null && (await ligne(e, lotR2)).deletedAt === null, masse.body);
    // restauration : une fiche de R2 archivee par un national ne se restaure pas par le compte regional
    await sql(`UPDATE ${e.table} SET "deletedAt" = now() WHERE id = $1`, aR2);
    const rest = await appeler("post", `${e.base}/bulk-restore`, T.regional, { ids: [aR2, aR1] });
    verifier(`${e.nom} : restauration en masse : R1 restauree, R2 refusee (reste archivee), echec rapporte`,
      rest.status === 200 && rest.body.success === 1 && rest.body.failed?.length === 1 && rest.body.failed[0].id === aR2
      && (await ligne(e, aR1)).deletedAt === null && (await ligne(e, aR2)).deletedAt !== null && await audits(aR1, "RESTORE") === 1, rest.body);
    const restNat = await appeler("post", `${e.base}/bulk-restore`, T.national, { ids: [aR2] });
    verifier(`${e.nom} : le compte national restaure la fiche de R2 : success 1`, restNat.status === 200 && restNat.body.success === 1 && (await ligne(e, aR2)).deletedAt === null, restNat.body);
  }

  // Un LECTEUR n'ecrit pas, region ou pas (le role est controle avant le territoire).
  const lect = await appeler("post", "/api/troncons", T.lecteur, ENTITES[0].corps(R1, "TERR-LECTEUR"));
  verifier("un LECTEUR est refuse (403) avant meme le controle territorial, et aucune ligne n'est creee", refus(lect) && await ENTITES[0].marque("TERR-LECTEUR") === 0);

  // ================================================================ 2. Routes v1 hors fabrique
  console.log("\n== 2. Routes v1 hors fabrique (geometrie, geolocalisation, inspection, conversion d'OT) ==");
  const trace = { geom: { type: "LineString", coordinates: [[-13.61, 9.65], [-13.57, 9.66]] } };
  const longueurAvant = async (id: string) => (await sql<{ l: number }>(`SELECT ST_Length(geom::geography) AS l FROM troncons WHERE id = $1`, id))[0].l;
  const lT2 = await longueurAvant(T2);
  const geoHors = await appeler("patch", `/api/troncons/${T2}/geom`, T.regional, trace);
  verifier("PATCH geometrie d'un troncon de R2 par le compte regional : 403 HORS_PERIMETRE, trace inchange, rien d'audite",
    refus(geoHors, "HORS_PERIMETRE") && Math.abs(await longueurAvant(T2) - lT2) < 1e-6 && await audits(T2, "UPDATE") === 0, geoHors.body);
  const geoDans = await appeler("patch", `/api/troncons/${T1}/geom`, T.regional, trace);
  verifier("PATCH geometrie d'un troncon de R1 : 200, trace remplace, ecriture auditee", geoDans.status === 200 && await audits(T1, "UPDATE") === 1, geoDans.body);

  const ouvR1 = (await prisma.ouvrage.create({ data: { nom: "Ouvrage geoloc R1", type: "PONT", regionId: R1, tronconId: T1, pk: 1 } })).id;
  const ouvR2 = (await prisma.ouvrage.create({ data: { nom: "Ouvrage geoloc R2", type: "PONT", regionId: R2, tronconId: T2, pk: 1 } })).id;
  const glHors = await appeler("post", `/api/ouvrages/${ouvR2}/geolocate`, T.regional);
  const glDans = await appeler("post", `/api/ouvrages/${ouvR1}/geolocate`, T.regional);
  const pointDe = async (id: string) => (await sql<{ n: bigint }>(`SELECT count(*) n FROM ouvrages WHERE id = $1 AND geom IS NOT NULL`, id))[0].n;
  verifier("geolocalisation d'un ouvrage : R2 refusee (403, aucun point ecrit) ; R1 acceptee (200, point ecrit)",
    refus(glHors, "HORS_PERIMETRE") && Number(await pointDe(ouvR2)) === 0 && glDans.status === 200 && Number(await pointDe(ouvR1)) === 1, [glHors.body, glDans.body]);
  const pnR2 = (await prisma.pointNoir.create({ data: { description: "PN geoloc R2", regionId: R2, gravite: "FAIBLE", tronconId: T2, pk: 1 } })).id;
  const posteR2 = (await prisma.poste.create({ data: { nom: "Poste geoloc R2", type: "PEAGE", regionId: R2, tronconId: T2, pk: 1 } })).id;
  const glPn = await appeler("post", `/api/points-noirs/${pnR2}/geolocate`, T.regional);
  const glPo = await appeler("post", `/api/postes/${posteR2}/geolocate`, T.regional);
  verifier("geolocalisation d'un point noir et d'un poste de R2 : 403 chacun", refus(glPn) && refus(glPo), [glPn.body, glPo.body]);

  const insp = (cible: Record<string, string>) => ({ ...cible, dateInspection: "2026-10-20", etatObserve: "BON" });
  const ouvT1 = ouvR1;
  const inspHors = await appeler("post", "/api/inspections", T.regional, insp({ ouvrageId: ouvR2 }));
  const inspHorsTr = await appeler("post", "/api/inspections", T.regional, insp({ tronconId: T2 }));
  const inspDans = await appeler("post", "/api/inspections", T.regional, insp({ ouvrageId: ouvT1 }));
  verifier("inspection (qui propage son etat a l'ouvrage ou au troncon) : cible de R2 refusee (ouvrage, troncon) ; cible de R1 acceptee (201)",
    refus(inspHors) && refus(inspHorsTr) && inspDans.status === 201
    && await compter(`SELECT count(*) n FROM inspections WHERE "ouvrageId" = $1 OR "tronconId" = $2`, ouvR2, T2) === 0, [inspHors.body, inspHorsTr.body, inspDans.body]);

  const mkOt = (numero: string, rid: number | null) => prisma.ordreTravaux.create({ data: { numero, titre: `OT ${numero}`, typeIntervention: "AUTRE", regionId: rid, creeParId: admin.id } });
  const otR1 = await mkOt("OT-TERR-1", R1), otR2 = await mkOt("OT-TERR-2", R2), otSansRegion = await mkOt("OT-TERR-3", null);
  const cvHors = await appeler("post", `/api/ordres-travaux/${otR2.id}/convertir-chantier`, T.regional);
  const cvInconnue = await appeler("post", `/api/ordres-travaux/${otSansRegion.id}/convertir-chantier`, T.regional);
  const cvDans = await appeler("post", `/api/ordres-travaux/${otR1.id}/convertir-chantier`, T.regional);
  verifier("conversion d'OT en chantier : OT de R2 refuse (HORS_PERIMETRE) ; OT SANS region refuse (REGION_INCONNUE) ; OT de R1 accepte",
    refus(cvHors, "HORS_PERIMETRE") && refus(cvInconnue, "REGION_INCONNUE") && cvDans.status === 200
    && await compter(`SELECT count(*) n FROM chantiers WHERE intitule LIKE '[Ex-OT-TERR-2]%' OR intitule LIKE '[Ex-OT-TERR-3]%'`) === 0
    && await compter(`SELECT count(*) n FROM chantiers WHERE intitule LIKE '[Ex-OT-TERR-1]%'`) === 1, [cvHors.body, cvInconnue.body, cvDans.body]);
  const cvNat = await appeler("post", `/api/ordres-travaux/${otR2.id}/convertir-chantier`, T.national);
  verifier("le compte national convertit l'OT de R2 : 200", cvNat.status === 200, cvNat.body);

  // ================================================================ 3. Routes v2
  console.log("\n== 3. Routes v2 (portions, defauts) ==");
  const portionCorps = (tronconId: string) => ({ tronconId, debutM: 100, finM: 400 });
  const pHors = await appeler("post", "/api/v2/portions", T.regional, portionCorps(T2));
  const pDans = await appeler("post", "/api/v2/portions", T.regional, portionCorps(T1));
  verifier("portion : creation sur un troncon de R2 refusee (403, aucune portion) ; sur un troncon de R1 : 201",
    refus(pHors) && await compter(`SELECT count(*) n FROM portions WHERE "tronconId" = $1`, T2) === 0 && pDans.status === 201
    && await compter(`SELECT count(*) n FROM portions WHERE "tronconId" = $1`, T1) === 1, [pHors.body, pDans.body]);
  const pNat = await appeler("post", "/api/v2/portions", T.national, portionCorps(T2));
  verifier("portion : le compte national cree sur le troncon de R2 (201)", pNat.status === 201, pNat.body);
  const portionR2 = pNat.body.id as string;
  const decHors = await appeler("post", `/api/v2/portions/${portionR2}/decoupe`, T.regional, { aM: 250 });
  verifier("portion : decouper une portion de R2 : 403, la portion reste courante",
    refus(decHors) && await compter(`SELECT count(*) n FROM portions WHERE id = $1 AND "remplaceeLe" IS NULL`, portionR2) === 1, decHors.body);
  const portionR1 = pDans.body.id as string;
  const decDans = await appeler("post", `/api/v2/portions/${portionR1}/decoupe`, T.regional, { aM: 250 });
  verifier("portion : decouper une portion de R1 : pas de refus territorial (2xx)", ecritOk(decDans), decDans.body);

  await prisma.catalogueDefaut.create({ data: { code: "NID_TERR", libelle: "Nid de poule (banc territoire)", famille: "CHAUSSEE", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: 4 } });
  const defautCorps = (extra: Record<string, unknown>) => ({ catalogueCode: "NID_TERR", mesures: { nombre: 2 }, gravite: 2, precisionM: 4, ...extra });
  const dHors = await appeler("post", "/api/v2/defauts", T.regional, defautCorps({ tronconId: T2, pk: 0.5, lat: 9.64, lon: -13.59 }));
  const dGps = await appeler("post", "/api/v2/defauts", T.regional, defautCorps({ lat: 9.641, lon: -13.591 }));
  const dDans = await appeler("post", "/api/v2/defauts", T.regional, defautCorps({ tronconId: T1, pk: 0.5, lat: 9.64, lon: -13.59 }));
  verifier("defaut : cree sur un troncon de R2 : 403 HORS_PERIMETRE ; localise par GPS seul (region inconnue) : 403 REGION_INCONNUE ; sur un troncon de R1 : 201",
    refus(dHors, "HORS_PERIMETRE") && refus(dGps, "REGION_INCONNUE") && dDans.status === 201
    && await compter(`SELECT count(*) n FROM defauts WHERE "tronconId" = $1`, T2) === 0, [dHors.body, dGps.body, dDans.body]);
  const dNat = await appeler("post", "/api/v2/defauts", T.national, defautCorps({ tronconId: T2, pk: 0.5, lat: 9.64, lon: -13.59 }));
  const dNatGps = await appeler("post", "/api/v2/defauts", T.national, defautCorps({ lat: 9.642, lon: -13.592 }));
  verifier("defaut : le compte national cree sur R2 et par GPS seul (201 et 201)", dNat.status === 201 && dNatGps.status === 201, [dNat.body, dNatGps.body]);
  const defautR2 = dNat.body.id as string;
  const dec = await appeler("post", `/api/v2/defauts/${defautR2}/decision`, T.regional, { decision: "VALIDER" });
  const statutDefaut = async (id: string) => (await sql<{ s: string }>(`SELECT "statutValidation"::text AS s FROM defauts WHERE id = $1`, id))[0].s;
  const statutAvant = await statutDefaut(defautR2);
  verifier("defaut : decision (validation) sur un defaut de R2 par le compte regional : 403, statut inchange",
    refus(dec) && await statutDefaut(defautR2) === statutAvant, dec.body);

  // ================================================================ 4. Synchronisation terrain
  console.log("\n== 4. Synchronisation (operation hors perimetre rejetee seule) ==");
  const appareil = await prisma.appareil.create({ data: { userId: regional.id, nom: "tel regional", plateforme: "android" } });
  const opDefaut = (tronconId: string) => {
    const id = randomUUID();
    return { operationId: id, entityType: "Defaut", entityId: id, operation: "CREATE", baseVersion: null,
      payload: { catalogueCode: "NID_TERR", lat: 9.65, lon: -13.59, precisionM: 4, tronconId, mesures: { nombre: 3 }, gravite: 2 } };
  };
  const opHors = opDefaut(T2), opDans = opDefaut(T1);
  const push = await appeler("post", "/api/v2/sync/push", T.regional, { appareilId: appareil.id, operations: [opHors, opDans] });
  const statuts = new Map<string, { statut: string; motif?: string }>((push.body.resultats ?? []).map((r: { operationId: string; statut: string; motif?: string }) => [r.operationId, r]));
  verifier("sync : lot de deux operations : celle de R2 est REJETE (HORS_PERIMETRE), celle de R1 SYNCHRONISE",
    push.status === 200 && statuts.get(opHors.operationId)?.statut === "REJETE" && statuts.get(opHors.operationId)?.motif === "HORS_PERIMETRE"
    && statuts.get(opDans.operationId)?.statut === "SYNCHRONISE", push.body);
  verifier("sync : l'operation rejetee n'est PAS enregistree (aucune ligne operations_sync, aucun defaut), l'autre l'est",
    await compter(`SELECT count(*) n FROM operations_sync WHERE "operationId" = $1`, opHors.operationId) === 0
    && await compter(`SELECT count(*) n FROM defauts WHERE id = $1`, opHors.entityId) === 0
    && await compter(`SELECT count(*) n FROM defauts WHERE id = $1`, opDans.entityId) === 1);

  // ================================================================ 5. Perimetre vide, region inconnue, administration
  console.log("\n== 5. Perimetre vide, region inconnue, administration des perimetres ==");
  const sansLigne = await compter(`SELECT count(*) n FROM perimetres_comptes WHERE "userId" = $1`, national.id);
  const natEcrit = await appeler("post", "/api/troncons", T.national, ENTITES[0].corps(R3, "TERR-NAT-R3"));
  verifier("perimetre VIDE (aucune ligne) : le compte est national, il ecrit en R3 (201). Comportement d'avant, voulu (D-11)", sansLigne === 0 && natEcrit.status === 201, natEcrit.body);

  const lister = await appeler("get", "/api/v2/perimetres", T.admin);
  const nationaux = (lister.body.comptes ?? []).filter((c: { nationalParDefaut: boolean }) => c.nationalParDefaut).map((c: { email: string }) => c.email).sort();
  verifier("administration : GET /api/v2/perimetres compte les comptes nationaux PAR DEFAUT (le compte national et le lecteur, pas l'ADMIN ni les regionaux)",
    lister.status === 200 && lister.body.comptesNationauxParDefaut === 2 && nationaux.join() === ["lecteur@terr.invalid", "national@terr.invalid"].join(), lister.body);
  const nonAdmin = await appeler("get", "/api/v2/perimetres", T.regional);
  const nonAdminPut = await appeler("put", `/api/v2/perimetres/${national.id}`, T.regional, { regionIds: [R1] });
  verifier("administration : un compte regional ne lit ni ne modifie les perimetres (403)", nonAdmin.status === 403 && nonAdminPut.status === 403
    && await compter(`SELECT count(*) n FROM perimetres_comptes WHERE "userId" = $1`, national.id) === 0);

  const inconnue = await appeler("put", `/api/v2/perimetres/${national.id}`, T.admin, { regionIds: [R1, 987654] });
  verifier("region INCONNUE dans un perimetre : 400 REGION_INCONNUE, aucune ligne ecrite", inconnue.status === 400 && inconnue.body.code === "REGION_INCONNUE" && await compter(`SELECT count(*) n FROM perimetres_comptes WHERE "userId" = $1`, national.id) === 0, inconnue.body);
  const adminRestreint = await appeler("put", `/api/v2/perimetres/${admin.id}`, T.admin, { regionIds: [R1] });
  verifier("un ADMIN ne se restreint pas : 400 ADMIN_NATIONAL", adminRestreint.status === 400 && adminRestreint.body.code === "ADMIN_NATIONAL");

  // Effet IMMEDIAT, sans nouveau jeton : le perimetre est relu en base a chaque requete.
  const rattache = await appeler("put", `/api/v2/perimetres/${national.id}`, T.admin, { regionIds: [R1] });
  const apresRattachement = await appeler("put", `${ENTITES[1].base}/${await ENTITES[1].fixture(R2, "OUV-RATTACHE-R2")}`, T.national, { remarques: "x" });
  verifier("rattacher un compte a R1 : effet a la requete suivante, SANS nouveau jeton (le meme jeton est maintenant refuse hors zone), rattachement audite",
    rattache.status === 200 && refus(apresRattachement)
    && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'PerimetreCompte' AND "entityId" = $1 AND "userId" = $2`, national.id, admin.id) === 1, [rattache.body, apresRattachement.body]);
  const retire = await appeler("put", `/api/v2/perimetres/${national.id}`, T.admin, { regionIds: [] });
  const fR2b = await ENTITES[1].fixture(R2, "OUV-RETIRE-R2");
  const apresRetrait = await appeler("put", `${ENTITES[1].base}/${fR2b}`, T.national, { remarques: "y" });
  verifier("CONSTAT : retirer TOUTES les regions d'un compte le rend NATIONAL (liste vide = national, voulu mais ouvert par defaut) : il ecrit de nouveau en R2",
    retire.status === 200 && retire.body.perimetre === "NATIONAL" && ecritOk(apresRetrait), [retire.body, apresRetrait.body]);

  // ================================================================ 6. Lecture
  console.log("\n== 6. Lecture : fiche 360 refusee hors perimetre, portee du tableau de bord, constat sur les listes v1 ==");
  const f360Hors = await appeler("get", `/api/v2/fiche-360/troncons/${T2}/portions`, T.regional);
  const f360Dans = await appeler("get", `/api/v2/fiche-360/troncons/${T1}/portions`, T.regional);
  const f360Nat = await appeler("get", `/api/v2/fiche-360/troncons/${T2}/portions`, T.national);
  const f360Inconnu = await appeler("get", `/api/v2/fiche-360/troncons/${randomUUID()}/portions`, T.regional);
  verifier("lecture : fiche 360 d'un troncon de R2 refusee au compte regional (403 HORS_PERIMETRE) ; de R1 : 200 ; le national lit R2 : 200 ; troncon inconnu : 404",
    refus(f360Hors, "HORS_PERIMETRE") && f360Dans.status === 200 && f360Nat.status === 200 && f360Inconnu.status === 404, [f360Hors.status, f360Dans.status, f360Nat.status, f360Inconnu.status]);

  const tdbReg = await appeler("get", "/api/v2/tableau-de-bord/indicateurs?groupes=reseau", T.regional);
  const tdbBi = await appeler("get", "/api/v2/tableau-de-bord/indicateurs?groupes=reseau", T.bi);
  const tdbNat = await appeler("get", "/api/v2/tableau-de-bord/indicateurs?groupes=reseau", T.admin);
  const idsRegions = (r: { body: { portee?: { regions?: { id: number }[] } } }) => (r.body.portee?.regions ?? []).map((x) => x.id).sort((a, b) => a - b);
  verifier("lecture : la portee du tableau de bord vient du COMPTE : regional = {R1}, deux regions = {R1, R2}, ADMIN = national (le detail des valeurs est eprouve par le banc tableau-de-bord)",
    tdbReg.status === 200 && tdbReg.body.portee.national === false && idsRegions(tdbReg).join() === [R1].join()
    && idsRegions(tdbBi).join() === [R1, R2].sort((a, b) => a - b).join() && tdbNat.body.portee.national === true, [tdbReg.body.portee, tdbBi.body.portee, tdbNat.body.portee]);

  const listeV1 = await appeler("get", "/api/troncons?pageSize=200", T.regional);
  const codes = (listeV1.body.data ?? []).map((t: { code: string }) => t.code);
  verifier("CONSTAT (comportement actuel, pas une exigence) : la liste v1 des troncons n'est PAS filtree par perimetre, le compte regional y voit un troncon de R2 (lecture ouverte, voir troncons.routes.ts)",
    listeV1.status === 200 && codes.includes("TERR-T2") && codes.includes("TERR-T1"), codes.slice(0, 5));

  // ================================================================ 7. Contre-epreuve : sans perimetre, le meme compte ecrit partout
  console.log("\n== 7. Contre-epreuve ==");
  const AVANT = "TERR-CONTRE-EPREUVE";
  const avecPerimetre = await appeler("post", "/api/troncons", T.regional, ENTITES[0].corps(R2, `${AVANT}-1`));
  await sql(`DELETE FROM perimetres_comptes WHERE "userId" = $1`, regional.id);
  const sansPerimetre = await appeler("post", "/api/troncons", T.regional, ENTITES[0].corps(R2, `${AVANT}-2`));
  verifier("CONTRE-EPREUVE : le MEME compte, le MEME jeton, la MEME requete : refusee avec son perimetre (403), acceptee des qu'il n'a plus de ligne (201). C'est bien le perimetre en base qui decide",
    refus(avecPerimetre) && sansPerimetre.status === 201 && await ENTITES[0].marque(`${AVANT}-1`) === 0 && await ENTITES[0].marque(`${AVANT}-2`) === 1, [avecPerimetre.status, sansPerimetre.status]);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { conclure(); await prisma.$disconnect(); await banc.fermer(); });
