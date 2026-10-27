import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import * as argon2 from "argon2";
import { Client } from "pg";
import path from "node:path";
import { DOSSIER_API, DOSSIER_RUN, FICHIER_RUN, NOM_BASE, NOM_MODELE } from "./env";

/**
 * Fabrique et detruit la base `essai_e2e`, clone de `replay`, et y sème le jeu de donnees minimal.
 *
 * GARDES, dans l'esprit de `backend/tests-integration/lib/garde.ts`
 *   - l'hote doit etre la machine locale ;
 *   - la seule base creee ou detruite ici s'appelle `essai_e2e` (constante, jamais un parametre) ;
 *   - `replay` n'est que LU, comme modele de `CREATE DATABASE ... TEMPLATE` ; elle n'est jamais modifiee.
 *
 * IDENTIFIANTS. Les mots de passe sont tires au hasard a chaque lancement et ecrits dans
 * `<dossier temporaire>/bdri-e2e/run.json`, hors du depot. Les specs les lisent la. Ni ce fichier ni les
 * specs ne contiennent de mot de passe.
 */

const HOTES_LOCAUX = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** `pin` : code de la session locale hors ligne (tire au hasard, comme le mot de passe, jamais ecrit dans le depot). */
export interface CompteRun { id: string; email: string; motDePasse: string; pin: string; nomComplet: string; role: string }
export const NOMS_COMPTES = ["admin", "gestionnaire", "agentA", "agentB", "agentC", "agentD", "agentE"] as const;
export type NomCompte = (typeof NOMS_COMPTES)[number];
export interface TronconRun { id: string; code: string; nom: string }
export interface DonneesRun {
  urlBase: string;
  dossierTeleversements: string;
  secretAcces: string;
  secretRafraichissement: string;
  comptes: Record<NomCompte, CompteRun>;
  troncons: TronconRun[];
}

interface ParametresPg { hote: string; port: number; utilisateur: string; motDePasse: string }

/**
 * Parametres de connexion au PostgreSQL de developpement.
 * `E2E_PG_URL` (une URL postgresql:// locale, nom de base libre) prime ; sinon on les lit dans le conteneur
 * `bdri-dev-db` (variables POSTGRES_USER / POSTGRES_PASSWORD), sans jamais les afficher.
 */
function parametresPg(): ParametresPg {
  const explicite = process.env.E2E_PG_URL;
  if (explicite) {
    const u = new URL(explicite);
    return {
      hote: u.hostname, port: Number(u.port || 5432),
      utilisateur: decodeURIComponent(u.username), motDePasse: decodeURIComponent(u.password),
    };
  }
  const conteneur = process.env.E2E_PG_CONTENEUR ?? "bdri-dev-db";
  let env = "";
  try {
    env = execFileSync("docker", ["inspect", conteneur, "--format", "{{range .Config.Env}}{{println .}}{{end}}"], {
      encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    });
  } catch {
    throw new Error(`Conteneur "${conteneur}" illisible : demarrer Docker et le conteneur, ou definir E2E_PG_URL (voir docs/e2e/README.md).`);
  }
  const lire = (cle: string) => env.split(/\r?\n/).find((l) => l.startsWith(`${cle}=`))?.slice(cle.length + 1);
  const utilisateur = lire("POSTGRES_USER");
  const motDePasse = lire("POSTGRES_PASSWORD");
  if (!utilisateur || !motDePasse) throw new Error(`Variables POSTGRES_USER / POSTGRES_PASSWORD introuvables dans ${conteneur}.`);
  return { hote: "127.0.0.1", port: Number(process.env.E2E_PG_PORT ?? 5434), utilisateur, motDePasse };
}

function exigerLocal(p: ParametresPg): void {
  if (!HOTES_LOCAUX.has(p.hote)) throw new Error(`Hote PostgreSQL non local refuse : ${p.hote}`);
}

