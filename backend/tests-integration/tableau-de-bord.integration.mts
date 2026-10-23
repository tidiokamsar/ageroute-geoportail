// Banc d'integration du tableau de bord et de la Control Tower (A12) : voir tests-integration/README.md.
// Lancer (DATABASE_URL pointe sur `replay`) : npx tsx tests-integration/tableau-de-bord.integration.mts
//
// Pour CHAQUE indicateur du registre, et pour trois portees (national, region 1, region 2), le banc exige :
//     calcul  =  requete de controle  =  valeur attendue CALCULEE A LA MAIN dans ce fichier.
// Les services committent et se voient entre eux (main courante, escalades, teledetection) : le banc
// travaille dans un CLONE jetable de `replay`, cree puis detruit par lui-meme (essai_tableau_de_bord).
import { pathToFileURL } from "node:url";
import { evaluerCible } from "./lib/garde.ts";
import { creerClone, supprimerClone, urlClone } from "./lib/clone.ts";
import { verifier, conclure } from "./lib/verdict.ts";

const ORIGINE = process.env.DATABASE_URL;
const cible = evaluerCible(ORIGINE);
if (!cible.ok || cible.base !== "replay") {
  console.error("Banc d'integration refuse : DATABASE_URL doit etre une base locale nommee replay (le clone est cree par le banc).");
  process.exit(3);
}
const NOM_CLONE = "essai_tableau_de_bord";
await creerClone(ORIGINE!, NOM_CLONE);
process.env.DATABASE_URL = urlClone(ORIGINE!, NOM_CLONE);
console.log("Cible du banc : clone jetable " + NOM_CLONE);

const R = new URL("../src/", pathToFileURL(process.argv[1]).href).href;
const imp = (p: string) => import(R + p + ".ts");
const { prisma } = await imp("lib/prisma");
const { REGISTRE } = await imp("tableau-de-bord/indicateurs.registre");
const { evaluer, controler } = await imp("tableau-de-bord/tableau-de-bord.service");
const { controlTower } = await imp("tableau-de-bord/control-tower.service");
const { valeursEgales, defautsRegistre } = await imp("tableau-de-bord/indicateurs.noyau");
const { voletPortions, voletProgrammation } = await imp("tableau-de-bord/fiche360.service");
const { longueurReseau } = await imp("lib/reseau");
const { couvertureReseau } = await imp("reseau/couverture.reseau");
const { declarer, ajouterEntree } = await imp("exploitation/main-courante.service");
const { creerRegle, creerAstreinte, evaluerEscalades } = await imp("exploitation/veille.service");
const { enregistrerProduit, deposerPropositions, poserVerdict } = await imp("teledetection/teledetection.service");

const sql = (q: string, ...a: unknown[]) => prisma.$executeRawUnsafe(q, ...a);

/** Longueur d'un arc de meridien WGS84 entre deux latitudes (degres), en metres : integrale de Simpson du rayon de courbure meridien. */
function arcMeridien(phi1: number, phi2: number): number {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f);
  const M = (deg: number) => { const s = Math.sin((deg * Math.PI) / 180); return (a * (1 - e2)) / Math.pow(1 - e2 * s * s, 1.5); };
  const n = 2000, h = ((phi2 - phi1) * Math.PI) / 180 / n;
  let somme = M(phi1) + M(phi2);
  for (let i = 1; i < n; i++) somme += M(phi1 + (i * (phi2 - phi1)) / n) * (i % 2 ? 4 : 2);
  return (somme * h) / 3;
}
const ligne = (lon: number, lat1: number, lat2: number) => `ST_SetSRID(ST_MakeLine(ST_MakePoint(${lon}, ${lat1}), ST_MakePoint(${lon}, ${lat2})), 4326)`;
const arrondi = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

// Longueurs geodesiques des quatre troncons dotes d'une vraie geometrie, calculees HORS de PostGIS.
const L1 = arcMeridien(9.00, 9.01), L2 = arcMeridien(9.10, 9.12), L6 = arcMeridien(10.00, 10.03), L8 = arcMeridien(10.10, 10.11);

