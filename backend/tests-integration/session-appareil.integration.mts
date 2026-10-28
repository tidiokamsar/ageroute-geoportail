// Banc d'integration de la SESSION ET DE L'APPAREIL cote serveur (chantier D4 ; docs/securite/SESSION-HORS-LIGNE.md
// sections 5, 7 et 8, docs/securite/SESSION-HORS-LIGNE-SERVEUR.md). Voir tests-integration/README.md. Lancer
// (DATABASE_URL pointe sur `replay`, jamais ecrite : le banc travaille dans le clone `essai_session_appareil`) :
//   npx tsx tests-integration/session-appareil.integration.mts
//
// CE QUE LE BANC FAIT PASSER PAR LE CODE REEL : l'application ENTIERE (`createApp()`), de VRAIES connexions
// (`POST /api/auth/login` avec un mot de passe aleatoire tire a chaque lancement), de vrais jetons de rafraichissement
// tournes et revoques, les modules et le perimetre lus en base, l'audit transactionnel, contre un clone PostGIS jetable.
// Rien n'est simule cote serveur. Chaque verification relit la BASE (ligne d'audit, ligne `operations_sync`, jeton
// revoque, ligne absente), jamais la seule reponse HTTP.
//
// CE QUE LE BANC PROUVE
//   D1 un compte DESACTIVE ou VERROUILLE est refuse immediatement (401 COMPTE_INACTIF) avec un jeton d'acces encore
//      valide, y compris sur `sync/push` ; un role RETROGRADE (ou promu dans le jeton seul) est celui de la base ;
//   D2 revoquer un appareil coupe les sessions de rafraichissement de son proprietaire (portee rendue dans la reponse),
//      pas celles d'un autre compte ; la coupure et sa trace sont atomiques (un declencheur de base refuse la trace :
//      rien n'est revoque) ;
//   D3 APPAREIL_REVOQUE distinct d'APPAREIL_INCONNU (push, status, enregistrement) ; un appareil revoque ne se
//      re-enregistre pas sous le meme identifiant ;
//   D4 DROITS_MODIFIES : perimetre et module retires, trace durable sans contenu, idempotence AVANT les droits, renvoi
//      explicite reevalue quand les droits sont rendus ; compte inactif refuse sans rien ecrire ;
//   D5 evenements locaux : lot borne, liste fermee, champs fermes, idempotence (y compris sous rejeux CONCURRENTS),
//      aucun contenu, debit par compte ;
//   D6 GET /auth/me rend role, modules et regions lus en base, sans nouveau jeton.
// Et le COUT mesure d'une lecture de compte par requete authentifiee (base locale, ordre de grandeur seulement).
//
// NON COUVERT (dit honnetement) : la file locale d'un telephone et le client (autre agent) ; le rafraichissement par cookie
// (le banc utilise le corps, transition documentee) ; la coupure du jeton d'acces d'un appareil revoque pendant sa duree de vie
// (limite connue : voir le document, defaut residuel) ; une base de production.
import { randomBytes, randomUUID } from "node:crypto";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

// server.ts pose ce correctif au demarrage (les montants BigInt sortent en chaine) ; createApp() ne le porte pas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () { return this.toString(); };

// BANC_CLONE : nom du clone jetable, modifiable pour que deux executions simultanees ne se detruisent pas le clone (meme poste, meme base).
const banc = await ouvrirBancClone(process.env.BANC_CLONE ?? "essai_session_appareil");
// Le plafond de debit de /api/v2 compterait les centaines d'appels du banc : il est desactive (0), comme le permet l'env.
process.env.RATE_LIMIT_V2_MAX = "0";
// Idem pour le plafond du rafraichissement (par adresse) : la repetition de la course en fait des centaines.
process.env.RATE_LIMIT_REFRESH_MAX = "0";
const { prisma } = await banc.imp("lib/prisma");
const { createApp } = await banc.imp("app");
const { signAccessToken } = await banc.imp("utils/jwt");
const { hashPassword } = await banc.imp("utils/password");
const { signRefreshToken } = await banc.imp("utils/jwt");
const { hashRefreshToken } = await banc.imp("utils/tokens");
const authMw = await banc.imp("middleware/auth.middleware");
const { _reinitialiserLimiteEvenementsLocaux, EVENEMENTS_LOCAUX_MAX_PAR_JOUR, EVENEMENTS_LOCAUX_LOTS_PAR_FENETRE } = await banc.imp("modules/auth/evenements-locaux");
const request = (await import("supertest")).default;
const { Client: ClientPg } = (await import("pg")).default;
const app = createApp();

const sql = async <T = Record<string, unknown>>(texte: string, ...params: unknown[]): Promise<T[]> => prisma.$queryRawUnsafe(texte, ...params);
const compter = async (texte: string, ...params: unknown[]): Promise<number> => Number((await sql<{ n: bigint }>(texte, ...params))[0].n);
const jeton = (u: { id: string; role: string; email: string }) => signAccessToken({ sub: u.id, role: u.role, email: u.email });

type Verbe = "get" | "post" | "put" | "patch" | "delete";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rep = { status: number; body: any };
const appeler = (verbe: Verbe, url: string, token: string, corps?: unknown) => {
  const r = request(app)[verbe](url).set("Authorization", `Bearer ${token}`);
  return corps === undefined ? r : r.send(corps as object);
};
const push = (token: string, appareilId: string, operations: unknown[]) => appeler("post", "/api/v2/sync/push", token, { appareilId, operations });
const mediane = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const centile = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * p))];
const arrondi = (x: number) => Math.round(x * 100) / 100;

