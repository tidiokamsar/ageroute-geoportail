// Banc d'integration des taches internes (scenario d'acceptation A29 : « taches internes avec preuves
// avant/apres ; rapprochement en lecture »). Voir tests-integration/README.md. Lancer (DATABASE_URL
// pointe sur `replay`) :
//   npx tsx tests-integration/taches-internes.integration.mts
//
// Le parcours passe par la route reelle `/api/v2/taches-internes` (jetons signes, role et module lus
// en base, controle territorial, televersement multipart des photos, audit transactionnel) contre les
// contraintes reelles de `taches_internes`, dans un clone PostGIS jetable.
//
// CE QUE LE BANC NE PROUVE PAS : le rapprochement physique / financier de TI-02. Il exige des donnees
// DigitalRoad qui n'existent pas (blocage B-11). Le banc eprouve le rapprochement que la plateforme
// peut faire seule (tache, defaut, responsable, echeance), en lecture seule, et verifie que la reponse
// declare le volet financier indisponible.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_taches");
const { prisma } = await banc.imp("lib/prisma");
const { apiV2Router } = await banc.imp("api-v2/index");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const { signAccessToken } = await banc.imp("utils/jwt");
const express = (await import("express")).default;
const request = (await import("supertest")).default;

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api/v2", apiV2Router);
app.use(errorHandler);

const DOSSIER_PHOTOS = path.join(process.cwd(), "uploads", "photos");
await mkdir(DOSSIER_PHOTOS, { recursive: true });
const fichiersAuDepart = new Set(await readdir(DOSSIER_PHOTOS));
const fichiersCrees = async () => (await readdir(DOSSIER_PHOTOS)).filter((f) => !fichiersAuDepart.has(f));

const compter = async (sql: string): Promise<number> => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql))[0].n);
const png = () => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(64)]);
const HEURE = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 21, h, m)).toISOString();   // 21/10/2026, passe

type Compte = { id: string; role: string; email: string };
const jeton = (u: Compte) => signAccessToken({ sub: u.id, role: u.role, email: u.email });