function url(p: ParametresPg, base: string): string {
  return `postgresql://${encodeURIComponent(p.utilisateur)}:${encodeURIComponent(p.motDePasse)}@${p.hote}:${p.port}/${base}`;
}

async function avec<T>(connexion: string, f: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: connexion });
  await c.connect();
  try { return await f(c); } finally { await c.end(); }
}

// Un tableau vide vaut "aucun module" cote serveur (lib/access.ts) : un agent de terrain doit recevoir explicitement les modules
// dont il se sert. Liste du profil metier AGENT_TERRAIN (backend/src/lib/profils.ts) : socle de lecture + "inspections"
// (appareils, synchronisation, observations, defauts, photos). "geoportail" ouvre aussi les referentiels de qualification.
const MODULES_AGENT = ["dashboard", "geoportail", "troncons", "ouvrages", "inspections"];

const secret = (octets = 18) => randomBytes(octets).toString("base64url");

function compte(prefixe: string, nomComplet: string, role: string): CompteRun {
  // Domaine reserve `.invalid` (RFC 2606) : jamais une vraie adresse.
  return { id: randomUUID(), email: `${prefixe}@e2e.test.invalid`, motDePasse: secret(), pin: secret(9), nomComplet, role };
}

/** Tronçons de test : de courtes polylignes reelles pres de Conakry, assez pour porter une geometrie PostGIS. */
const TRONCONS = [
  { code: "E2E-RN1-01", nom: "E2E Conakry - Coyah", region: "Conakry", pkDebut: 0, pkFin: 12, longueurKm: 12,
    wkt: "LINESTRING(-13.7120 9.5090, -13.6800 9.5300, -13.6500 9.5600, -13.6100 9.5900)" },
  { code: "E2E-RN1-02", nom: "E2E Coyah - Kindia", region: "Kindia", pkDebut: 12, pkFin: 30, longueurKm: 18,
    wkt: "LINESTRING(-13.6100 9.5900, -13.5500 9.6500, -13.4800 9.7200, -13.4000 9.8000)" },
  { code: "E2E-RN2-01", nom: "E2E Kindia - Mamou", region: "Kindia", pkDebut: 0, pkFin: 20, longueurKm: 20,
    wkt: "LINESTRING(-12.9200 10.0400, -12.8600 10.0900, -12.8000 10.1500)" },
];