const NOW = new Date("2026-10-22T10:00:00Z");
const NOW2 = new Date("2027-01-15T10:00:00Z");

try {
  // ============================================================================ fixtures
  await sql(`INSERT INTO regions (nom) VALUES ('Region TB1'), ('Region TB2'), ('Region TB3 vide')`);
  const idRegion = async (nom: string) => Number((await prisma.$queryRawUnsafe(`SELECT id FROM regions WHERE nom='${nom}'`) as { id: number }[])[0].id);
  const [r1, r2, r3] = [await idRegion("Region TB1"), await idRegion("Region TB2"), await idRegion("Region TB3 vide")];
  await sql(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES
    ('u-tb','tb@x.invalid','Auteur','x','GESTIONNAIRE',now()), ('u-a1','a1@x.invalid','Astreinte 1','x','LECTEUR',now()), ('u-a2','a2@x.invalid','Astreinte 2','x','LECTEUR',now())`);

  const troncon = (id: string, region: number, geom: string, km: number, etat: string, source: string | null, supprime = false) => sql(
    `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", geom, "sourceReference", "deletedAt", "updatedAt")
     VALUES ($1, $1, $1, 'RN', $2, $3, 'BITUME', $4::"EtatPatrimoine", 0, 1, ${geom}, $5, ${supprime ? "now()" : "NULL"}, now())`, id, region, km, etat, source);
  await troncon("tb-1", r1, ligne(-13.0, 9.00, 9.01), 1.2, "MAUVAIS", null);
  await troncon("tb-2", r1, ligne(-13.0, 9.10, 9.12), 2.5, "CRITIQUE", "import:x");
  await troncon("tb-3", r1, `ST_GeomFromText('LINESTRING(-13.2 9.3, -13.2 9.3)', 4326)`, 0.5, "BON", null);                  // geometrie invalide
  await troncon("tb-4", r1, `ST_GeomFromText('LINESTRING(-13.3 9.2, -13.3 9.2)', 4326)`, 3, "MAUVAIS", "voirie_locale:abc");  // hors reseau classe
  await troncon("tb-5", r1, ligne(-13.4, 9.30, 9.31), 9, "MAUVAIS", null, true);                                              // supprime
  await troncon("tb-6", r2, ligne(-12.0, 10.00, 10.03), 3.4, "BON", null);
  await troncon("tb-7", r2, `ST_GeomFromText('LINESTRING(-12.5 10.5, -12.5 10.5)', 4326)`, 8, "CRITIQUE", "hors_territoire:x");  // hors reseau classe
  await troncon("tb-8", r2, ligne(-12.0, 10.10, 10.11), 0, "NON_EVALUE", null);

  await sql(`INSERT INTO valeurs_qualite (id, "entityType", "entityId", champ, statut, "updatedAt") VALUES
    ('vq1','Troncon','tb-1','etat','OBSERVED',now()), ('vq2','Troncon','tb-1','revetement','IMPORTED_UNVERIFIED',now()),
    ('vq3','Troncon','tb-2','longueurKm','DERIVED',now()), ('vq4','Troncon','tb-6','etat','IMPORTED_UNVERIFIED',now()),
    ('vq5','Ouvrage','o-1','etat','UNKNOWN',now()), ('vq6','Troncon','tb-8','etat','OBSERVED',now())`);

  const ouvrage = (id: string, region: number, etat: string, source: string | null, supprime = false) => sql(
    `INSERT INTO ouvrages (id, nom, type, etat, "regionId", "sourceReference", "deletedAt", "updatedAt")
     VALUES ($1, $1, 'PONT', $2::"EtatPatrimoine", $3, $4, ${supprime ? "now()" : "NULL"}, now())`, id, etat, region, source);
  await ouvrage("o-1", r1, "CRITIQUE", null);
  await ouvrage("o-2", r1, "MAUVAIS", "ouvrage_osm:1");   // franchissement repris : hors inventaire
  await ouvrage("o-3", r2, "BON", null);
  await ouvrage("o-4", r2, "CRITIQUE", null, true);

  const pn = (id: string, region: number, supprime = false) => sql(
    `INSERT INTO points_noirs (id, description, "regionId", gravite, "deletedAt", "updatedAt") VALUES ($1, $1, $2, 'FORTE', ${supprime ? "now()" : "NULL"}, now())`, id, region);
  await pn("pn-1", r1); await pn("pn-2", r1); await pn("pn-3", r1, true); await pn("pn-4", r2);
  const poste = (id: string, region: number) => sql(`INSERT INTO postes (id, nom, type, "regionId", "updatedAt") VALUES ($1, $1, 'PEAGE', $2, now())`, id, region);
  await poste("po-1", r1); await poste("po-2", r2); await poste("po-3", r2);
  await sql(`INSERT INTO documents (id, titre, type, "fileName", "filePath", "mimeType", "sizeBytes", "deletedAt", "updatedAt") VALUES
    ('d-1','d1','ARRETE','a.pdf','/x/a.pdf','application/pdf',1,NULL,now()), ('d-2','d2','AUTRE','b.pdf','/x/b.pdf','application/pdf',1,NULL,now()),
    ('d-3','d3','AUTRE','c.pdf','/x/c.pdf','application/pdf',1,now(),now())`);

  const chantier = (id: string, region: number, statut: string, fin: string | null, montant: number | null, supprime = false) => sql(
    `INSERT INTO chantiers (id, intitule, entreprise, "regionId", statut, "dateFinPrevue", "montantGnf", "deletedAt", "updatedAt")
     VALUES ($1, $1, 'Entreprise', $2, $3::"StatutChantier", $4::timestamp, $5, ${supprime ? "now()" : "NULL"}, now())`, id, region, statut, fin, montant);
  await chantier("c-1", r1, "EN_COURS", "2026-10-01T00:00:00", 1_000_000);
  await chantier("c-2", r1, "EN_COURS", "2026-11-30T00:00:00", 2_000_000);
  await chantier("c-3", r2, "EN_COURS", "2026-10-22T09:00:00", 3_000_000);
  await chantier("c-4", r2, "PLANIFIE", "2025-01-01T00:00:00", 4_000_000);
  await chantier("c-5", r2, "EN_COURS", null, null);
  await chantier("c-6", r1, "TERMINE", null, 5_000_000);
  await chantier("c-7", r1, "EN_COURS", "2026-01-01T00:00:00", 99, true);

  const portion = (id: string, tronc: string, d: number, f: number, statut: string, o: { remplacee?: boolean; supprimee?: boolean } = {}) => sql(
    `INSERT INTO portions (id, "tronconId", "debutM", "finM", "statutValidation", origine, "remplaceeLe", "deletedAt", "creeParId", "updatedAt")
     VALUES ($1, $2, $3, $4, $5::"StatutValidation", 'SAISIE_TERRAIN', ${o.remplacee ? "now()" : "NULL"}, ${o.supprimee ? "now()" : "NULL"}, 'u-tb', now())`, id, tronc, d, f, statut);
  await portion("p-1", "tb-1", 0, 400, "VALIDE");
  await portion("p-2", "tb-1", 400, 700, "VALIDE");
  await portion("p-3", "tb-1", 600, 900, "A_VALIDER");                       // chevauche p-2 de 100 m
  await portion("p-4", "tb-1", 0, 400, "VALIDE", { remplacee: true });        // version remplacee : ecartee
  await portion("p-5", "tb-1", 800, 1000, "REJETE");                          // courante : chevauche p-3 de 100 m
  await portion("p-6", "tb-1", 900, 1100, "VALIDE", { supprimee: true });     // supprimee : ecartee
  await portion("p-7", "tb-2", 0, 1000, "VALIDE");
  await portion("p-8", "tb-2", 1000, 1500, "VALIDE");
  await portion("p-9", "tb-2", 1500, 1600, "A_CORRIGER");
  await portion("p-10", "tb-6", 0, 2000, "VALIDE");
  await portion("p-11", "tb-6", 1900, 2500, "A_VALIDER");                     // chevauche p-10 de 100 m

  // Programmes budgetaires : un montant au-dela de 2^53 pour prouver qu'il ne passe jamais par un nombre.
  const prevision = (id: string, tronc: string | null, statut: string, montant: string, supprime = false) => sql(
    `INSERT INTO programmes_budgetaires (id, annee, intitule, "tronconId", "montantPrevuGnf", statut, "createdById", "deletedAt")
     VALUES ($1::uuid, 2027, $1, $2, $3::bigint, $4, 'u-tb', ${supprime ? "now()" : "NULL"})`, id, tronc, montant, statut);
  const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  await prevision(u(1), "tb-1", "RETENU", "9007199254740993");
  await prevision(u(2), "tb-2", "RETENU", "500");
  await prevision(u(3), "tb-6", "RETENU", "250");
  await prevision(u(4), "tb-6", "REALISE", "125");
  await prevision(u(5), "tb-1", "REALISE", "75");
  await prevision(u(6), null, "RETENU", "1000");
  await prevision(u(7), "tb-1", "PROPOSE", "40");
  await prevision(u(8), "tb-1", "RETENU", "10", true);

  // Programmes de patrouille : un par cas d'echeance.
  const programme = (code: string, region: number | null, per: number, mois: number[], actif = true, supprime = false) => sql(
    `INSERT INTO programmes_patrouille (id, code, libelle, "regionId", "periodiciteJours", "moisActifs", "responsableId", "creeParId", actif, "deletedAt", "updatedAt")
     VALUES ($1, $1, $1, $2, $3, $4::int[], 'u-tb', 'u-tb', $5, ${supprime ? "now()" : "NULL"}, now())`, code, region, per, `{${mois.join(",")}}`, actif);
  const mission = (code: string, prog: string, statut: string, fin: string | null) => sql(
    `INSERT INTO missions (id, code, intitule, type, statut, "createurId", "finReelle", "programmeId", "updatedAt")
     VALUES ($1, $1, $1, 'SURVEILLANCE', $2::"StatutMission", 'u-tb', $3::timestamp, $4, now())`, code, statut, fin, prog);
  await programme("PA", r1, 7, []);                       await mission("m-pa", "PA", "TERMINEE", "2026-10-10T08:00:00");
  await mission("m-pa-x", "PA", "ANNULEE", "2026-10-21T08:00:00");   // une mission annulee n'est pas un passage realise
  await programme("PB", r1, 30, []);                      await mission("m-pb", "PB", "TERMINEE", "2026-10-10T08:00:00");
  await programme("PC", r2, 7, []);                       // jamais realise
  await programme("PD", r2, 7, [6, 7, 8, 9, 10]);         await mission("m-pd", "PD", "SYNC_EN_ATTENTE", "2026-09-01T08:00:00");
  await programme("PE", r2, 7, [11, 12, 1, 2]);           await mission("m-pe", "PE", "TERMINEE", "2026-01-05T08:00:00");
  await programme("PF", null, 7, []);                     await mission("m-pf", "PF", "TERMINEE", "2026-10-01T08:00:00");
  await programme("PG", r1, 7, [], false);                await mission("m-pg", "PG", "TERMINEE", "2026-01-01T08:00:00");
  await programme("PH", r1, 7, [], true, true);           await mission("m-ph", "PH", "TERMINEE", "2026-01-01T08:00:00");
  await programme("PI", r1, 7, [10, 11, 12, 1, 2]);       await mission("m-pi", "PI", "TERMINEE", "2026-03-01T08:00:00");

  // Main courante, regles, astreintes, escalades : par les services, donc par leurs vraies regles.
  const ctx = { auteurId: "u-tb" };
  const decl = (d: Record<string, unknown>) => declarer(prisma, { typeCode: "COUPURE", sourceCode: "PATROUILLE", texte: "evenement de banc", ...d }, ctx);
  await decl({ tronconId: "tb-1" });                                                               // E1 R1 ouvert
  const e2 = await decl({ tronconId: "tb-1" });  await ajouterEntree(prisma, e2.evenementId, { nature: "STATUT", statut: "PRIS_EN_COMPTE", texte: "vu" }, ctx);   // E2 R1 pris en compte
  await decl({ tronconId: "tb-6" });                                                               // E3 R2 ouvert
  const e4 = await decl({ tronconId: "tb-6" });  await ajouterEntree(prisma, e4.evenementId, { nature: "STATUT", statut: "CLOS", texte: "clos" }, ctx);            // E4 R2 clos
  await decl({ point: [-13.5, 9.6] });                                                             // E5 sans troncon : region inconnue
  await creerRegle(prisma, { typeCode: null, mode: "TOUS", niveau: 1, delaiMinutes: 30 }, ctx);
  await creerRegle(prisma, { typeCode: null, mode: "TOUS", niveau: 2, delaiMinutes: 90 }, ctx);
  const debut = new Date(Date.now() - 3_600_000), fin = new Date(Date.now() + 8 * 3_600_000);
  await creerAstreinte(prisma, { userId: "u-a1", niveau: 1, regionId: r1, debut, fin }, ctx);
  await creerAstreinte(prisma, { userId: "u-a2", niveau: 2, regionId: r1, debut, fin }, ctx);
  const evalEsc = await evaluerEscalades(prisma, ctx, new Date(Date.now() + 2 * 3_600_000));
  verifier("fixtures : 6 escalades inscrites (3 evenements ouverts x 2 niveaux)", evalEsc.inscrites.length === 6, evalEsc.inscrites.length);

  // Teledetection : un produit, quatre propositions (3 rattachees a un troncon, 1 loin), deux verdicts.
  const produit = await enregistrerProduit(prisma, {
    code: "TB-S1", palier: 0, source: "Sentinel-1 GRD", nature: "RADAR", dateAcquisition: new Date("2026-10-02"), resolutionM: 10,
    incertitude: "chatoiement", provenance: "scene-banc", licence: "relevee a la source", versionTraitement: "v0",
    emprise: { type: "Polygon", coordinates: [[[-14, 8], [-11, 8], [-11, 11], [-14, 11], [-14, 8]]] },
  }, ctx);
  const dep = await deposerPropositions(prisma, {
    produitId: produit.id, methode: "banc v0", toleranceRattachementM: 50,
    propositions: [
      { type: "INONDATION", geometrie: { type: "Point", coordinates: [-13.0, 9.005] } },     // sur tb-1
      { type: "INONDATION", geometrie: { type: "Point", coordinates: [-13.0, 9.0051] } },    // sur tb-1
      { type: "INONDATION", geometrie: { type: "Point", coordinates: [-12.0, 10.01] } },     // sur tb-6
      { type: "INONDATION", geometrie: { type: "Point", coordinates: [-12.5, 9.5] } },       // non rattachee
    ],
  }, ctx);
  verifier("fixtures : 3 propositions rattachees, 1 non rattachee", dep.rattachees === 3 && dep.nonRattachees === 1, dep);
  await poserVerdict(prisma, dep.ids[0], { statut: "CONFIRMEE", motif: "eau", constatRef: "m:1" }, ctx);
  await poserVerdict(prisma, dep.ids[2], { statut: "INFIRMEE", motif: "sec", constatRef: "m:2" }, ctx);

  // ============================================================================ attendus calcules a la main
  const km = (m: number) => arrondi(m / 1000, 2);
  const ATTENDU: Record<string, { national: unknown; r1: unknown; r2: unknown }> = {
    troncons_classes: { national: 5, r1: 3, r2: 2 },
    longueur_geometrique_km: { national: km(L1 + L2 + L6 + L8), r1: km(L1 + L2), r2: km(L6 + L8) },
    longueur_metier_km: { national: 5.1, r1: 1.7, r2: 3.4 },           // tb-2 est DERIVED : sa longueur n'est pas saisie
    troncons_mauvais_critique: { national: 2, r1: 2, r2: 0 },
    ouvrages_inventories: { national: 2, r1: 1, r2: 1 },
    ouvrages_mauvais_critique: { national: 1, r1: 1, r2: 0 },
    points_noirs: { national: 3, r1: 2, r2: 1 },
    postes: { national: 3, r1: 1, r2: 2 },
    documents: { national: 2, r1: "INDISPONIBLE", r2: "INDISPONIBLE" },
    chantiers_en_cours: { national: 4, r1: 2, r2: 2 },
    portions_validees: { national: 5, r1: 4, r2: 1 },
    portions_validees_km: { national: 4.2, r1: 2.2, r2: 2.0 },
    couverture_qualifiee_part: {
      national: arrondi(5100 / (L1 + L2 + L6 + L8), 4), r1: arrondi(2600 / (L1 + L2), 4), r2: arrondi(2500 / (L6 + L8), 4),
    },
    portions_chevauchantes: { national: 3, r1: 2, r2: 1 },
    troncons_geometrie_invalide: { national: 1, r1: 1, r2: 0 },
    valeurs_qualifiees: { national: 6, r1: "INDISPONIBLE", r2: "INDISPONIBLE" },
    valeurs_observees: { national: 2, r1: "INDISPONIBLE", r2: "INDISPONIBLE" },
    evenements_actifs: { national: 4, r1: 2, r2: 1 },                   // E1 E2 E3 E5 ; E4 est clos
    evenements_non_pris_en_compte: { national: 3, r1: 1, r2: 1 },       // E1 E3 E5
    evenements_escalades: { national: 3, r1: 1, r2: 1 },
    trous_de_permanence: { national: 2, r1: 0, r2: 1 },                 // E3 (R2) et E5 (region inconnue) : aucun astreint au niveau 2
    regles_escalade_actives: { national: 2, r1: "INDISPONIBLE", r2: "INDISPONIBLE" },
    programmes_patrouille_actifs: { national: 7, r1: 3, r2: 3 },
    patrouilles_en_retard: { national: 4, r1: 2, r2: 1 },               // PA PD PF PI ; PD n'est en retard que par sa saison
    propositions_a_verifier: { national: 2, r1: 1, r2: 0 },
    previsions_retenues_nb: { national: 4, r1: 2, r2: 1 },
    previsions_retenues_gnf: { national: "9007199254742743", r1: "9007199254741493", r2: "250" },
    previsions_realisees_nb: { national: 2, r1: 1, r2: 1 },
    previsions_realisees_gnf: { national: "200", r1: "75", r2: "125" },
    chantiers_en_retard: { national: 2, r1: 1, r2: 1 },
    chantiers_montant_gnf: { national: "15000000", r1: "8000000", r2: "7000000" },
  };

  verifier("le registre ne declare aucun defaut (perimetre, controle independant)", defautsRegistre(REGISTRE).length === 0, defautsRegistre(REGISTRE));
  verifier("chaque indicateur du registre a une valeur attendue dans le banc (rien n'echappe a la verification)",
    REGISTRE.every((d: { code: string }) => d.code in ATTENDU) && Object.keys(ATTENDU).length === REGISTRE.length, REGISTRE.map((d: { code: string }) => d.code).filter((c: string) => !(c in ATTENDU)));

  const portees = { national: { regions: null, maintenant: NOW }, r1: { regions: [r1], maintenant: NOW }, r2: { regions: [r2], maintenant: NOW } } as const;
  for (const [nomPortee, portee] of Object.entries(portees)) {
    const evalues = await evaluer(prisma, REGISTRE, portee);
    for (const d of REGISTRE as { code: string; unite: string; regionalisable: boolean; calcul: Function; controle: Function }[]) {
      const attendu = ATTENDU[d.code][nomPortee as "national" | "r1" | "r2"];
      const e = evalues.find((x: { code: string }) => x.code === d.code);
      if (attendu === "INDISPONIBLE") {
        verifier(`${nomPortee} ${d.code} : refuse a un compte regional (aucune valeur nationale a sa place)`, e.statut === "INDISPONIBLE" && e.valeur === null, e);
        continue;
      }
      const calcul = await d.calcul(prisma, portee);
      const controle = await d.controle(prisma, portee);
      verifier(`${nomPortee} ${d.code} : calcul = controle = attendu (${JSON.stringify(attendu)})`,
        valeursEgales(calcul, controle, d.unite) && valeursEgales(calcul, attendu as never, d.unite) && e.statut === "CALCULE" && valeursEgales(e.valeur, attendu as never, d.unite),
        { calcul, controle, attendu, evalue: e.valeur });
    }
    const rapport = await controler(prisma, REGISTRE, portee);
    const regionaliseNonDispo = nomPortee === "national" ? 0 : (REGISTRE as { regionalisable: boolean }[]).filter((d) => !d.regionalisable).length;
    verifier(`${nomPortee} : le rapprochement automatique ne trouve aucun ecart, aucune erreur (${rapport.egaux} egaux, ${rapport.indisponibles} indisponibles)`,
      rapport.ecarts === 0 && rapport.erreurs === 0 && rapport.indisponibles === regionaliseNonDispo && rapport.egaux + rapport.indisponibles === REGISTRE.length, rapport.resultats.filter((r: { statut: string }) => r.statut !== "EGAL" && r.statut !== "INDISPONIBLE"));
  }

  // ---- Echeance a une autre date : saison a cheval sur deux annees (15/01/2027)
  const retard = REGISTRE.find((d: { code: string }) => d.code === "patrouilles_en_retard");
  for (const [nom, regions, attendu] of [["national", null, 5], ["R1", [r1], 3], ["R2", [r2], 1]] as const) {
    const p = { regions, maintenant: NOW2 };
    const [c, k] = [await retard.calcul(prisma, p), await retard.controle(prisma, p)];
    verifier(`patrouilles en retard au 15/01/2027 (${nom}) : calcul = controle = ${attendu} (PA PB PE PF PI ; PD hors saison)`, c === attendu && k === attendu, { c, k });
  }

  // ---- Portee vide : une region sans donnee dit « aucune donnee » et ne montre pas de zero fabrique
  const vide = await evaluer(prisma, REGISTRE, { regions: [r3], maintenant: NOW });
  const regionalisables = vide.filter((i: { statut: string }) => i.statut === "CALCULE");
  verifier("region vide : tout indicateur ventilable vaut 0 (ou rien a mesurer) ET se declare sans donnee", regionalisables.length > 0 &&
    regionalisables.every((i: { valeur: unknown; aucuneDonnee: boolean }) => (i.valeur === 0 || i.valeur === "0" || i.valeur === null) && i.aucuneDonnee), regionalisables.filter((i: { aucuneDonnee: boolean }) => !i.aucuneDonnee).map((i: { code: string }) => i.code));

  // ---- Recoupements avec les modules DEJA en service (les chiffres du tableau de bord actuel)
  const lr = await longueurReseau("reference");
  verifier("la longueur geometrique du registre = longueurReseau('reference').geometrique (module existant)", valeursEgales(lr.geometrique.totalKm, ATTENDU.longueur_geometrique_km.national as number, "km"), lr.geometrique.totalKm);
  verifier("la longueur saisie du registre = longueurReseau('reference').metier (module existant)", valeursEgales(lr.metier.totalKm, 5.1, "km"), lr.metier.totalKm);
  const cv = await couvertureReseau("reference");
  verifier("la couverture du registre = couvertureReseau('reference').total.part (module existant)", valeursEgales(cv.total.part, ATTENDU.couverture_qualifiee_part.national as number, "part"), cv.total.part);

  // ---- Contre-epreuve : le rapprochement DETECTE un desaccord (sinon un banc vert ne prouverait rien)
  const faux = REGISTRE.map((d: { code: string; calcul: Function }) => d.code === "points_noirs" ? { ...d, calcul: async (...a: unknown[]) => (await d.calcul(...a)) + 1 } : d);
  const rapportFaux = await controler(prisma, faux, portees.national);
  verifier("contre-epreuve : un calcul decale d'une unite est signale en ECART par le rapprochement", rapportFaux.ecarts === 1 && rapportFaux.resultats.find((r: { code: string }) => r.code === "points_noirs").statut === "ECART", rapportFaux.resultats.filter((r: { statut: string }) => r.statut === "ECART"));

  // ---- Control Tower
  const ct = await controlTower(prisma, REGISTRE, portees.national);
  const veilleCT = ct.modules.find((m: { code: string }) => m.code === "veille");
  verifier("Control Tower : 5 modules, la veille porte ses 5 indicateurs avec leur perimetre", ct.modules.length === 5 && veilleCT.indicateurs.length === 5 && veilleCT.indicateurs.every((i: { perimetre: { code: string } }) => !!i.perimetre.code), ct.modules.map((m: { code: string }) => m.code));
  verifier("Control Tower : aucun module n'est « sans donnee » quand les tables sont alimentees", ct.modules.every((m: { aucuneDonnee: boolean }) => !m.aucuneDonnee), ct.modules.filter((m: { aucuneDonnee: boolean }) => m.aucuneDonnee).map((m: { code: string }) => m.code));
  const ctVide = await controlTower(prisma, REGISTRE, { regions: [r3], maintenant: NOW });
  verifier("Control Tower, region vide : chaque module se declare sans donnee (hors regle d'escalade, nationale)", ctVide.modules.filter((m: { code: string }) => m.code !== "veille").every((m: { aucuneDonnee: boolean }) => m.aucuneDonnee), ctVide.modules.map((m: { code: string; aucuneDonnee: boolean }) => [m.code, m.aucuneDonnee]));

  // ---- Fiche 360
  const vp = await voletPortions(prisma, "tb-1");
  verifier("fiche 360, portions de tb-1 : 4 courantes (p-1 p-2 p-3 p-5), 1 remplacee (p-4) dans l'historique, la supprimee (p-6) ecartee",
    vp.courantes.map((v: { id: string }) => v.id).sort().join() === "p-1,p-2,p-3,p-5" && vp.comptes.remplacees === 1 && vp.historique.length === 5 && !vp.historique.some((v: { id: string }) => v.id === "p-6"), vp.comptes);
  verifier("fiche 360 : un troncon supprime est introuvable (null)", (await voletPortions(prisma, "tb-5")) === null);
  const vg = await voletProgrammation(prisma, "tb-1");
  verifier("fiche 360, programmation de tb-1 : 3 previsions (retenue, realisee, proposee), montants en chaine, supprimee ecartee",
    vg.previsions.length === 3 && vg.totaux.find((t: { statut: string }) => t.statut === "RETENU").montantGnf === "9007199254740993" && !vg.previsions.some((p: { intitule: string }) => p.intitule === u(8)), vg.totaux);
  verifier("fiche 360 : la table des fiches existe, aucune fiche n'est figee pour tb-1 : disponible, total zero, liste vide (rien n'est invente)", vg.interventionsFigees.disponible === true && vg.interventionsFigees.total === 0 && vg.interventionsFigees.fiches.length === 0, vg.interventionsFigees);
  verifier("fiche 360 : un tronçon sans prevision rend des listes vides et un total vide", (await voletProgrammation(prisma, "tb-8")).previsions.length === 0);
} finally {
  await prisma.$disconnect();
  await supprimerClone(ORIGINE!, NOM_CLONE);
}
conclure();