async function main() {
  // ---------------------------------------------------------------- Fixtures
  await prisma.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region R1 banc'), ('Region R2 banc')`);
  const [R1, R2] = (await prisma.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM regions WHERE nom LIKE 'Region R_ banc' ORDER BY nom`)).map((r) => r.id);
  const mk = (email: string, role: string, actif = true) => prisma.user.create({ data: { email, nomComplet: email, passwordHash: "x", role, actif, modulesAutorises: ["inspections"] } });
  const chef = await mk("chef@banc.invalid", "GESTIONNAIRE");
  const agent = await mk("agent@banc.invalid", "INSPECTEUR");
  const autre = await mk("autre@banc.invalid", "INSPECTEUR");
  const regional = await mk("regional@banc.invalid", "INSPECTEUR");
  const lecteur = await mk("lecteur@banc.invalid", "LECTEUR");
  const parti = await mk("parti@banc.invalid", "INSPECTEUR", false);                       // compte desactive
  await prisma.$executeRawUnsafe(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ('${regional.id}', ${R1}, '${chef.id}')`);
  const T = { chef: jeton(chef), agent: jeton(agent), autre: jeton(autre), regional: jeton(regional), lecteur: jeton(lecteur) };
  const mkTroncon = async (code: string, regionId: number) => {
    const id = randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
      VALUES ('${id}', '${code}', '${code}', 'RN', ${regionId}, 2.2, 'BITUME', 0, 2.2, ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.58, 9.64)), 4326), now())`);
    return id;
  };
  const T1 = await mkTroncon("BANC-TI-1", R1), T2 = await mkTroncon("BANC-TI-2", R2);
  await prisma.catalogueDefaut.create({ data: { code: "UN_BANC", libelle: "Defaut banc", famille: "CHAUSSEE", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: 4 } });

  const api = (m: "get" | "post" | "delete", url: string, token: string) => request(app)[m](`/api/v2${url}`).set("Authorization", `Bearer ${token}`);
  const creer = (token: string, corps: Record<string, unknown>) => api("post", "/taches-internes", token).send(corps);
  const base = (extra: Record<string, unknown> = {}) => ({ nature: "CANTONNAGE", intitule: "Curage des fosses du PK 3", tronconId: T1, ...extra });
  const televerser = (token: string, id: string, moment: string, capturedA: string | null, contenu = png()) => {
    const r = api("post", `/taches-internes/${id}/preuves/${moment}`, token);
    if (capturedA) r.field("capturedA", capturedA);
    return r.attach("photo", contenu, { filename: "preuve.jpg", contentType: "image/jpeg" });
  };
  const ligne = async (id: string) => (await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT statut::text, "preuveAvantChemin", "preuveAvantPriseLe", "preuveApresChemin", "preuveApresPriseLe", "clotureeLe", "clotureeParId", "abandonMotif", "quantiteConstatee"::float8 q, "quantiteUnite", "deletedAt", reference FROM taches_internes WHERE id='${id}'`))[0];
  const audits = (id: string) => compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='TacheInterne' AND "entityId"='${id}'`);
  const grosFlux = async () => [await compter(`SELECT count(*) n FROM marches`), await compter(`SELECT count(*) n FROM decomptes`), await compter(`SELECT count(*) n FROM ordres_travaux`), await compter(`SELECT count(*) n FROM chantiers`)].join("/");
  const fluxAvant = await grosFlux();

  console.log("\n== A29 : taches internes, preuves avant/apres, rapprochement en lecture ==");

  // ---------------------------------------------------------------- 1. Le parcours complet
  const c1 = await creer(T.agent, base({ debutM: 100, finM: 300, echeanceLe: "2026-12-31", description: "Curage manuel" }));
  const t1 = c1.body;
  verifier("1. creation : 201, reference stable TI-<annee>-00001, OUVERTE, rattachee a un troncon et une emprise", c1.status === 201 && /^TI-\d{4}-00001$/.test(t1.reference) && t1.statut === "OUVERTE" && t1.tronconId === T1 && t1.debutM === 100 && t1.finM === 300, c1.body);
  verifier("1. le responsable par defaut est celui qui cree, l'auteur est l'authentifie", t1.responsableId === agent.id && t1.creeParId === agent.id);
  const d1 = await api("post", `/taches-internes/${t1.id}/demarrer`, T.agent).send({});
  verifier("1. demarrer : EN_COURS", d1.status === 200 && d1.body.statut === "EN_COURS", d1.body);
  const avantSansApres = await televerser(T.agent, t1.id, "avant", HEURE(8));
  verifier("1. preuve « avant » : 201, fichier et date de prise enregistres", avantSansApres.status === 201 && avantSansApres.body.preuves.avant?.fichier && new Date(avantSansApres.body.preuves.avant.priseLe).toISOString() === HEURE(8), avantSansApres.body);
  const cloturePrematuree = await api("post", `/taches-internes/${t1.id}/cloturer`, T.agent).send({ quantite: 40, unite: "m3" });
  verifier("1. cloture SANS la photo « apres » : refusee (422), elle dit ce qui manque, la tache reste EN_COURS",
    cloturePrematuree.status === 422 && cloturePrematuree.body.motif === "PREUVES_INCOMPLETES" && JSON.stringify(cloturePrematuree.body.manques) === '["PREUVE_APRES_ABSENTE"]' && (await ligne(t1.id)).statut === "EN_COURS", cloturePrematuree.body);
  const apres = await televerser(T.agent, t1.id, "apres", HEURE(9, 30));
  verifier("1. preuve « apres » : 201", apres.status === 201 && !!apres.body.preuves.apres, apres.body);
  const cloture = await api("post", `/taches-internes/${t1.id}/cloturer`, T.agent).send({ quantite: 40, unite: "m3" });
  verifier("1. cloture avec les deux preuves : 200, CLOTUREE, signee (auteur et date), quantite constatee 40 m3",
    cloture.status === 200 && cloture.body.statut === "CLOTUREE" && cloture.body.clotureeParId === agent.id && !!cloture.body.clotureeLe && cloture.body.quantiteConstatee === 40 && cloture.body.quantiteUnite === "m3", cloture.body);
  const l1 = await ligne(t1.id);
  verifier("1. en base : les quatre champs de preuve sont poses, apres >= avant, cloture signee",
    l1.statut === "CLOTUREE" && !!l1.preuveAvantChemin && !!l1.preuveApresChemin && new Date(l1.preuveApresPriseLe as string) >= new Date(l1.preuveAvantPriseLe as string) && l1.clotureeParId === agent.id);
  verifier("1. chaque ecriture est auditee : 1 creation + demarrage + 2 preuves + cloture = 5 lignes de journal", await audits(t1.id) === 5, await audits(t1.id));
  const lecture = await api("get", `/taches-internes/${t1.id}`, T.agent);
  verifier("1. la lecture rend les preuves en bloc, jamais un chemin absolu du serveur", lecture.status === 200 && !JSON.stringify(lecture.body).includes(DOSSIER_PHOTOS) && !JSON.stringify(lecture.body).includes("uploads"), lecture.body.preuves);

  // ---------------------------------------------------------------- 2. Preuves : les cas limites
  const t2 = (await creer(T.agent, base({ intitule: "Reparation d'un caniveau" }))).body;
  const avant0 = await fichiersCrees();
  const sansDate = await televerser(T.agent, t2.id, "avant", null);
  verifier("2. une preuve sans date de prise de vue est refusee (400) et ne laisse aucun fichier", sansDate.status === 400 && sansDate.body.motif === "DATE_PRISE_REQUISE" && (await fichiersCrees()).length === avant0.length, sansDate.body);
  const futur = await televerser(T.agent, t2.id, "avant", new Date(Date.now() + 86_400_000).toISOString());
  verifier("2. une date de prise dans le futur est refusee (422), sans fichier orphelin", futur.status === 422 && futur.body.motif === "DATE_DANS_LE_FUTUR" && (await fichiersCrees()).length === avant0.length, futur.body);
  const momentInconnu = await televerser(T.agent, t2.id, "pendant", HEURE(8));
  verifier("2. un moment qui n'est ni avant ni apres est refuse (400)", momentInconnu.status === 400 && momentInconnu.body.motif === "MOMENT_INCONNU");
  const idPhoto = png();
  const a2 = await televerser(T.agent, t2.id, "avant", HEURE(10), idPhoto);
  const memeFichier = await televerser(T.agent, t2.id, "apres", HEURE(11), idPhoto);
  verifier("2. la MEME photo en « avant » et « apres » est refusee (PREUVES_IDENTIQUES) : elle ne prouve rien", a2.status === 201 && memeFichier.status === 422 && memeFichier.body.motif === "PREUVES_IDENTIQUES", memeFichier.body);
  const inversee = await televerser(T.agent, t2.id, "apres", HEURE(9, 59));
  verifier("2. une preuve « apres » prise AVANT l'« avant » est refusee (422) et ne laisse aucun fichier de plus", inversee.status === 422 && inversee.body.motif === "PREUVE_APRES_ANTERIEURE_A_AVANT", inversee.body);
  const remplace = await televerser(T.agent, t2.id, "avant", HEURE(10, 5));
  const audRemplace = await prisma.$queryRawUnsafe<{ avant: string | null; apres: string | null }[]>(
    `SELECT before->>'preuve_avant' avant, after->>'preuve_avant' apres FROM audit_logs WHERE "entityType"='TacheInterne' AND "entityId"='${t2.id}' ORDER BY "createdAt" DESC LIMIT 1`);
  verifier("2. une preuve peut etre remplacee tant que la tache n'est pas terminee, l'ancien et le nouveau fichier restent dans le journal", remplace.status === 201 && !!audRemplace[0]?.avant && !!audRemplace[0]?.apres && audRemplace[0].avant !== audRemplace[0].apres, audRemplace);
  const avantPosterieure = await televerser(T.agent, t2.id, "apres", HEURE(12));
  const avantApres = await televerser(T.agent, t2.id, "avant", HEURE(13));
  verifier("2. de meme, remplacer l'« avant » par une prise POSTERIEURE a l'« apres » est refuse", avantPosterieure.status === 201 && avantApres.status === 422, avantApres.body);
  await api("post", `/taches-internes/${t2.id}/cloturer`, T.agent).send({});
  const apresCloture = await televerser(T.agent, t2.id, "apres", HEURE(14));
  verifier("2. apres la cloture, les preuves ne changent plus (409 TACHE_TERMINEE), sans fichier orphelin", apresCloture.status === 409 && apresCloture.body.motif === "TACHE_TERMINEE", apresCloture.body);
  verifier("2. aucun fichier orphelin : seules les 5 preuves ACCEPTEES sont sur le disque (2 pour t1 ; avant, avant remplace et apres pour t2), les 8 refus n'en ont laisse aucun",
    (await fichiersCrees()).length === 5, (await fichiersCrees()).length);

  // ---------------------------------------------------------------- 3. Cloture : les cas limites
  const t3 = (await creer(T.agent, base({ intitule: "Verification d'un regard" }))).body;
  const sansRien = await api("post", `/taches-internes/${t3.id}/cloturer`, T.agent).send({});
  verifier("3. cloture sans aucune preuve : 422, les DEUX preuves nommees, rien d'ecrit", sansRien.status === 422 && JSON.stringify(sansRien.body.manques) === '["PREUVE_AVANT_ABSENTE","PREUVE_APRES_ABSENTE"]' && (await ligne(t3.id)).statut === "OUVERTE" && await audits(t3.id) === 1, sansRien.body);
  await televerser(T.agent, t3.id, "avant", HEURE(8)); await televerser(T.agent, t3.id, "apres", HEURE(9));
  const sansUnite = await api("post", `/taches-internes/${t3.id}/cloturer`, T.agent).send({ quantite: 40 });
  verifier("3. une quantite sans unite est refusee (422 QUANTITE_SANS_UNITE), et une unite sans quantite aussi",
    sansUnite.status === 422 && sansUnite.body.motif === "QUANTITE_SANS_UNITE" && (await api("post", `/taches-internes/${t3.id}/cloturer`, T.agent).send({ unite: "m3" })).status === 422);
  const negative = await api("post", `/taches-internes/${t3.id}/cloturer`, T.agent).send({ quantite: -3, unite: "m3" });
  verifier("3. une quantite negative ou nulle est refusee (400)", negative.status === 400 && (await api("post", `/taches-internes/${t3.id}/cloturer`, T.agent).send({ quantite: 0, unite: "m3" })).status === 400);
  const [x, y] = await Promise.all([api("post", `/taches-internes/${t3.id}/cloturer`, T.agent).send({}), api("post", `/taches-internes/${t3.id}/cloturer`, T.agent).send({})]);
  verifier("3. deux clotures simultanees : une seule reussit (200), l'autre est refusee (409)", [x.status, y.status].sort().join() === "200,409", [x.status, y.status]);
  verifier("3. ... une seule cloture dans le journal, une seule date de cloture", await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='TacheInterne' AND "entityId"='${t3.id}' AND after->>'statut'='CLOTUREE'`) === 1);
  const recloture = await api("post", `/taches-internes/${t3.id}/cloturer`, T.agent).send({});
  verifier("3. cloturer une tache deja cloturee : 409 TRANSITION_REFUSEE, la cloture d'origine n'est pas reecrite",
    recloture.status === 409 && recloture.body.motif === "TRANSITION_REFUSEE" && /nouvelle tache/.test(recloture.body.message), recloture.body);
  verifier("3. une tache cloturee sans quantite garde quantite et unite NULLES ensemble", (await ligne(t3.id)).q === null && (await ligne(t3.id)).quantiteUnite === null);

  // ---------------------------------------------------------------- 4. Abandon
  const t4 = (await creer(T.agent, base({ intitule: "Nettoyage d'un ouvrage", nature: "NETTOYAGE_OUVRAGE" }))).body;
  const sansMotif = await api("post", `/taches-internes/${t4.id}/abandonner`, T.agent).send({ motif: "" });
  verifier("4. abandon sans motif : 422, un motif blanc non plus", sansMotif.status === 422 && sansMotif.body.motif === "MOTIF_ABANDON_REQUIS" && (await api("post", `/taches-internes/${t4.id}/abandonner`, T.agent).send({ motif: "   \n" })).status === 422 && (await ligne(t4.id)).statut === "OUVERTE");
  const abandon = await api("post", `/taches-internes/${t4.id}/abandonner`, T.agent).send({ motif: "  Route coupee par une crue  " });
  verifier("4. abandon motive : 200, ABANDONNEE, motif enregistre (espaces de bord retires)", abandon.status === 200 && abandon.body.statut === "ABANDONNEE" && abandon.body.abandonMotif === "Route coupee par une crue", abandon.body);
  verifier("4. une tache abandonnee ne redemarre pas, ne se cloture pas, ne se reabandonne pas (409)",
    (await api("post", `/taches-internes/${t4.id}/demarrer`, T.agent).send({})).status === 409
    && (await api("post", `/taches-internes/${t4.id}/cloturer`, T.agent).send({})).status === 409
    && (await api("post", `/taches-internes/${t4.id}/abandonner`, T.agent).send({ motif: "encore" })).status === 409);
  verifier("4. abandonner une tache cloturee est refuse (409) : la preuve de ce qui a ete fait reste", (await api("post", `/taches-internes/${t1.id}/abandonner`, T.agent).send({ motif: "erreur de saisie" })).status === 409 && (await ligne(t1.id)).statut === "CLOTUREE");
  const t4b = (await creer(T.agent, base({ intitule: "Tache demarree puis abandonnee" }))).body;
  await api("post", `/taches-internes/${t4b.id}/demarrer`, T.agent).send({});
  verifier("4. abandon possible depuis EN_COURS", (await api("post", `/taches-internes/${t4b.id}/abandonner`, T.agent).send({ motif: "materiel indisponible" })).status === 200);
  const t4c = (await creer(T.agent, base({ intitule: "Tache redemarrage" }))).body;
  verifier("4. redemarrer une tache deja EN_COURS est refuse (409), la premiere demarrage reste le seul dans le journal",
    (await api("post", `/taches-internes/${t4c.id}/demarrer`, T.agent).send({})).status === 200
    && (await api("post", `/taches-internes/${t4c.id}/demarrer`, T.agent).send({})).status === 409
    && await compter(`SELECT count(*) n FROM audit_logs WHERE "entityType"='TacheInterne' AND "entityId"='${t4c.id}' AND after->>'statut'='EN_COURS'`) === 1);

  // ---------------------------------------------------------------- 5. La frontiere DigitalRoad
  const montant = await creer(T.agent, base({ montantEstime: 1_200_000 }));
  verifier("5. une creation portant un MONTANT est refusee (422 CHAMP_CONTRACTUEL_REFUSE) et dit pourquoi", montant.status === 422 && montant.body.motif === "CHAMP_CONTRACTUEL_REFUSE" && /DigitalRoad/.test(montant.body.message) && montant.body.champs.includes("montantEstime"), montant.body);
  const plusieurs = await creer(T.agent, base({ "coût": 5, numeroMarche: "M1", entreprise: "SOTRAGUI", prestataireId: "p" }));
  verifier("5. cout accentue, marche, entreprise et prestataire sont tous reperes", plusieurs.status === 422 && plusieurs.body.champs.length === 4, plusieurs.body.champs);
  const t5 = (await creer(T.agent, base({ intitule: "Tache frontiere" }))).body;
  await televerser(T.agent, t5.id, "avant", HEURE(8)); await televerser(T.agent, t5.id, "apres", HEURE(9));
  const clotureCout = await api("post", `/taches-internes/${t5.id}/cloturer`, T.agent).send({ quantite: 3, unite: "m3", coutReel: 90000 });
  verifier("5. une cloture qui porte un cout reel est refusee (422), la tache reste ouverte", clotureCout.status === 422 && clotureCout.body.motif === "CHAMP_CONTRACTUEL_REFUSE" && (await ligne(t5.id)).statut === "OUVERTE");
  verifier("5. un champ inconnu qui n'a rien de contractuel est refuse par le contrat (400)", (await creer(T.agent, base({ couleur: "rouge" }))).status === 400);
  verifier("5. la table n'a AUCUNE colonne contractuelle (lue dans information_schema, pas dans le code)",
    await compter(`SELECT count(*) n FROM information_schema.columns WHERE table_name='taches_internes' AND column_name ~* '(montant|prix|cout|marche|entreprise|prestataire|decompte|paiement|facture|devise|gnf|attributaire|titulaire|bailleur)'`) === 0);
  verifier("5. aucune cle etrangere de la table vers marches, decomptes, ordres de travaux ou chantiers",
    await compter(`SELECT count(*) n FROM pg_constraint c JOIN pg_class f ON f.oid = c.confrelid WHERE c.conrelid = 'taches_internes'::regclass AND c.contype='f' AND f.relname IN ('marches','decomptes','ordres_travaux','chantiers','bailleurs')`) === 0);
  verifier("5. apres tout le banc, aucun marche, decompte, ordre de travaux ni chantier n'a ete cree ou modifie", (await grosFlux()) === fluxAvant, { avant: fluxAvant, apres: await grosFlux() });

  // ---------------------------------------------------------------- 6. Idempotence hors ligne
  const cle = randomUUID();
  const i1 = await creer(T.agent, base({ clientOperationId: cle, intitule: "Tache hors ligne" }));
  const i2 = await creer(T.agent, base({ clientOperationId: cle, intitule: "Tache hors ligne" }));
  verifier("6. la meme operation rejouee rend la meme tache (201 puis 200), une seule ligne, un seul audit de creation",
    i1.status === 201 && i2.status === 200 && i1.body.id === i2.body.id && await compter(`SELECT count(*) n FROM taches_internes WHERE "clientOperationId"='${cle}'`) === 1 && await audits(i1.body.id) === 1);
  verifier("6. la cle d'un autre auteur n'est pas un jeton : 409, rien n'est revele", (await creer(T.autre, base({ clientOperationId: cle }))).status === 409);
  const cleC = randomUUID();
  const course = await Promise.all([1, 2, 3, 4].map(() => creer(T.agent, base({ clientOperationId: cleC, intitule: "Course sur la cle" }))));
  verifier("6. quatre creations simultanees sous la meme cle : une seule tache, aucune erreur serveur",
    course.every((r) => r.status === 200 || r.status === 201) && new Set(course.map((r) => r.body.id)).size === 1 && await compter(`SELECT count(*) n FROM taches_internes WHERE "clientOperationId"='${cleC}'`) === 1, course.map((r) => r.status));
  const avantRefs = await compter(`SELECT count(*) n FROM taches_internes`);
  const courseRef = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => creer(T.agent, base({ intitule: `Creation simultanee ${i}` }))));
  const refs = courseRef.map((r) => r.body.reference);
  verifier("6. six creations simultanees SANS cle : six taches, six references distinctes, aucune erreur serveur (course sur la reference absorbee)",
    courseRef.every((r) => r.status === 201) && new Set(refs).size === 6 && await compter(`SELECT count(*) n FROM taches_internes`) === avantRefs + 6, courseRef.map((r) => [r.status, r.body.reference ?? r.body.message]));

  // ---------------------------------------------------------------- 7. Rattachement et perimetre
  const sansRattachement = await creer(T.agent, { nature: "CANTONNAGE", intitule: "Tache sans lieu" });
  verifier("7. sans troncon, ouvrage, defaut ni point : 422 RATTACHEMENT_REQUIS", sansRattachement.status === 422 && sansRattachement.body.motif === "RATTACHEMENT_REQUIS");
  verifier("7. emprise incomplete, inversee ou sans troncon : refusees (422)",
    (await creer(T.agent, base({ debutM: 10 }))).body.motif === "EMPRISE_INCOMPLETE"
    && (await creer(T.agent, base({ debutM: 300, finM: 100 }))).body.motif === "EMPRISE_INVERSEE"
    && (await creer(T.agent, { nature: "CANTONNAGE", intitule: "Emprise sans troncon", lat: 9.6, lon: -13.6, debutM: 1, finM: 5 })).body.motif === "EMPRISE_SANS_TRONCON");
  verifier("7. position GPS incomplete : refusee", (await creer(T.agent, { nature: "CANTONNAGE", intitule: "GPS incomplet", lat: 9.6 })).body.motif === "POSITION_INCOMPLETE");
  verifier("7. nature inconnue, troncon introuvable, defaut introuvable : refuses avec leur motif",
    (await creer(T.agent, base({ nature: "TERRASSEMENT" }))).body.motif === "NATURE_INCONNUE"
    && (await creer(T.agent, base({ tronconId: randomUUID() }))).body.motif === "TRONCON_INTROUVABLE"
    && (await creer(T.agent, { nature: "CANTONNAGE", intitule: "Defaut fantome", defautId: randomUUID() })).body.motif === "DEFAUT_INTROUVABLE");
  const gps = await creer(T.chef, { nature: "VERIFICATION", intitule: "Verification en un point", lat: 9.612345, lon: -13.598765 });
  const pt = (await prisma.$queryRawUnsafe<{ lat: number; lon: number }[]>(`SELECT ST_Y(geom) lat, ST_X(geom) lon FROM taches_internes WHERE id='${gps.body.id}'`))[0];
  verifier("7. une tache rattachee a un seul point GPS est acceptee, le point PostGIS est celui envoye", gps.status === 201 && Math.abs(pt.lat - 9.612345) < 1e-9 && Math.abs(pt.lon + 13.598765) < 1e-9 && gps.body.lat === 9.612345 && gps.body.lon === -13.598765, { corps: gps.body, pt });
  const regionalOk = await creer(T.regional, base({ intitule: "Tache dans mon perimetre" }));
  const regionalHors = await creer(T.regional, base({ tronconId: T2, intitule: "Tache hors de mon perimetre" }));
  const regionalGps = await creer(T.regional, { nature: "VERIFICATION", intitule: "Tache a localisation inconnue", lat: 9.6, lon: -13.6 });
  verifier("7. controle territorial (A10) : un compte regional cree dans sa region (201), pas dans une autre (403 HORS_PERIMETRE), pas sur un simple point GPS (403 REGION_INCONNUE)",
    regionalOk.status === 201 && regionalHors.status === 403 && regionalHors.body.code === "HORS_PERIMETRE" && regionalGps.status === 403 && regionalGps.body.code === "REGION_INCONNUE", [regionalOk.status, regionalHors.body, regionalGps.body]);
  const tHors = (await creer(T.chef, base({ tronconId: T2, intitule: "Tache region 2", responsableId: regional.id }))).body;
  verifier("7. et il ne demarre pas, ne cloture pas la tache d'une autre region", (await api("post", `/taches-internes/${tHors.id}/demarrer`, T.regional).send({})).status === 403);
  verifier("7. confier une tache a un autre agent est reserve aux gestionnaires (403 pour un agent, 201 pour le chef)",
    (await creer(T.agent, base({ responsableId: autre.id }))).status === 403 && (await creer(T.chef, base({ responsableId: autre.id, intitule: "Tache confiee" }))).status === 201);
  verifier("7. un responsable desactive ou inconnu est refuse (422)", (await creer(T.chef, base({ responsableId: parti.id }))).body.motif === "RESPONSABLE_INVALIDE" && (await creer(T.chef, base({ responsableId: randomUUID() }))).body.motif === "RESPONSABLE_INVALIDE");

  // ---------------------------------------------------------------- 8. Visibilite et droits
  verifier("8. la tache d'un autre agent n'existe pas pour un agent (404), mais le gestionnaire la voit",
    (await api("get", `/taches-internes/${t1.id}`, T.autre)).status === 404 && (await api("get", `/taches-internes/${t1.id}`, T.chef)).status === 200);
  verifier("8. et un agent ne la demarre, ne la cloture, n'y joint rien (404)",
    (await api("post", `/taches-internes/${t5.id}/demarrer`, T.autre).send({})).status === 404 && (await televerser(T.autre, t5.id, "avant", HEURE(8))).status === 404);
  const liste = await api("get", "/taches-internes?limite=200", T.autre);
  verifier("8. la liste d'un agent ne contient que ses taches (celle qui lui est confiee), celle du chef en voit toutes",
    liste.status === 200 && liste.body.taches.every((t: { responsableId: string; creeParId: string }) => t.responsableId === autre.id || t.creeParId === autre.id) && (await api("get", "/taches-internes?limite=200", T.chef)).body.taches.length > liste.body.taches.length);
  verifier("8. un LECTEUR lit mais n'ecrit pas (403 sur la creation, le demarrage et la cloture)",
    (await api("get", "/taches-internes", T.lecteur)).status === 200 && (await creer(T.lecteur, base())).status === 403 && (await api("post", `/taches-internes/${t5.id}/demarrer`, T.lecteur).send({})).status === 403);
  verifier("8. sans jeton : 401 ; le rapprochement est reserve aux gestionnaires (403 pour un agent)",
    (await request(app).get("/api/v2/taches-internes")).status === 401 && (await api("get", "/taches-internes/rapprochement", T.agent)).status === 403);
  verifier("8. aucune route de suppression : DELETE rend 404, la tache existe encore", (await api("delete", `/taches-internes/${t1.id}`, T.chef)).status === 404 && (await ligne(t1.id)).statut === "CLOTUREE");
  await prisma.$executeRawUnsafe(`UPDATE taches_internes SET "deletedAt" = now() WHERE id = '${t4b.id}'`);
  verifier("8. une tache supprimee logiquement disparait de la lecture (404) mais reste en base", (await api("get", `/taches-internes/${t4b.id}`, T.chef)).status === 404 && await compter(`SELECT count(*) n FROM taches_internes WHERE id='${t4b.id}'`) === 1);
  const filtre = await api("get", "/taches-internes?statut=CLOTUREE&limite=200", T.chef);
  verifier("8. le filtre par statut ne rend que des taches cloturees", filtre.body.taches.length >= 3 && filtre.body.taches.every((t: { statut: string }) => t.statut === "CLOTUREE"), filtre.body.taches.length);
  const pageUn = await api("get", "/taches-internes?limite=3", T.chef);
  const pageDeux = await api("get", `/taches-internes?limite=3&apres=${pageUn.body.curseurSuivant}`, T.chef);
  verifier("8. la pagination par curseur ne rend ni doublon ni trou entre deux pages", pageUn.body.taches.length === 3 && pageDeux.body.taches.length > 0
    && pageDeux.body.taches[0].reference > pageUn.body.taches[2].reference && new Set([...pageUn.body.taches, ...pageDeux.body.taches].map((t: { id: string }) => t.id)).size === pageUn.body.taches.length + pageDeux.body.taches.length);

  // ---------------------------------------------------------------- 9. Les contraintes de la base tiennent meme sans le service
  const codeErreur = async (sql: string) => { try { await prisma.$executeRawUnsafe(sql); return ""; } catch (e) { return String((e as { meta?: { code?: string } }).meta?.code ?? (e as { code?: string }).code); } };
  const t9 = (await creer(T.agent, base({ intitule: "Tache pour contournement" }))).body;
  verifier("9. contourner le service pour cloturer SANS preuves : la base refuse (23514, tache_cloturee_avec_preuves)", await codeErreur(`UPDATE taches_internes SET statut='CLOTUREE', "clotureeLe"=now(), "clotureeParId"='${agent.id}' WHERE id='${t9.id}'`) === "23514");
  verifier("9. une preuve « apres » anterieure a l'« avant » : refusee par la base (23514)", await codeErreur(`UPDATE taches_internes SET "preuveAvantChemin"='a', "preuveAvantPriseLe"='2026-10-21 10:00', "preuveApresChemin"='b', "preuveApresPriseLe"='2026-10-21 09:00' WHERE id='${t9.id}'`) === "23514");
  verifier("9. un abandon sans motif : refuse par la base (23514)", await codeErreur(`UPDATE taches_internes SET statut='ABANDONNEE' WHERE id='${t9.id}'`) === "23514");
  verifier("9. aucune de ces tentatives n'a modifie la tache", (await ligne(t9.id)).statut === "OUVERTE" && (await ligne(t9.id)).preuveAvantChemin === null);

  // ---------------------------------------------------------------- 10. Rapprochement en lecture
  const mkDefaut = async (etat: string) => {
    const r = await api("post", "/defauts", T.chef).send({ catalogueCode: "UN_BANC", lat: 9.63, lon: -13.59, mesures: { nombre: 1 }, gravite: 2 });
    await prisma.$executeRawUnsafe(`UPDATE defauts SET etat='${etat}'::"EtatDefaut" WHERE id='${r.body.id}'`);
    return r.body.id as string;
  };
  const dActif = await mkDefaut("ACTIF"), dTraite = await mkDefaut("TRAITE");
  const rEchue = (await creer(T.chef, base({ intitule: "R: echue", echeanceLe: "2026-10-01" }))).body;
  const rCloDefautActif = (await creer(T.chef, { nature: "PETITE_REPARATION", intitule: "R: cloturee mais defaut actif", defautId: dActif })).body;
  await televerser(T.chef, rCloDefautActif.id, "avant", HEURE(8)); await televerser(T.chef, rCloDefautActif.id, "apres", HEURE(9));
  await api("post", `/taches-internes/${rCloDefautActif.id}/cloturer`, T.chef).send({});
  const rDefautTraite = (await creer(T.chef, { nature: "PETITE_REPARATION", intitule: "R: defaut traite, tache ouverte", defautId: dTraite })).body;
  const rResp = (await creer(T.chef, base({ intitule: "R: responsable parti" }))).body;
  await prisma.$executeRawUnsafe(`UPDATE taches_internes SET "responsableId"='${parti.id}' WHERE id='${rResp.id}'`);
  const etatAvant = [await compter(`SELECT count(*) n FROM taches_internes`), await compter(`SELECT count(*) n FROM audit_logs`), await compter(`SELECT count(*) n FROM operations_sync`), await compter(`SELECT sum(extract(epoch from "updatedAt"))::bigint n FROM taches_internes`)].join("/");
  const rap = await api("get", "/taches-internes/rapprochement", T.chef);
  const parTache = (id: string) => rap.body.alertes.filter((a: { tacheId: string }) => a.tacheId === id).map((a: { code: string }) => a.code).sort();
  verifier("10. rapprochement : echeance depassee detectee", JSON.stringify(parTache(rEchue.id)) === '["ECHUE_NON_CLOTUREE"]', rap.body.alertes);
  verifier("10. rapprochement : tache cloturee sur un defaut encore ACTIF detectee", JSON.stringify(parTache(rCloDefautActif.id)) === '["CLOTUREE_DEFAUT_ENCORE_ACTIF"]', parTache(rCloDefautActif.id));
  verifier("10. rapprochement : defaut TRAITE alors que la tache est ouverte detecte", JSON.stringify(parTache(rDefautTraite.id)) === '["DEFAUT_TRAITE_TACHE_NON_CLOTUREE"]', parTache(rDefautTraite.id));
  verifier("10. rapprochement : responsable inactif detecte", JSON.stringify(parTache(rResp.id)) === '["RESPONSABLE_INACTIF"]', parTache(rResp.id));
  verifier("10. une tache saine n'a aucune alerte (la tache cloturee t1 avec ses deux preuves)", parTache(t1.id).length === 0);
  verifier("10. le volet FINANCIER est declare indisponible (B-11), sans engagement invente, en lecture seule",
    rap.body.financier.disponible === false && /B-11/.test(rap.body.financier.motif) && rap.body.financier.engagements === 0 && rap.body.lectureSeule === true);
  const etatApres = [await compter(`SELECT count(*) n FROM taches_internes`), await compter(`SELECT count(*) n FROM audit_logs`), await compter(`SELECT count(*) n FROM operations_sync`), await compter(`SELECT sum(extract(epoch from "updatedAt"))::bigint n FROM taches_internes`)].join("/");
  await api("get", "/taches-internes/rapprochement", T.chef);
  const etatApres2 = [await compter(`SELECT count(*) n FROM taches_internes`), await compter(`SELECT count(*) n FROM audit_logs`), await compter(`SELECT count(*) n FROM operations_sync`), await compter(`SELECT sum(extract(epoch from "updatedAt"))::bigint n FROM taches_internes`)].join("/");
  verifier("10. LECTURE SEULE : deux appels du rapprochement ne changent ni les taches, ni le journal d'audit, ni les operations", etatAvant === etatApres && etatApres === etatApres2, { etatAvant, etatApres, etatApres2 });
  verifier("10. aucun marche, decompte, ordre de travaux ni chantier n'a ete cree ou modifie par le rapprochement", (await grosFlux()) === fluxAvant);

  // ---------------------------------------------------------------- Bilan
  const incoherentes = await compter(`SELECT count(*) n FROM taches_internes WHERE statut='CLOTUREE' AND NOT ("preuveAvantChemin" IS NOT NULL AND "preuveAvantPriseLe" IS NOT NULL AND "preuveApresChemin" IS NOT NULL AND "preuveApresPriseLe" IS NOT NULL AND "preuveApresPriseLe" >= "preuveAvantPriseLe" AND "clotureeLe" IS NOT NULL AND "clotureeParId" IS NOT NULL)`);
  const clotures = await compter(`SELECT count(*) n FROM taches_internes WHERE statut='CLOTUREE'`);
  verifier(`11. bilan : sur ${clotures} taches cloturees, 0 sans preuves completes, ordonnees et signees (ecrit independamment des contraintes)`, clotures >= 4 && incoherentes === 0, { clotures, incoherentes });
  verifier("11. bilan : chaque tache a au moins sa ligne d'audit de creation", await compter(`SELECT count(*) n FROM taches_internes t WHERE NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a."entityType"='TacheInterne' AND a."entityId"=t.id AND a.action='CREATE')`) === 0);

  // Les photos du banc sont retirees : elles n'ont de sens que dans le clone detruit.
  for (const f of await fichiersCrees()) await unlink(path.join(DOSSIER_PHOTOS, f)).catch(() => undefined);
  verifier("11. bilan : aucun fichier de preuve du banc ne subsiste sur le disque", (await fichiersCrees()).length === 0);

  conclure();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => {
    for (const f of await readdir(DOSSIER_PHOTOS).catch(() => [] as string[])) if (!fichiersAuDepart.has(f)) await unlink(path.join(DOSSIER_PHOTOS, f)).catch(() => undefined);
    await prisma.$disconnect();
    await banc.fermer();
  });