async function main() {
  // ---------------------------------------------------------------- Fixtures
  await sql(`INSERT INTO regions (nom) VALUES ('Region sa 1'), ('Region sa 2')`);
  const regionId = async (nom: string) => Number((await sql<{ id: number }>(`SELECT id FROM regions WHERE nom = $1`, nom))[0].id);
  const [R1, R2] = [await regionId("Region sa 1"), await regionId("Region sa 2")];

  // Mots de passe tires au hasard a chaque lancement : jamais ecrits, jamais affiches.
  const mdp = randomBytes(12).toString("hex") + "Aa1";
  const hash = await hashPassword(mdp);
  const mkUser = (email: string, role: string, modulesAutorises: string[], avecMotDePasse = false) =>
    prisma.user.create({ data: { email, nomComplet: email, passwordHash: avecMotDePasse ? hash : "x", role, modulesAutorises } });
  const admin = await mkUser("admin@sa.invalid", "ADMIN", []);
  const agent = await mkUser("agent@sa.invalid", "INSPECTEUR", ["inspections"], true);   // national, se connecte vraiment
  const autre = await mkUser("autre@sa.invalid", "INSPECTEUR", ["inspections"], true);   // un autre agent
  const reg = await mkUser("reg@sa.invalid", "INSPECTEUR", ["inspections"]);              // agent regional (R1)
  const chef = await mkUser("chef@sa.invalid", "GESTIONNAIRE", ["inspections"]);
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, reg.id, R1, admin.id);

  const geom = `ST_SetSRID(ST_MakeLine(ST_MakePoint(-13.60, 9.64), ST_MakePoint(-13.58, 9.64)), 4326)`;
  const mkTroncon = async (code: string, rid: number) => {
    const id = randomUUID();
    await sql(`INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
               VALUES ($1, $2, 'Troncon ' || $2, 'RR', $3, 2.2, 'BITUME', 0, 2.2, ${geom}, now())`, id, code, rid);
    return id;
  };
  const T1 = await mkTroncon("SA-T1", R1);
  const T2 = await mkTroncon("SA-T2", R2);
  await prisma.catalogueDefaut.create({ data: { code: "NID_SA", libelle: "Nid de poule (banc session)", famille: "CHAUSSEE", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: 4 } });
  const mAutre = await prisma.mission.create({ data: { code: "SA-M-AUTRE", intitule: "Mission d'un autre agent", type: "SURVEILLANCE", createurId: chef.id, assigneId: autre.id } });
  const devReg = await prisma.appareil.create({ data: { userId: reg.id, nom: "tel regional", plateforme: "android" } });
  const devAgent = await prisma.appareil.create({ data: { userId: agent.id, nom: "tel agent", plateforme: "android" } });
  const devAutre = await prisma.appareil.create({ data: { userId: autre.id, nom: "tel autre", plateforme: "android" } });

  // `sensible` ajoute au contenu une cle inconnue : valable seulement pour une operation que les droits refusent AVANT toute
  // validation de la donnee (le schema d'un defaut est ferme). On verifie alors que ce contenu n'est pas conserve.
  const opDefaut = (tronconId: string, sensible = false) => {
    const id = randomUUID();
    return { operationId: id, entityType: "Defaut", entityId: id, operation: "CREATE" as const, baseVersion: null,
      payload: { catalogueCode: "NID_SA", lat: 9.65, lon: -13.59, precisionM: 4, tronconId, mesures: { nombre: 3 }, gravite: 2,
        ...(sensible ? { secret: "contenu-sensible-ne-doit-pas-rester" } : {}) } };
  };
  const opObs = (missionId: string | null) => {
    const id = randomUUID();
    return { operationId: id, entityType: "Observation", entityId: id, operation: "CREATE" as const, baseVersion: null,
      payload: { type: "DEGRADATION", gravite: "MOYENNE", description: "obs banc", ...(missionId ? { missionId } : {}), tronconId: T1, lat: 9.64, lon: -13.595, precisionM: 5, observeA: new Date().toISOString() } };
  };
  const ligneOp = async (operationId: string) => (await sql<{ statut: string; derniereErreur: string | null; payload: unknown; userId: string; appareilId: string; tentatives: number }>(
    `SELECT statut::text AS statut, "derniereErreur", payload, "userId", "appareilId", tentatives FROM operations_sync WHERE "operationId" = $1`, operationId))[0];
  const nbOps = (operationId: string) => compter(`SELECT count(*) n FROM operations_sync WHERE "operationId" = $1`, operationId);
  const nbDefauts = (entityId: string) => compter(`SELECT count(*) n FROM defauts WHERE id = $1`, entityId);
  // CONSTAT DU BANC : le jeton de rafraichissement est un JWT sans identifiant unique (`jti`) ; deux connexions du MEME compte dans
  // la meme seconde produisent la meme chaine, donc la meme empreinte, et la seconde echoue en 409 (unicite de `tokenHash`). Le banc
  // espace donc ses connexions de plus d'une seconde. Le defaut est signale dans le rapport (utils/jwt.ts, hors perimetre).
  let derniereConnexion = 0;
  const login = async (email: string): Promise<{ status: number; accessToken: string; refreshToken: string }> => {
    const attente = derniereConnexion + 1100 - Date.now();
    if (attente > 0) await new Promise((r) => setTimeout(r, attente));
    derniereConnexion = Date.now();
    const r = await request(app).post("/api/auth/login").send({ email, password: mdp });
    return { status: r.status, accessToken: r.body.accessToken, refreshToken: r.body.refreshToken };
  };
  // Meme raison : une rotation dans la seconde de la connexion rendrait le meme jeton (unicite de `tokenHash`).
  const refresh = async (refreshToken: string) => {
    const attente = derniereConnexion + 1100 - Date.now();
    if (attente > 0) await new Promise((r) => setTimeout(r, attente));
    return request(app).post("/api/auth/refresh").send({ refreshToken });
  };

  // ================================================================ D1. Le compte est relu en base
  console.log("\n== D1. Compte desactive, verrouille, retrograde : effet immediat avec un jeton d'acces encore valide ==");
  const tAgent = jeton(agent);
  const avant = await appeler("get", "/api/v2/devices", tAgent);
  verifier("D1 reference : compte actif, jeton valide : GET /api/v2/devices 200", avant.status === 200, avant.status);

  await sql(`UPDATE users SET actif = false WHERE id = $1`, agent.id);
  const inactif = await appeler("get", "/api/v2/devices", tAgent);
  const inactifPush = await push(tAgent, devAgent.id, [opDefaut(T1)]);
  const inactifMe = await appeler("get", "/api/auth/me", tAgent);
  verifier("D1 un compte DESACTIVE est refuse IMMEDIATEMENT avec son jeton encore valide : 401 COMPTE_INACTIF sur une lecture, sur /auth/me et sur sync/push",
    [inactif, inactifPush, inactifMe].every((r) => r.status === 401 && r.body.code === "COMPTE_INACTIF"), [inactif.status, inactifPush.status, inactifMe.status, inactif.body]);
  verifier("D1 sync/push d'un compte desactive n'ecrit RIEN : aucune ligne operations_sync pour cet appareil",
    await compter(`SELECT count(*) n FROM operations_sync WHERE "appareilId" = $1`, devAgent.id) === 0);
  await sql(`UPDATE users SET actif = true WHERE id = $1`, agent.id);
  verifier("D1 contre-epreuve : le MEME jeton redevient accepte des que le compte est reactive (c'est bien la base qui decide)",
    (await appeler("get", "/api/v2/devices", tAgent)).status === 200);

  await sql(`UPDATE users SET "lockedUntil" = now() + interval '10 minutes' WHERE id = $1`, agent.id);
  const verrouille = await appeler("get", "/api/v2/devices", tAgent);
  await sql(`UPDATE users SET "lockedUntil" = now() - interval '1 minute' WHERE id = $1`, agent.id);
  const echu = await appeler("get", "/api/v2/devices", tAgent);
  verifier("D1 un compte VERROUILLE (lockedUntil dans le futur) est refuse (401 COMPTE_INACTIF) ; un verrou echu ne bloque plus",
    verrouille.status === 401 && verrouille.body.code === "COMPTE_INACTIF" && echu.status === 200, [verrouille.status, verrouille.body, echu.status]);
  await sql(`UPDATE users SET "lockedUntil" = NULL WHERE id = $1`, agent.id);

  const tChef = jeton(chef);
  const chefAvant = await appeler("get", "/api/v2/defauts/catalogue/admin", tChef);
  await sql(`UPDATE users SET role = 'LECTEUR' WHERE id = $1`, chef.id);
  const chefApres = await appeler("get", "/api/v2/defauts/catalogue/admin", tChef);
  await sql(`UPDATE users SET role = 'GESTIONNAIRE' WHERE id = $1`, chef.id);
  verifier("D1 un compte RETROGRADE de GESTIONNAIRE a LECTEUR perd ses droits de gestion IMMEDIATEMENT (jeton inchange : 200 avant, 403 apres) et les retrouve a la promotion",
    chefAvant.status === 200 && chefApres.status === 403 && (await appeler("get", "/api/v2/defauts/catalogue/admin", tChef)).status === 200, [chefAvant.status, chefApres.status]);

  const tFauxAdmin = signAccessToken({ sub: chef.id, role: "ADMIN", email: chef.email });
  const fauxAdmin = await appeler("get", "/api/users", tFauxAdmin);
  verifier("D1 un jeton qui DIT ADMIN pour un compte GESTIONNAIRE en base n'ouvre pas l'administration (le role du jeton est ignore)", fauxAdmin.status === 403, fauxAdmin.status);

  const tInconnu = signAccessToken({ sub: randomUUID(), role: "ADMIN", email: "fantome@sa.invalid" });
  const inconnu = await appeler("get", "/api/v2/devices", tInconnu);
  verifier("D1 un jeton valide pour un compte qui n'existe plus : 401 COMPTE_INACTIF (meme reponse qu'un compte desactive)", inconnu.status === 401 && inconnu.body.code === "COMPTE_INACTIF", inconnu.body);

  // ================================================================ D2 / D3. Appareils et sessions de rafraichissement
  console.log("\n== D2/D3. Revocation d'un appareil et sessions de rafraichissement ==");
  const s1 = await login("agent@sa.invalid");
  const s2 = await login("agent@sa.invalid");
  const sAutre = await login("autre@sa.invalid");
  verifier("D2 fixtures : trois connexions reelles (deux du meme agent, une d'un autre compte)", [s1, s2, sAutre].every((s) => s.status === 200 && !!s.refreshToken), [s1.status, s2.status, sAutre.status]);

  const enr = await appeler("post", "/api/v2/devices", s1.accessToken, { plateforme: "android", nom: "telephone perdu" });
  const D = enr.body.id as string;
  verifier("D3 un appareil neuf s'enregistre sans identifiant (201) : le serveur genere l'identifiant", enr.status === 201 && typeof D === "string", enr.status);
  const rot = await refresh(s1.refreshToken);
  const s1b = rot.body.refreshToken as string;
  verifier("D2 reference : avant la revocation, le rafraichissement fonctionne (200) et tourne", rot.status === 200 && !!s1b, rot.status);
  const actifsAvant = await compter(`SELECT count(*) n FROM refresh_tokens WHERE "userId" = $1 AND "revokedAt" IS NULL`, agent.id);

  const rev = await appeler("post", `/api/v2/devices/${D}/revoke`, s1.accessToken);
  verifier("D2 la revocation repond 200 et DIT sa portee : toutes les sessions du proprietaire, avec leur nombre",
    rev.status === 200 && rev.body.rafraichissement?.revoque === true && rev.body.rafraichissement?.portee === "TOUTES_LES_SESSIONS_DU_PROPRIETAIRE"
    && rev.body.rafraichissement?.sessions === actifsAvant && actifsAvant >= 2, [rev.status, rev.body.rafraichissement, actifsAvant]);
  verifier("D2 en base : AUCUN jeton de rafraichissement actif ne reste a l'agent ; ceux d'un autre compte sont intacts",
    await compter(`SELECT count(*) n FROM refresh_tokens WHERE "userId" = $1 AND "revokedAt" IS NULL`, agent.id) === 0
    && await compter(`SELECT count(*) n FROM refresh_tokens WHERE "userId" = $1 AND "revokedAt" IS NULL`, autre.id) >= 1);
  const apresS2 = await refresh(s2.refreshToken);
  const apresS1b = await refresh(s1b);
  const apresAutre = await refresh(sAutre.refreshToken);
  verifier("D2 la session de rafraichissement du porteur est COUPEE (les deux jetons restants : 401) ; celle d'un autre compte continue (200)",
    apresS2.status === 401 && apresS1b.status === 401 && apresAutre.status === 200, [apresS2.status, apresS1b.status, apresAutre.status]);
  const audRev = (await sql<{ after: Record<string, unknown>; ipAddress: string | null; userId: string }>(
    `SELECT after, "ipAddress", "userId" FROM audit_logs WHERE action = 'SECURITY_EVENT' AND "entityType" = 'Appareil' AND "entityId" = $1`, D));
  verifier("D2 UNE trace SECURITY_EVENT (appareil, porteur, nombre de sessions coupees, adresse vue par le serveur) a ete ecrite avec la revocation",
    audRev.length === 1 && audRev[0].after.sessionsRefreshRevoquees === actifsAvant && audRev[0].after.porteur === agent.id && !!audRev[0].ipAddress, audRev);

  // Code stable : l'appareil revoque, l'appareil inconnu, l'appareil d'un autre compte.
  const nbAppareils = () => compter(`SELECT count(*) n FROM appareils`);
  const nbAvant = await nbAppareils();
  const pRev = await push(s1.accessToken, D, [opDefaut(T1)]);
  const pInc = await push(s1.accessToken, randomUUID(), [opDefaut(T1)]);
  const pAutrui = await push(s1.accessToken, devAutre.id, [opDefaut(T1)]);
  verifier("D3 sync/push : appareil REVOQUE = 403 APPAREIL_REVOQUE ; appareil inconnu OU d'un autre compte = 403 APPAREIL_INCONNU (message historique conserve)",
    pRev.status === 403 && pRev.body.code === "APPAREIL_REVOQUE" && pInc.status === 403 && pInc.body.code === "APPAREIL_INCONNU"
    && pAutrui.status === 403 && pAutrui.body.code === "APPAREIL_INCONNU" && /^Appareil inconnu, révoqué/.test(pInc.body.message), [pRev.body, pInc.body, pAutrui.body]);
  verifier("D3 aucune operation n'est ecrite pour l'appareil revoque", await compter(`SELECT count(*) n FROM operations_sync WHERE "appareilId" = $1`, D) === 0);
  const reRev = await appeler("post", "/api/v2/devices", s1.accessToken, { plateforme: "android", appareilId: D });
  const reInc = await appeler("post", "/api/v2/devices", s1.accessToken, { plateforme: "android", appareilId: randomUUID() });
  const reAutrui = await appeler("post", "/api/v2/devices", s1.accessToken, { plateforme: "android", appareilId: devAutre.id });
  verifier("D3 un appareil revoque NE SE RE-ENREGISTRE PAS sous le meme identifiant : 403 APPAREIL_REVOQUE ; inconnu et d'autrui : 403 APPAREIL_INCONNU ; aucune ligne creee",
    reRev.status === 403 && reRev.body.code === "APPAREIL_REVOQUE" && reInc.body.code === "APPAREIL_INCONNU" && reAutrui.body.code === "APPAREIL_INCONNU"
    && await nbAppareils() === nbAvant, [reRev.body, reInc.body, reAutrui.body]);
  const encore = (await sql<{ revoqueA: Date | null }>(`SELECT "revoqueA" FROM appareils WHERE id = $1`, D))[0];
  verifier("D3 la revocation est definitive en base : la ligne reste revoquee apres ces tentatives", encore.revoqueA !== null);
  const stRev = await appeler("get", `/api/v2/sync/status?appareilId=${D}`, s1.accessToken);
  const stAdmin = await appeler("get", `/api/v2/sync/status?appareilId=${D}`, jeton(admin));
  verifier("D3 GET /sync/status : le porteur d'un appareil revoque recoit 403 APPAREIL_REVOQUE ; un ADMIN lit l'etat et la date de revocation (200)",
    stRev.status === 403 && stRev.body.code === "APPAREIL_REVOQUE" && stAdmin.status === 200 && !!stAdmin.body.revoqueA, [stRev.status, stRev.body, stAdmin.status]);
  const dejaRev = await appeler("post", `/api/v2/devices/${D}/revoke`, s1.accessToken);
  verifier("D2 revoquer deux fois : 409 APPAREIL_DEJA_REVOQUE, sans nouvelle trace",
    dejaRev.status === 409 && dejaRev.body.code === "APPAREIL_DEJA_REVOQUE"
    && await compter(`SELECT count(*) n FROM audit_logs WHERE action = 'SECURITY_EVENT' AND "entityType" = 'Appareil' AND "entityId" = $1`, D) === 1);

  // D9, point 6 : le jeton d'acces d'un telephone revoque reste valable jusqu'a son expiration, mais il n'enregistre plus
  // d'appareil NEUF tant que la revocation a moins que la duree d'un jeton d'acces (15 minutes par defaut).
  const nouveau = await appeler("post", "/api/v2/devices", s1.accessToken, { plateforme: "android", nom: "telephone du voleur" });
  verifier("D9 point 6 : le jeton d'acces d'un telephone revoque n'enregistre PLUS un appareil neuf : 403 APPAREIL_REVOCATION_RECENTE avec un delai de reessai (au plus 15 min), aucune ligne creee",
    nouveau.status === 403 && nouveau.body.code === "APPAREIL_REVOCATION_RECENTE" && nouveau.body.reessayerDansMs > 0 && nouveau.body.reessayerDansMs <= 15 * 60_000
    && await nbAppareils() === nbAvant, [nouveau.status, nouveau.body, await nbAppareils(), nbAvant]);
  const pousseNeuf = await push(s1.accessToken, D, [opDefaut(T1)]);
  verifier("D9 point 6 : et le MEME jeton ne pousse pas depuis l'appareil revoque (APPAREIL_REVOQUE) : la voie « appareil neuf puis push » est fermee",
    pousseNeuf.status === 403 && pousseNeuf.body.code === "APPAREIL_REVOQUE", pousseNeuf.body);
  verifier("D9 point 6 : la re-declaration d'un appareil ACTIF du compte n'est pas concernee (200)",
    (await appeler("post", "/api/v2/devices", s1.accessToken, { plateforme: "android", appareilId: devAgent.id })).status === 200);
  await sql(`UPDATE appareils SET "revoqueA" = now() - interval '16 minutes' WHERE "userId" = $1 AND "revoqueA" IS NOT NULL`, agent.id);
  const apresFenetre = await appeler("post", "/api/v2/devices", s1.accessToken, { plateforme: "android", nom: "nouveau telephone legitime" });
  verifier("D9 point 6 : la fenetre se referme d'elle-meme : 16 minutes apres la revocation, un appareil neuf s'enregistre (201)", apresFenetre.status === 201, [apresFenetre.status, apresFenetre.body]);
  const autreAgent = await appeler("post", "/api/v2/devices", (await login("autre@sa.invalid")).accessToken, { plateforme: "android", nom: "autre compte" });
  verifier("D9 point 6 : la regle est PAR COMPTE : un autre compte, sans revocation recente, enregistre un appareil neuf (201)", autreAgent.status === 201, autreAgent.status);

  // D9, point 7a : /revoke d'un appareil d'autrui ne se distingue pas d'un appareil inconnu (non-ADMIN).
  const revAutrui = await appeler("post", `/api/v2/devices/${devAutre.id}/revoke`, s1.accessToken);
  const revInconnu = await appeler("post", `/api/v2/devices/${randomUUID()}/revoke`, s1.accessToken);
  verifier("D9 point 7a : /revoke de l'appareil d'un autre compte = /revoke d'un appareil inconnu (404, meme corps) pour un non-ADMIN ; l'appareil d'autrui n'est pas touche",
    revAutrui.status === 404 && revInconnu.status === 404 && JSON.stringify(revAutrui.body) === JSON.stringify(revInconnu.body)
    && (await sql<{ revoqueA: Date | null }>(`SELECT "revoqueA" FROM appareils WHERE id = $1`, devAutre.id))[0].revoqueA === null, [revAutrui.status, revInconnu.status, revAutrui.body, revInconnu.body]);

  // Atomicite : un declencheur de base refuse la trace de revocation ; ni l'appareil ni les sessions ne doivent etre revoques.
  const s3 = await login("agent@sa.invalid");
  const D2 = (await appeler("post", "/api/v2/devices", s3.accessToken, { plateforme: "android", nom: "tel atomique" })).body.id as string;
  await sql(`CREATE OR REPLACE FUNCTION sa_refuse_trace() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'trace refusee par le banc'; END; $$ LANGUAGE plpgsql`);
  await sql(`CREATE TRIGGER sa_refuse_trace BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW."entityType" = 'Appareil' AND NEW.action = 'SECURITY_EVENT') EXECUTE FUNCTION sa_refuse_trace()`);
  const revKo = await appeler("post", `/api/v2/devices/${D2}/revoke`, s3.accessToken);
  await sql(`DROP TRIGGER sa_refuse_trace ON audit_logs`);
  await sql(`DROP FUNCTION sa_refuse_trace()`);
  const encoreRefresh = await refresh(s3.refreshToken);
  verifier("D2 ATOMIQUE : si la trace de securite est refusee par la base, la revocation echoue (500), l'appareil n'est PAS revoque et la session de rafraichissement vit encore (200)",
    revKo.status === 500 && (await sql<{ revoqueA: Date | null }>(`SELECT "revoqueA" FROM appareils WHERE id = $1`, D2))[0].revoqueA === null && encoreRefresh.status === 200, [revKo.status, encoreRefresh.status]);
  const revOk = await appeler("post", `/api/v2/devices/${D2}/revoke`, jeton(admin));
  verifier("D2 un ADMIN qui revoque l'appareil d'un agent coupe les sessions de L'AGENT, pas les siennes (la trace est a son nom)",
    revOk.status === 200 && await compter(`SELECT count(*) n FROM refresh_tokens WHERE "userId" = $1 AND "revokedAt" IS NULL`, agent.id) === 0
    && (await sql<{ userId: string }>(`SELECT "userId" FROM audit_logs WHERE "entityType" = 'Appareil' AND "entityId" = $1 AND action = 'SECURITY_EVENT'`, D2))[0].userId === admin.id,
    [revOk.status, await compter(`SELECT count(*) n FROM refresh_tokens WHERE "userId" = $1 AND "revokedAt" IS NULL`, agent.id),
      await sql(`SELECT "userId", action::text AS action FROM audit_logs WHERE "entityType" = 'Appareil' AND "entityId" = $1`, D2)]);

  // ================================================================ D4. DROITS_MODIFIES sur sync/push
  console.log("\n== D4. Refus de droits au rejeu : DROITS_MODIFIES ==");
  const tReg = jeton(reg);
  const opHors = opDefaut(T2, true), opDans = opDefaut(T1);
  const p1 = await push(tReg, devReg.id, [opHors, opDans]);
  const [rHors, rDans] = p1.body.resultats ?? [];
  verifier("D4 perimetre : l'operation hors perimetre est REJETE `DROITS_MODIFIES` (cause HORS_PERIMETRE), definitive, SANS delai de reessai ; l'autre est SYNCHRONISE",
    p1.status === 200 && rHors?.statut === "REJETE" && rHors?.motif === "DROITS_MODIFIES" && rHors?.cause === "HORS_PERIMETRE" && rHors?.definitif === true
    && !("reessayerDansMs" in rHors) && rDans?.statut === "SYNCHRONISE" && p1.body.refusDroits === 1 && p1.body.rejetees === 1, p1.body);
  const traceHors = await ligneOp(opHors.operationId);
  verifier("D4 le refus laisse une TRACE DURABLE : une ligne operations_sync REJETE `DROITS_MODIFIES:HORS_PERIMETRE`, rattachee au compte et a l'appareil",
    traceHors?.statut === "REJETE" && traceHors.derniereErreur === "DROITS_MODIFIES:HORS_PERIMETRE" && traceHors.userId === reg.id && traceHors.appareilId === devReg.id, traceHors);
  verifier("D4 la trace NE CONSERVE PAS le contenu de l'operation refusee (payload caviarde), et aucun defaut n'est cree",
    JSON.stringify(traceHors?.payload) === '{"redacted":true}' && !JSON.stringify(traceHors).includes("contenu-sensible") && await nbDefauts(opHors.entityId) === 0, traceHors?.payload);
  verifier("D4 l'operation synchronisee, elle, est bien enregistree et ecrite (un defaut)", (await ligneOp(opDans.operationId))?.statut === "SYNCHRONISE" && await nbDefauts(opDans.entityId) === 1);

  const p2 = await push(tReg, devReg.id, [opHors, opDans]);
  const traceHors2 = await ligneOp(opHors.operationId);
  verifier("D4 IDEMPOTENCE : rejouer le lot rend le MEME refus (definitif) et REJOUEE pour l'operation appliquee ; toujours UNE ligne par operation, le compteur d'essais monte",
    p2.body.resultats?.[0]?.motif === "DROITS_MODIFIES" && p2.body.resultats?.[1]?.statut === "REJOUEE"
    && await nbOps(opHors.operationId) === 1 && await nbOps(opDans.operationId) === 1 && traceHors2.tentatives === traceHors.tentatives + 1, [p2.body.resultats, traceHors2.tentatives]);

  // Le perimetre change : le compte passe de R1 a R2.
  await sql(`DELETE FROM perimetres_comptes WHERE "userId" = $1`, reg.id);
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3)`, reg.id, R2, admin.id);
  const p3 = await push(tReg, devReg.id, [opDans]);
  verifier("D4 L'IDEMPOTENCE PASSE AVANT LES DROITS : l'operation deja appliquee en R1, rejouee apres que le compte est passe en R2, rend REJOUEE (pas un refus) et sa trace reste SYNCHRONISE",
    p3.body.resultats?.[0]?.statut === "REJOUEE" && (await ligneOp(opDans.operationId)).statut === "SYNCHRONISE", p3.body.resultats);
  // Le renvoi est explicite : le telephone renvoie la meme operation (meme cle), ici sans la cle inconnue du premier envoi.
  const opHorsRenvoyee = { ...opHors, payload: opDefaut(T2).payload };
  const p4 = await push(tReg, devReg.id, [opHorsRenvoyee]);
  verifier("D4 RENVOI EXPLICITE apres changement de droits : la meme operation (meme cle), refusee puis rendue accessible par le nouveau perimetre, est REEVALUEE et appliquee (SYNCHRONISE, defaut cree, ligne mise a jour)",
    p4.body.resultats?.[0]?.statut === "SYNCHRONISE" && (await ligneOp(opHors.operationId)).statut === "SYNCHRONISE" && await nbDefauts(opHors.entityId) === 1 && await nbOps(opHors.operationId) === 1, p4.body.resultats);
  const opR1 = opDefaut(T1);
  const p5 = await push(tReg, devReg.id, [opR1]);
  verifier("D4 contre-epreuve : avec le perimetre R2, une operation en R1 est refusee a son tour (c'est bien le perimetre en base qui decide)",
    p5.body.resultats?.[0]?.motif === "DROITS_MODIFIES" && p5.body.resultats?.[0]?.cause === "HORS_PERIMETRE", p5.body.resultats);

  // Le module est retire.
  await sql(`UPDATE users SET "modulesAutorises" = '{}' WHERE id = $1`, reg.id);
  const opM1 = opDefaut(T2, true), opM2 = opDefaut(T2);
  const p6 = await push(tReg, devReg.id, [opM1, opM2, opDans]);
  const tM1 = await ligneOp(opM1.operationId);
  verifier("D4 module de collecte RETIRE : chaque operation recoit un refus individuel `DROITS_MODIFIES` (cause MODULE_RETIRE, definitif) au lieu d'un 403 muet ; l'operation deja appliquee rend REJOUEE",
    p6.status === 200 && p6.body.resultats?.[0]?.cause === "MODULE_RETIRE" && p6.body.resultats?.[1]?.cause === "MODULE_RETIRE" && p6.body.resultats?.[0]?.definitif === true
    && p6.body.resultats?.[2]?.statut === "REJOUEE" && p6.body.refusDroits === 2, p6.body);
  verifier("D4 le refus de module est TRACE sans contenu, et rien n'est ecrit (aucun defaut)",
    tM1?.derniereErreur === "DROITS_MODIFIES:MODULE_RETIRE" && JSON.stringify(tM1.payload) === '{"redacted":true}' && await nbDefauts(opM1.entityId) === 0 && await nbDefauts(opM2.entityId) === 0, tM1);
  const lecture = await appeler("get", "/api/v2/devices", tReg);
  verifier("D4 le meme module retire refuse toujours une LECTURE du domaine (403) : le refus par operation ne remplace pas la garde des autres routes", lecture.status === 403, lecture.status);
  await sql(`UPDATE users SET "modulesAutorises" = '{inspections}' WHERE id = $1`, reg.id);
  const p7 = await push(tReg, devReg.id, [{ ...opM1, payload: opDefaut(T2).payload }]);
  verifier("D4 module rendu : le renvoi explicite de l'operation refusee est reevalue et appliquee", p7.body.resultats?.[0]?.statut === "SYNCHRONISE" && await nbDefauts(opM1.entityId) === 1, p7.body.resultats);

  // Mission non assignee : refus de la famille « droits », motif historique conserve.
  const opMis = opObs(mAutre.id);
  const pMis = await push(tAgent, devAgent.id, [opMis]);
  verifier("D4 mission non assignee a l'agent : REJETE `MISSION_NON_AUTORISEE` (motif historique conserve, famille droits), definitif, trace en base, compte dans `refusDroits`",
    pMis.body.resultats?.[0]?.motif === "MISSION_NON_AUTORISEE" && !("reessayerDansMs" in pMis.body.resultats[0]) && pMis.body.refusDroits === 1
    && (await ligneOp(opMis.operationId))?.derniereErreur === "MISSION_NON_AUTORISEE", pMis.body);
  const opNeutre = opObs(null);
  const pNeutre = await push(tAgent, devAgent.id, [opNeutre]);
  verifier("D4 contre-epreuve : une observation sans mission imposee passe (SYNCHRONISE) pour le meme agent", pNeutre.body.resultats?.[0]?.statut === "SYNCHRONISE", pNeutre.body);

  // Compte inactif : rien n'est ecrit.
  await sql(`UPDATE users SET actif = false WHERE id = $1`, reg.id);
  const opIn = opDefaut(T2);
  const pIn = await push(tReg, devReg.id, [opIn]);
  await sql(`UPDATE users SET actif = true WHERE id = $1`, reg.id);
  verifier("D4 sync/push d'un compte DESACTIVE : 401 COMPTE_INACTIF, aucune ligne operations_sync, aucun defaut",
    pIn.status === 401 && pIn.body.code === "COMPTE_INACTIF" && await nbOps(opIn.operationId) === 0 && await nbDefauts(opIn.entityId) === 0, pIn.body);

  // ================================================================ D5. Evenements locaux
  console.log("\n== D5. POST /api/auth/evenements-locaux ==");
  const evt = (evenement: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), evenement, horodatageClient: "2000-01-01T00:00:00.000Z", ...extra });
  const tEv = jeton(autre);
  const e1 = evt("OUVERTURE_HORS_LIGNE"), e2 = evt("ECHEC_DEVERROUILLAGE", { occurrences: 4 }), e3 = evt("DEVERROUILLAGE");
  const nbEv = (userId: string) => compter(`SELECT count(*) n FROM audit_logs WHERE "entityType" = 'EvenementLocal' AND "userId" = $1`, userId);
  const ev1 = await appeler("post", "/api/auth/evenements-locaux", tEv, { appareilId: devAutre.id, evenements: [e1, e2, e3] });
  verifier("D5 un lot de trois evenements est enregistre : 200 { recus 3, enregistres 3, dejaConnus 0 }, trois lignes SECURITY_EVENT en base",
    ev1.status === 200 && ev1.body.recus === 3 && ev1.body.enregistres === 3 && ev1.body.dejaConnus === 0 && await nbEv(autre.id) === 3, ev1.body);
  const ligne1 = (await sql<{ action: string; entityId: string; after: Record<string, unknown>; ipAddress: string | null; createdAt: Date }>(
    `SELECT action::text AS action, "entityId", after, "ipAddress", "createdAt" FROM audit_logs WHERE "entityType" = 'EvenementLocal' AND "entityId" = $1`, e2.id))[0];
  verifier("D5 la ligne porte l'evenement, l'horodatage client MARQUE NON FIABLE (2000-01-01 conserve tel quel), l'appareil, les occurrences, l'adresse vue par le serveur ; l'heure qui fait foi est celle du serveur",
    ligne1.action === "SECURITY_EVENT" && ligne1.after.evenement === "ECHEC_DEVERROUILLAGE" && ligne1.after.horodatageClient === "2000-01-01T00:00:00.000Z" && ligne1.after.horodatageClientFiable === false
    && ligne1.after.appareilId === devAutre.id && ligne1.after.appareilReconnu === true && ligne1.after.occurrences === 4 && !!ligne1.ipAddress && ligne1.createdAt.getUTCFullYear() >= 2026, ligne1);
  verifier("D5 aucune donnee de contenu : la ligne ne porte que les champs prevus (pas de PIN, pas de payload)",
    Object.keys(ligne1.after).sort().join(",") === "appareilId,appareilReconnu,appareilRevoque,evenement,horodatageClient,horodatageClientFiable,occurrences", Object.keys(ligne1.after));
  const ev2 = await appeler("post", "/api/auth/evenements-locaux", tEv, { appareilId: devAutre.id, evenements: [e1, e2, e3] });
  verifier("D5 IDEMPOTENCE : rejouer le MEME lot n'ajoute aucune ligne (enregistres 0, dejaConnus 3)", ev2.body.enregistres === 0 && ev2.body.dejaConnus === 3 && await nbEv(autre.id) === 3, ev2.body);

  // Le debit court est de 5 lots par 15 minutes et par compte (D9, point 3) : le banc remet le limiteur a zero entre ses groupes de
  // verifications (le limiteur lui-meme est eprouve plus bas).
  _reinitialiserLimiteEvenementsLocaux();
  const lotConcurrent = { evenements: Array.from({ length: 5 }, () => evt("DEVERROUILLAGE")) };
  const avantConc = await nbEv(autre.id);
  const concurrents = await Promise.all(Array.from({ length: 5 }, () => appeler("post", "/api/auth/evenements-locaux", tEv, lotConcurrent)));
  verifier("D5 cinq rejeux SIMULTANES (le debit court est de 5 lots) du meme lot de cinq evenements : exactement cinq lignes de plus (le verrou par compte serialise les rejeux)",
    concurrents.every((r) => r.status === 200) && await nbEv(autre.id) - avantConc === 5 && concurrents.reduce((s, r) => s + r.body.enregistres, 0) === 5,
    [concurrents.map((r) => r.status), concurrents.map((r) => r.body.enregistres), await nbEv(autre.id) - avantConc]);

  _reinitialiserLimiteEvenementsLocaux();
  const avantRefus = await nbEv(autre.id);
  const refus = async (corps: unknown) => { _reinitialiserLimiteEvenementsLocaux(); return (await appeler("post", "/api/auth/evenements-locaux", tEv, corps)).status; };
  const statutsRefus = [
    await refus({ evenements: [evt("SUPPRESSION_ADMIN")] }),
    await refus({ evenements: Array.from({ length: 51 }, () => evt("DEVERROUILLAGE")) }),
    await refus({ evenements: [{ ...evt("DEVERROUILLAGE"), pin: "123456" }] }),
    await refus({ evenements: [{ ...evt("DEVERROUILLAGE"), horodatageClient: "x".repeat(500) }] }),
    await refus({ evenements: [{ ...evt("DEVERROUILLAGE"), id: "pas-un-uuid" }] }),
    await refus({ evenements: [evt("DEVERROUILLAGE")], payload: { x: 1 } }),
  ];
  verifier("D5 BORNES : evenement hors liste, lot de 51, champ inconnu (un PIN), horodatage de 500 caracteres, identifiant non UUID, champ inconnu sur le lot : six refus 400, RIEN d'ecrit",
    statutsRefus.every((s) => s === 400) && await nbEv(autre.id) === avantRefus, statutsRefus);
  const pinAilleurs = await compter(`SELECT count(*) n FROM audit_logs WHERE after::text LIKE '%123456%'`);
  verifier("D5 le PIN envoye dans un lot refuse n'apparait nulle part dans le journal", pinAilleurs === 0, pinAilleurs);
  _reinitialiserLimiteEvenementsLocaux();
  const evAutrui = await appeler("post", "/api/auth/evenements-locaux", tEv, { appareilId: devAgent.id, evenements: [evt("SESSION_LOCALE_FERMEE")] });
  const ligneAutrui = (await sql<{ after: Record<string, unknown> }>(`SELECT after FROM audit_logs WHERE "entityType" = 'EvenementLocal' AND "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, autre.id))[0];
  verifier("D5 un appareil qui n'est pas celui du compte n'est pas attribue (appareilId nul, appareilReconnu faux) : un identifiant n'est pas une autorisation",
    evAutrui.status === 200 && ligneAutrui.after.appareilId === null && ligneAutrui.after.appareilReconnu === false, ligneAutrui);
  const sansJeton = await request(app).post("/api/auth/evenements-locaux").send({ evenements: [evt("DEVERROUILLAGE")] });
  verifier("D5 la route est authentifiee : sans jeton, 401", sansJeton.status === 401, sansJeton.status);
  const evRevoque = await appeler("post", "/api/auth/evenements-locaux", tAgent, { appareilId: D, evenements: [evt("SESSION_LOCALE_EXPIREE")] });
  const ligneRevoque = (await sql<{ after: Record<string, unknown> }>(`SELECT after FROM audit_logs WHERE "entityType" = 'EvenementLocal' AND "userId" = $1`, agent.id))[0];
  verifier("D5 un appareil REVOQUE du compte peut encore remonter ses evenements (fait d'audit, pas un droit) : la ligne le marque appareilRevoque",
    evRevoque.status === 200 && ligneRevoque.after.appareilId === D && ligneRevoque.after.appareilRevoque === true, [evRevoque.status, ligneRevoque]);
  let dernier = 200;
  const tBoucle = jeton(chef);
  for (let i = 0; i < 40 && dernier !== 429; i++) dernier = (await appeler("post", "/api/auth/evenements-locaux", tBoucle, { evenements: [evt("DEVERROUILLAGE")] })).status;
  const autreApres = await appeler("post", "/api/auth/evenements-locaux", jeton(admin), { evenements: [evt("DEVERROUILLAGE")] });
  verifier("D5 apres au plus 40 lots, le compte qui boucle est coupe (429) ; un autre compte, pas", dernier === 429 && autreApres.status === 200, [dernier, autreApres.status]);

  // D9, point 3 : horodatage ISO strict, debit court de 5 lots, plafond journalier par compte.
  _reinitialiserLimiteEvenementsLocaux();
  const tAdmin = jeton(admin);
  const avantPiege = await nbEv(admin.id);
  const piege = await appeler("post", "/api/auth/evenements-locaux", tAdmin, { evenements: [{ ...evt("DEVERROUILLAGE"), horodatageClient: "<img src=x onerror=alert(1)> 1" }] });
  verifier("D9 point 3 : un horodatage client qui n'est pas une date ISO 8601 (« <img ...> 1 », 30 caracteres que Date.parse acceptait) est refuse en entier (400) et rien n'est ecrit",
    piege.status === 400 && await nbEv(admin.id) === avantPiege && await compter(`SELECT count(*) n FROM audit_logs WHERE after::text LIKE '%<img%'`) === 0, [piege.status, piege.body]);
  const plafonne = await mkUser("plafond@sa.invalid", "LECTEUR", []);
  const tPlaf = jeton(plafonne);
  await sql(`INSERT INTO audit_logs (id, "userId", action, "entityType", "entityId", after, "createdAt")
             SELECT gen_random_uuid()::text, $1, 'SECURITY_EVENT', 'EvenementLocal', gen_random_uuid()::text, '{}'::jsonb, now() - interval '1 hour' FROM generate_series(1, $2::int)`,
    plafonne.id, EVENEMENTS_LOCAUX_MAX_PAR_JOUR - 3);
  const plafRefus = await appeler("post", "/api/auth/evenements-locaux", tPlaf, { evenements: Array.from({ length: 4 }, () => evt("DEVERROUILLAGE")) });
  const avantPlaf = await nbEv(plafonne.id);
  verifier("D9 point 3 : un lot qui ferait depasser le plafond journalier (500 lignes / 24 h / compte) est refuse EN ENTIER : 429 PLAFOND_JOURNALIER_ATTEINT, restant annonce, aucune ligne ajoutee",
    plafRefus.status === 429 && plafRefus.body.code === "PLAFOND_JOURNALIER_ATTEINT" && plafRefus.body.restantSurLes24Heures === 3 && avantPlaf === EVENEMENTS_LOCAUX_MAX_PAR_JOUR - 3, [plafRefus.status, plafRefus.body, avantPlaf]);
  const plafOk = await appeler("post", "/api/auth/evenements-locaux", tPlaf, { evenements: Array.from({ length: 3 }, () => evt("DEVERROUILLAGE")) });
  const plafApres = await appeler("post", "/api/auth/evenements-locaux", tPlaf, { evenements: [evt("DEVERROUILLAGE")] });
  verifier("D9 point 3 : le lot qui tient exactement dans le reste passe (200), le suivant est refuse (429, restant 0) ; un autre compte n'est pas touche",
    plafOk.status === 200 && plafOk.body.enregistres === 3 && plafApres.status === 429 && plafApres.body.restantSurLes24Heures === 0
    && (await appeler("post", "/api/auth/evenements-locaux", tAdmin, { evenements: [evt("DEVERROUILLAGE")] })).status === 200, [plafOk.status, plafApres.status, plafApres.body]);
  // Concurrence : deux lots simultanes qui tiennent chacun dans le reste mais pas ensemble ne depassent jamais le plafond (verrou par compte).
  const concurrent = await mkUser("plafond2@sa.invalid", "LECTEUR", []);
  await sql(`INSERT INTO audit_logs (id, "userId", action, "entityType", "entityId", after, "createdAt")
             SELECT gen_random_uuid()::text, $1, 'SECURITY_EVENT', 'EvenementLocal', gen_random_uuid()::text, '{}'::jsonb, now() FROM generate_series(1, $2::int)`,
    concurrent.id, EVENEMENTS_LOCAUX_MAX_PAR_JOUR - 5);
  const deux = await Promise.all([1, 2].map(() => appeler("post", "/api/auth/evenements-locaux", jeton(concurrent), { evenements: Array.from({ length: 4 }, () => evt("DEVERROUILLAGE")) })));
  verifier("D9 point 3 : deux lots de 4 simultanes avec 5 places restantes : un seul passe (200), l'autre est refuse (429) ; le plafond n'est jamais depasse",
    deux.map((r) => r.status).sort().join() === "200,429" && await nbEv(concurrent.id) === EVENEMENTS_LOCAUX_MAX_PAR_JOUR - 1, [deux.map((r) => r.status), await nbEv(concurrent.id)]);
  _reinitialiserLimiteEvenementsLocaux();
  const courts: number[] = [];
  for (let i = 0; i < EVENEMENTS_LOCAUX_LOTS_PAR_FENETRE + 2; i++) courts.push((await appeler("post", "/api/auth/evenements-locaux", jeton(agent), { evenements: [evt("DEVERROUILLAGE")] })).status);
  verifier(`D9 point 3 : le debit court est de ${EVENEMENTS_LOCAUX_LOTS_PAR_FENETRE} lots par fenetre et par compte : ${EVENEMENTS_LOCAUX_LOTS_PAR_FENETRE} lots passent, les suivants sont coupes (429)`,
    courts.slice(0, EVENEMENTS_LOCAUX_LOTS_PAR_FENETRE).every((c) => c === 200) && courts.slice(EVENEMENTS_LOCAUX_LOTS_PAR_FENETRE).every((c) => c === 429), courts);
  _reinitialiserLimiteEvenementsLocaux();

  // D9, point 4 : sync/push d'un compte dont le module est retire.
  console.log("\n== D9 point 4. sync/push : module retire, type libre, budget de traces ==");
  const sansModule = await mkUser("sansmodule@sa.invalid", "INSPECTEUR", ["inspections"]);
  const devSansModule = await prisma.appareil.create({ data: { userId: sansModule.id, nom: "tel sans module", plateforme: "android" } });
  await sql(`UPDATE users SET "modulesAutorises" = '{}' WHERE id = $1`, sansModule.id);
  const tSM = jeton(sansModule);
  const piegeType = "<script>alert(1)</script>".padEnd(64, "x").slice(0, 64);
  const avantOps = await compter(`SELECT count(*) n FROM operations_sync WHERE "userId" = $1`, sansModule.id);
  const lotLibre = Array.from({ length: 100 }, (_, i) => ({ operationId: randomUUID(), entityType: i % 2 ? piegeType : "Z".repeat(64), entityId: "e".repeat(64), operation: "CREATE" as const, payload: { secret: "contenu-sensible" } }));
  const pLibre = await push(tSM, devSansModule.id, lotLibre);
  verifier("D9 point 4 : un type d'entite INCONNU rend TYPE_NON_SUPPORTE sans AUCUNE ecriture (100 operations, 0 ligne operations_sync) et le type libre n'est jamais persiste",
    pLibre.status === 200 && pLibre.body.resultats.every((r: { motif: string }) => r.motif.startsWith("TYPE_NON_SUPPORTE:"))
    && await compter(`SELECT count(*) n FROM operations_sync WHERE "userId" = $1`, sansModule.id) === avantOps
    && await compter(`SELECT count(*) n FROM operations_sync WHERE "entityType" LIKE '%<script>%'`) === 0, [pLibre.status, pLibre.body.refusNonTraces, pLibre.body.resultats?.[0]]);
  const lotConnu = Array.from({ length: 100 }, () => { const id = randomUUID(); return { operationId: id, entityType: "Defaut", entityId: id, operation: "CREATE" as const, payload: { secret: "contenu-sensible-ne-doit-pas-rester", catalogueCode: "NID_SA" } }; });
  const pConnu = await push(tSM, devSansModule.id, lotConnu);
  const tracees = await compter(`SELECT count(*) n FROM operations_sync WHERE "userId" = $1 AND "derniereErreur" = 'DROITS_MODIFIES:MODULE_RETIRE'`, sansModule.id);
  const uniformes = new Set(pConnu.body.resultats.map((r: { motif: string; cause: string; definitif: boolean }) => `${r.motif}|${r.cause}|${r.definitif}`));
  verifier("D9 point 4 : 100 operations refusees pour module retire : 20 lignes tracees au plus (budget), 80 rendues avec le MEME motif/cause/definitif sans trace (refusNonTraces 80), refusDroits 100",
    pConnu.status === 200 && tracees === 20 && pConnu.body.refusNonTraces === 80 && pConnu.body.refusDroits === 100 && uniformes.size === 1 && uniformes.has("DROITS_MODIFIES|MODULE_RETIRE|true"), [pConnu.status, tracees, pConnu.body.refusNonTraces, [...uniformes]]);
  verifier("D9 point 4 : les lignes tracees ont leur contenu caviarde (rien de sensible dans operations_sync)",
    await compter(`SELECT count(*) n FROM operations_sync WHERE "userId" = $1 AND payload::text LIKE '%contenu-sensible%'`, sansModule.id) === 0
    && await compter(`SELECT count(*) n FROM operations_sync WHERE "userId" = $1 AND payload = '{"redacted": true}'::jsonb`, sansModule.id) === 20);
  // Un refus non trace, renvoye apres retablissement du module, est juge comme une operation neuve et appliquee.
  await sql(`UPDATE users SET "modulesAutorises" = '{inspections}' WHERE id = $1`, sansModule.id);
  const renvoi = lotConnu[99];
  const pRenvoi = await push(tSM, devSansModule.id, [{ ...renvoi, payload: opDefaut(T1).payload }]);
  verifier("D9 point 4 : un refus rendu SANS trace est renvoyable apres retablissement des droits (traite comme une operation neuve : SYNCHRONISE)", pRenvoi.body.resultats?.[0]?.statut === "SYNCHRONISE", pRenvoi.body.resultats);

  // ================================================================ D6. /auth/me
  console.log("\n== D6. GET /auth/me : droits effectifs lus en base ==");
  const tMe = jeton(chef);
  await sql(`UPDATE users SET "modulesAutorises" = '{inspections,geoportail}' WHERE id = $1`, chef.id);
  await sql(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $4), ($1, $3, $4)`, chef.id, R1, R2, admin.id);
  const me1 = await appeler("get", "/api/auth/me", tMe);
  await sql(`UPDATE users SET role = 'LECTEUR', "modulesAutorises" = '{geoportail}' WHERE id = $1`, chef.id);
  await sql(`DELETE FROM perimetres_comptes WHERE "userId" = $1 AND "regionId" = $2`, chef.id, R2);
  const me2 = await appeler("get", "/api/auth/me", tMe);
  verifier("D6 /auth/me rend role, modules et regions effectifs, lus en base (GESTIONNAIRE, deux modules, R1 et R2)",
    me1.status === 200 && me1.body.user.role === "GESTIONNAIRE" && me1.body.user.modulesAutorises.join() === "inspections,geoportail" && me1.body.user.regions.join() === [R1, R2].sort((a, b) => a - b).join() && me1.body.user.perimetreNational === false, me1.body);
  verifier("D6 apres changement en base, le MEME jeton rend les nouveaux droits (LECTEUR, un module, R1 seule) : le client detecte le changement a la reconnexion",
    me2.body.user.role === "LECTEUR" && me2.body.user.modulesAutorises.join() === "geoportail" && me2.body.user.regions.join() === String(R1) && me2.body.user.perimetreNational === false, me2.body);
  const meNat = await appeler("get", "/api/auth/me", jeton(agent));
  verifier("D6 un compte sans rattachement est NATIONAL : regions vide ET perimetreNational vrai ; champs historiques toujours presents",
    meNat.body.user.regions.length === 0 && meNat.body.user.perimetreNational === true && "totpEnabled" in meNat.body.user && "peutDeleguerValidation" in meNat.body.user, meNat.body);

  // ================================================================ D7. Course revocation / rotation du rafraichissement (D9, point 1)
  console.log("\n== D7. Course revocation d'appareil / rotation du rafraichissement ==");
  // Fixtures directes (pas de mot de passe a hacher) : un compte, un appareil, une famille de rafraichissement vivante.
  const vivants = (userId: string) => compter(`SELECT count(*) n FROM refresh_tokens WHERE "userId" = $1 AND "revokedAt" IS NULL`, userId);
  const creerCourse = async (nom: string) => {
    const u = await mkUser(`${nom}@sa.invalid`, "INSPECTEUR", ["inspections"]);
    const d = await prisma.appareil.create({ data: { userId: u.id, nom: `tel ${nom}`, plateforme: "android" } });
    const brut = signRefreshToken(u.id);
    const ligne = await prisma.refreshToken.create({ data: { tokenHash: hashRefreshToken(brut), familyId: randomUUID(), userId: u.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
    return { u, d, brut, ligne, jeton: jeton(u) };
  };
  const rafraichir = (brut: string) => request(app).post("/api/auth/refresh").send({ refreshToken: brut });
  const revoquer = (j: string, appareilId: string) => appeler("post", `/api/v2/devices/${appareilId}/revoke`, j);
  const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const enAttente = async <T,>(p: Promise<T>, ms: number): Promise<boolean> => (await Promise.race([p.then(() => false), attendre(ms).then(() => true)]));
  const SQL_PAUSE = (nom: string, table: string, quand: string, cle: number) => async (activer: boolean) => {
    if (!activer) { await sql(`DROP TRIGGER IF EXISTS ${nom} ON ${table}`); await sql(`DROP FUNCTION IF EXISTS ${nom}()`); return; }
    await sql(`CREATE OR REPLACE FUNCTION ${nom}() RETURNS trigger AS $$ BEGIN PERFORM pg_advisory_xact_lock(${cle}); RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await sql(`CREATE TRIGGER ${nom} BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${quand}) EXECUTE FUNCTION ${nom}()`);
  };
  const attendreBloque = async (cle: number) => { // la requete du code reel est arrivee au declencheur et attend le verrou tenu par le banc
    for (let i = 0; i < 100; i++) {
      if (await compter(`SELECT count(*) n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid = $1`, cle) >= 1) return true;
      await attendre(50);
    }
    return false;
  };

  // --- Banc DETERMINISTE n°1 : la rotation est EN VOL (jeton consomme, nouveau jeton insere, transaction non commitee) quand la
  // revocation arrive. Le code reel des deux cotes ; une transaction PostgreSQL du banc tient la rotation ouverte (le declencheur
  // d'insertion attend un verrou consultatif que le banc detient), comme le fait le script du relecteur avec ses ordres SQL.
  {
    const c = await creerCourse("course-rotation-en-vol");
    const pause = SQL_PAUSE("sa_pause_rotation", "refresh_tokens", `NEW."userId" = '${c.u.id}'`, 424242);
    await pause(true);
    const pgBanc = new ClientPg({ connectionString: banc.urlClone });
    await pgBanc.connect();
    try {
      await pgBanc.query("BEGIN");
      await pgBanc.query("SELECT pg_advisory_xact_lock(424242)");
      const rotation = rafraichir(c.brut).then((r: Rep) => r);
      const bloquee = await attendreBloque(424242);
      const revocation = revoquer(c.jeton, c.d.id).then((r: Rep) => r);
      const revocationAttend = await enAttente(revocation, 800);
      await pgBanc.query("COMMIT");
      const [rot, rev] = await Promise.all([rotation, revocation]);
      const restants = await vivants(c.u.id);
      verifier("D7 [deterministe] la rotation est bien EN VOL (jeton consomme, insertion en attente) quand la revocation arrive, et la revocation ATTEND la fin de la rotation",
        bloquee && revocationAttend, { bloquee, revocationAttend });
      verifier("D7 [deterministe] APRES le commit de la rotation : la revocation repond 200 et AUCUN jeton de rafraichissement ne reste vivant (avant le correctif : 200 `sessions: 0` et un jeton vivant)",
        rev.status === 200 && restants === 0 && rev.body.rafraichissement?.sessions === 1, { rotation: rot.status, revocation: rev.status, sessions: rev.body.rafraichissement?.sessions, vivants: restants });
      verifier("D7 [deterministe] la rotation en vol a abouti (200) : le client a recu un nouveau jeton, et ce jeton est deja mort (401 au rafraichissement suivant)",
        rot.status === 200 && !!rot.body.refreshToken && (await rafraichir(rot.body.refreshToken)).status === 401, rot.status);
    } finally {
      await pgBanc.query("ROLLBACK").catch(() => undefined);
      await pgBanc.end();
      await pause(false);
    }
  }

  // --- Banc DETERMINISTE n°2 : l'ordre inverse. La revocation est EN VOL (verrou du compte pris, jetons coupes, trace en attente)
  // quand la rotation arrive : elle attend, relit son jeton, le trouve revoque et refuse (401). Pas d'interblocage (500).
  {
    const c = await creerCourse("course-revocation-en-vol");
    const pause = SQL_PAUSE("sa_pause_revocation", "audit_logs", `NEW."entityType" = 'Appareil' AND NEW.action = 'SECURITY_EVENT' AND NEW."entityId" = '${c.d.id}'`, 424243);
    await pause(true);
    const pgBanc = new ClientPg({ connectionString: banc.urlClone });
    await pgBanc.connect();
    try {
      await pgBanc.query("BEGIN");
      await pgBanc.query("SELECT pg_advisory_xact_lock(424243)");
      const revocation = revoquer(c.jeton, c.d.id).then((r: Rep) => r);
      const bloquee = await attendreBloque(424243);
      const rotation = rafraichir(c.brut).then((r: Rep) => r);
      const rotationAttend = await enAttente(rotation, 800);
      await pgBanc.query("COMMIT");
      const [rev, rot] = await Promise.all([revocation, rotation]);
      verifier("D7 [deterministe, ordre inverse] la revocation en vol tient le compte : la rotation ATTEND, puis est refusee (401) car son jeton est revoque ; revocation 200 ; aucun jeton vivant ; aucun interblocage (pas de 500)",
        bloquee && rotationAttend && rev.status === 200 && rot.status === 401 && await vivants(c.u.id) === 0, { bloquee, rotationAttend, revocation: rev.status, rotation: rot.status, vivants: await vivants(c.u.id) });
    } finally {
      await pgBanc.query("ROLLBACK").catch(() => undefined);
      await pgBanc.end();
      await pause(false);
    }
  }

  // --- Non-regression de la rotation normale.
  {
    const c = await creerCourse("rotation-normale");
    const r1 = await rafraichir(c.brut);
    const r2 = r1.status === 200 ? await rafraichir(r1.body.refreshToken) : r1;
    verifier("D7 non-regression : un rafraichissement seul fonctionne (200), tourne, et le nouveau jeton fonctionne a son tour ; un seul jeton vivant a chaque instant",
      r1.status === 200 && r2.status === 200 && await vivants(c.u.id) === 1, [r1.status, r2.status, await vivants(c.u.id)]);
    const d = await creerCourse("deux-rotations-meme-jeton");
    const [a, b] = await Promise.all([rafraichir(d.brut), rafraichir(d.brut)]);
    const statuts = [a.status, b.status].sort();
    verifier("D7 non-regression : deux rafraichissements du MEME jeton en parallele restent regles comme avant : un seul gagne (200), l'autre est une reutilisation (401), la famille est coupee (aucun jeton vivant), jamais de 500",
      statuts[0] === 200 && statuts[1] === 401 && await vivants(d.u.id) === 0, { statuts, vivants: await vivants(d.u.id) });
    // Deux rotations de jetons DIFFERENTS du meme compte ne se bloquent pas (FOR SHARE est compatible avec FOR SHARE).
    const e = await creerCourse("deux-familles");
    const brut2 = signRefreshToken(e.u.id);
    await prisma.refreshToken.create({ data: { tokenHash: hashRefreshToken(brut2), familyId: randomUUID(), userId: e.u.id, expiresAt: new Date(Date.now() + 86_400_000) } });
    const [x, y] = await Promise.all([rafraichir(e.brut), rafraichir(brut2)]);
    verifier("D7 non-regression : deux familles du meme compte tournent en parallele sans se bloquer (200 et 200)", x.status === 200 && y.status === 200 && await vivants(e.u.id) === 2, [x.status, y.status]);
  }

  // --- Repetition HTTP PARALLELE : la vraie course, sans aucune main sur les verrous. Avant le correctif : 21 a 25 essais sur 40 laissaient un jeton vivant.
  {
    const ESSAIS = Number(process.env.D7_ESSAIS ?? 100);
    let vivantsApres = 0, erreurs500 = 0, revocationsKo = 0, revocationAvant = 0;
    const statutsRotation: Record<number, number> = {};
    for (let i = 0; i < ESSAIS; i++) {
      const c = await creerCourse(`essai-${i}`);
      // L'ordre d'arrivee varie : parfois la rotation part la premiere, parfois la revocation, avec un decalage de 0 a 30 ms.
      const decalage = Math.floor(Math.random() * 31);
      const revocationDabord = Math.random() < 0.4;
      const [rot, rev] = await Promise.all([
        revocationDabord ? attendre(decalage).then(() => rafraichir(c.brut)) : rafraichir(c.brut),
        revocationDabord ? revoquer(c.jeton, c.d.id) : attendre(decalage).then(() => revoquer(c.jeton, c.d.id)),
      ]);
      if (revocationDabord) revocationAvant++;
      statutsRotation[rot.status] = (statutsRotation[rot.status] ?? 0) + 1;
      if (rot.status >= 500 || rev.status >= 500) erreurs500++;
      if (rev.status !== 200) revocationsKo++;
      if (await vivants(c.u.id) > 0) vivantsApres++;
    }
    console.log(`  (info) ${ESSAIS} essais paralleles (revocation partie d'abord dans ${revocationAvant}) : statuts du rafraichissement ${JSON.stringify(statutsRotation)} ; jetons vivants apres la revocation : ${vivantsApres}/${ESSAIS} ; erreurs 5xx : ${erreurs500}`);
    verifier(`D7 repetition HTTP parallele (${ESSAIS} essais, ordres et decalages varies) : AUCUN jeton de rafraichissement vivant apres la revocation (0/${ESSAIS}), toutes les revocations 200, aucune erreur 5xx (pas d'interblocage)`,
      vivantsApres === 0 && revocationsKo === 0 && erreurs500 === 0, { vivantsApres, revocationsKo, erreurs500 });
  }

  // ================================================================ COUT mesure
  console.log("\n== Cout de la lecture du compte (base locale, ordre de grandeur seulement) ==");
  const N = 2000;
  const lectures: number[] = [];
  for (let i = 0; i < 50; i++) await prisma.user.findUnique({ where: { id: agent.id }, select: { actif: true, lockedUntil: true, role: true, email: true } });
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    await prisma.user.findUnique({ where: { id: agent.id }, select: { actif: true, lockedUntil: true, role: true, email: true } });
    lectures.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const coutLecture = { mediane: arrondi(mediane(lectures)), p95: arrondi(centile(lectures, 0.95)), p99: arrondi(centile(lectures, 0.99)) };
  console.log(`  lecture users par cle primaire (quatre colonnes), ${N} appels : mediane ${coutLecture.mediane} ms, p95 ${coutLecture.p95} ms, p99 ${coutLecture.p99} ms`);

  const M = 400;
  const avecBase: number[] = [], sansBase: number[] = [];
  const sansLecture = async () => ({ actif: true, lockedUntil: null, role: "INSPECTEUR", email: agent.email });
  for (let i = 0; i < 40; i++) await appeler("get", "/api/v2/devices", tAgent);
  for (let i = 0; i < M; i++) {
    authMw._installerResolveurCompte(sansLecture);
    let t0 = process.hrtime.bigint();
    await appeler("get", "/api/v2/devices", tAgent);
    sansBase.push(Number(process.hrtime.bigint() - t0) / 1e6);
    authMw._installerResolveurCompte(null);
    t0 = process.hrtime.bigint();
    await appeler("get", "/api/v2/devices", tAgent);
    avecBase.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  authMw._installerResolveurCompte(null);
  console.log(`  GET /api/v2/devices de bout en bout, ${M} appels alternes : sans lecture du compte mediane ${arrondi(mediane(sansBase))} ms (p95 ${arrondi(centile(sansBase, 0.95))}), avec lecture mediane ${arrondi(mediane(avecBase))} ms (p95 ${arrondi(centile(avecBase, 0.95))})`);
  // Mesure, pas verification : ces chiffres dependent du poste (ici Docker Desktop sous Windows, port publie) et ne valent pas la production.
  console.log(`  surcout median de bout en bout : ${arrondi(mediane(avecBase) - mediane(sansBase))} ms (a comparer a la lecture seule ci-dessus)`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { conclure(); await prisma.$disconnect(); await banc.fermer(); });