/** (Re)cree `essai_e2e` depuis `replay`, y seme le jeu minimal, ecrit `run.json`. */
export async function preparerBase(): Promise<DonneesRun> {
  const p = parametresPg();
  exigerLocal(p);

  await avec(url(p, "postgres"), async (c) => {
    // NOM_BASE et NOM_MODELE sont des constantes : aucune valeur externe n'entre dans ces ordres.
    await c.query(`DROP DATABASE IF EXISTS ${NOM_BASE} WITH (FORCE)`);
    // PostgreSQL refuse de copier un modele tant qu'une autre session y est connectee (un banc PostGIS qui lit `replay`, par
    // exemple) : on reessaie un moment avant de renoncer, plutot que d'echouer au hasard d'un travail parallele.
    for (let essai = 1; ; essai++) {
      try {
        await c.query(`CREATE DATABASE ${NOM_BASE} TEMPLATE ${NOM_MODELE}`);
        break;
      } catch (e) {
        const occupee = e instanceof Error && /being accessed by other users/i.test(e.message);
        if (!occupee || essai >= 24) throw e;
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  });

  const urlBase = `${url(p, NOM_BASE)}?schema=public`;
  // agentA et agentB : les agents ordinaires (deux comptes sur un meme appareil). agentC, agentD, agentE : un compte par scenario
  // dont l'etat serveur est modifie pendant le test (desactive, appareil revoque, module retire), pour ne jamais contaminer les autres.
  const comptes: Record<NomCompte, CompteRun> = {
    admin: compte("e2e-admin", "Admin E2E", "ADMIN"),
    gestionnaire: compte("e2e-gestionnaire", "Gestionnaire E2E", "GESTIONNAIRE"),
    agentA: compte("e2e-agent-a", "Agent A E2E", "INSPECTEUR"),
    agentB: compte("e2e-agent-b", "Agent B E2E", "INSPECTEUR"),
    agentC: compte("e2e-agent-c", "Agent C E2E", "INSPECTEUR"),
    agentD: compte("e2e-agent-d", "Agent D E2E", "INSPECTEUR"),
    agentE: compte("e2e-agent-e", "Agent E E2E", "INSPECTEUR"),
  };
  const troncons: TronconRun[] = [];

  await avec(url(p, NOM_BASE), async (c) => {
    const regions = new Map<string, number>();
    for (const nom of ["Conakry", "Kindia"]) {
      const r = await c.query<{ id: number }>(
        `INSERT INTO regions (nom) VALUES ($1) ON CONFLICT (nom) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`, [nom]);
      regions.set(nom, r.rows[0].id);
    }
    for (const u of Object.values(comptes)) {
      const hash = await argon2.hash(u.motDePasse, { type: argon2.argon2id });
      await c.query(
        `INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "modulesAutorises", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::"Role", $6::text[], now())`,
        [u.id, u.email, u.nomComplet, hash, u.role, MODULES_AGENT]);
    }
    for (const t of TRONCONS) {
      const id = randomUUID();
      await c.query(
        `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, etat, "pkDebut", "pkFin", geom, "updatedAt")
         VALUES ($1, $2, $3, 'RN'::"ClasseRoute", $4, $5, 'BITUME'::"Revetement", 'MOYEN'::"EtatPatrimoine", $6, $7,
                 ST_SetSRID(ST_GeomFromText($8), 4326), now())`,
        [id, t.code, t.nom, regions.get(t.region), t.longueurKm, t.pkDebut, t.pkFin, t.wkt]);
      troncons.push({ id, code: t.code, nom: t.nom });
    }
  });

  const donnees: DonneesRun = {
    urlBase, dossierTeleversements: path.join(DOSSIER_API, "uploads", "photos"), secretAcces: secret(32), secretRafraichissement: secret(32), comptes, troncons,
  };
  fs.mkdirSync(DOSSIER_RUN, { recursive: true });
  fs.writeFileSync(FICHIER_RUN, JSON.stringify(donnees), { mode: 0o600 });
  return donnees;
}

export function lireRun(): DonneesRun {
  if (!fs.existsSync(FICHIER_RUN)) throw new Error(`${FICHIER_RUN} absent : le lanceur de l'API n'a pas prepare la base.`);
  return JSON.parse(fs.readFileSync(FICHIER_RUN, "utf8")) as DonneesRun;
}

export function enregistrerRun(d: DonneesRun): void {
  fs.writeFileSync(FICHIER_RUN, JSON.stringify(d), { mode: 0o600 });
}

/** Detruit `essai_e2e` et ce qui a ete genere (identifiants, televersements). Les sorties de test sont gardees sauf demande. */
export async function nettoyer(avecSorties = false): Promise<void> {
  const p = parametresPg();
  exigerLocal(p);
  await avec(url(p, "postgres"), (c) => c.query(`DROP DATABASE IF EXISTS ${NOM_BASE} WITH (FORCE)`));
  fs.rmSync(FICHIER_RUN, { force: true });
  // Sous Windows, l'API tourne encore (webServer s'arrete apres le teardown) avec ce dossier pour repertoire courant : la
  // suppression peut etre refusee. Ce n'est pas une erreur, le lanceur suivant le recree et vide ce dossier.
  for (const cible of avecSorties ? [DOSSIER_RUN] : [DOSSIER_API]) {
    try { fs.rmSync(cible, { recursive: true, force: true }); } catch { /* voir ci-dessus */ }
  }
}
