import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import * as argon2 from "argon2";
import { Client } from "pg";
import { DOSSIER_RUN, FICHIER_RUN, NOM_BASE, NOM_MODELE } from "./env";

/**
 * Fabrique et detruit la base `essai_eo_e2e`, clone de `essai_eo_workflow`, et y seme le minimum (un ADMIN, deux regions).
 * Tout le reste (comptes, produits, propositions) passe par l'API REELLE dans global-setup.ts.
 *
 * GARDES, dans l'esprit de `backend/tests-integration/lib/garde.ts`
 *   - l'hote doit etre la machine locale ;
 *   - la seule base creee ou detruite ici s'appelle `essai_eo_e2e` (constante, jamais un parametre) et respecte `essai_<nom>` ;
 *   - le modele n'est que LU (`CREATE DATABASE ... TEMPLATE`), jamais modifie.
 *
 * IDENTIFIANTS. Les mots de passe sont tires au hasard a chaque lancement et ecrits dans `<dossier temporaire>/bdri-eo-e2e/run.json`
 * (droits du seul utilisateur), hors du depot. Ni ce fichier source ni les specs ne contiennent de mot de passe.
 */

const HOTES_LOCAUX = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const BASE_AUTORISEE = /^essai_[a-z0-9_]+$/;

export interface CompteRun { id: string; email: string; motDePasse: string; nomComplet: string; role: "ADMIN" | "GESTIONNAIRE" | "INSPECTEUR" | "LECTEUR" }

/**
 * Les sept comptes d'essai.
 * - admin : ADMIN (jamais restreint) ;
 * - gestNational : GESTIONNAIRE, module `teledetection`, aucun perimetre (= national) ;
 * - gestRegional : GESTIONNAIRE, module `teledetection`, perimetre = la region A ;
 * - inspecteur, lecteur : module `teledetection`, consultation seule ;
 * - sansModule : GESTIONNAIRE avec des modules mais PAS `teledetection` ;
 * - modulesVides : GESTIONNAIRE a la liste de modules vide (« aucun module » cote serveur).
 */
export const NOMS_COMPTES = ["admin", "gestNational", "gestRegional", "inspecteur", "lecteur", "sansModule", "modulesVides"] as const;
export type NomCompte = (typeof NOMS_COMPTES)[number];

export interface RegionRun { id: number; nom: string }
export interface TronconRun { id: string; code: string; nom: string; regionId: number; longueurKm: number }
export interface ProduitRun { id: string; code: string; dateAcquisition: string }

export interface DonneesRun {
  urlBase: string;
  secretAcces: string;
  secretRafraichissement: string;
  comptes: Record<NomCompte, CompteRun>;
  /** Region A (perimetre du gestionnaire regional) et region B. FIXTURES DE TEST : ce ne sont pas des regions administratives. */
  regions: { A: RegionRun; B: RegionRun };
  /** Remplis par global-setup apres la synchronisation reelle du catalogue. */
  troncons: TronconRun[];
  produits: ProduitRun[];
  /** Resume de la synchronisation reelle (rapport de l'API). */
  synchro: { trouves: number; nouveaux: number; dejaConnus: number; requetes: number } | null;
  /** Compte de propositions deposees, par zone. */
  depot: { total: number; regionA: number; regionB: number; nonRattachees: number } | null;
  /** Empreinte SHA-256 du referentiel (troncons, portions, ouvrages) juste apres le semis, avant tout scenario. */
  empreinteAvant: Record<string, string> | null;
}

interface ParametresPg { hote: string; port: number; utilisateur: string; motDePasse: string }

/**
 * Parametres de connexion au PostgreSQL de developpement : `E2E_PG_URL` (URL locale) prime ; sinon variables POSTGRES_USER /
 * POSTGRES_PASSWORD lues dans le conteneur `bdri-dev-db`, sans jamais les afficher ni les ecrire.
 */
export function parametresPg(): ParametresPg {
  const explicite = process.env.E2E_PG_URL;
  if (explicite) {
    const u = new URL(explicite);
    return { hote: u.hostname, port: Number(u.port || 5432), utilisateur: decodeURIComponent(u.username), motDePasse: decodeURIComponent(u.password) };
  }
  const conteneur = process.env.E2E_PG_CONTENEUR ?? "bdri-dev-db";
  let env = "";
  try {
    env = execFileSync("docker", ["inspect", conteneur, "--format", "{{range .Config.Env}}{{println .}}{{end}}"], {
      encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    });
  } catch {
    throw new Error(`Conteneur "${conteneur}" illisible : demarrer Docker et le conteneur, ou definir E2E_PG_URL (voir docs/observation-terre/E2E.md).`);
  }
  const lire = (cle: string) => env.split(/\r?\n/).find((l) => l.startsWith(`${cle}=`))?.slice(cle.length + 1);
  const utilisateur = lire("POSTGRES_USER");
  const motDePasse = lire("POSTGRES_PASSWORD");
  if (!utilisateur || !motDePasse) throw new Error(`Variables POSTGRES_USER / POSTGRES_PASSWORD introuvables dans ${conteneur}.`);
  return { hote: "127.0.0.1", port: Number(process.env.E2E_PG_PORT ?? 5434), utilisateur, motDePasse };
}

function exigerLocal(p: ParametresPg): void {
  if (!HOTES_LOCAUX.has(p.hote)) throw new Error(`Hote PostgreSQL non local refuse : ${p.hote}`);
  if (!BASE_AUTORISEE.test(NOM_BASE)) throw new Error(`Base non jetable refusee : ${NOM_BASE}`);
}

function url(p: ParametresPg, base: string): string {
  return `postgresql://${encodeURIComponent(p.utilisateur)}:${encodeURIComponent(p.motDePasse)}@${p.hote}:${p.port}/${base}`;
}

async function avec<T>(connexion: string, f: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: connexion });
  await c.connect();
  try { return await f(c); } finally { await c.end(); }
}

/** Mot de passe aleatoire qui respecte la politique du serveur (10 caracteres, minuscule, majuscule, chiffre). */
export const secret = (octets = 18) => `${randomBytes(octets).toString("base64url")}aZ9`;

function compte(prefixe: string, nomComplet: string, role: CompteRun["role"]): CompteRun {
  // Domaine reserve `.invalid` (RFC 2606) : jamais une vraie adresse.
  return { id: randomUUID(), email: `${prefixe}@eo-e2e.test.invalid`, motDePasse: secret(), nomComplet, role };
}

/** (Re)cree `essai_eo_e2e` depuis le modele, y seme l'ADMIN et deux regions, ecrit `run.json`. */
export async function preparerBase(): Promise<DonneesRun> {
  const p = parametresPg();
  exigerLocal(p);

  await avec(url(p, "postgres"), async (c) => {
    // NOM_BASE et NOM_MODELE sont des constantes : aucune valeur externe n'entre dans ces ordres.
    await c.query(`DROP DATABASE IF EXISTS ${NOM_BASE} WITH (FORCE)`);
    // PostgreSQL refuse de copier un modele tant qu'une autre session y est connectee : on reessaie un moment.
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
  const comptes: Record<NomCompte, CompteRun> = {
    admin: compte("eo-admin", "Admin EO E2E", "ADMIN"),
    gestNational: compte("eo-gest-national", "Gestionnaire national EO E2E", "GESTIONNAIRE"),
    gestRegional: compte("eo-gest-regional", "Gestionnaire regional EO E2E", "GESTIONNAIRE"),
    inspecteur: compte("eo-inspecteur", "Inspecteur EO E2E", "INSPECTEUR"),
    lecteur: compte("eo-lecteur", "Lecteur EO E2E", "LECTEUR"),
    sansModule: compte("eo-sans-module", "Gestionnaire sans module EO E2E", "GESTIONNAIRE"),
    modulesVides: compte("eo-modules-vides", "Gestionnaire modules vides EO E2E", "GESTIONNAIRE"),
  };
  const regions = { A: { id: 0, nom: "Region test A (fixture)" }, B: { id: 0, nom: "Region test B (fixture)" } };

  await avec(url(p, NOM_BASE), async (c) => {
    for (const r of [regions.A, regions.B]) {
      const res = await c.query<{ id: number }>(`INSERT INTO regions (nom) VALUES ($1) ON CONFLICT (nom) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`, [r.nom]);
      r.id = res.rows[0].id;
    }
    // Seul l'ADMIN est seme en SQL (amorce, comme le script de seed) : les autres comptes sont crees par l'API d'administration.
    const a = comptes.admin;
    const hash = await argon2.hash(a.motDePasse, { type: argon2.argon2id });
    await c.query(
      `INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "modulesAutorises", "updatedAt")
       VALUES ($1, $2, $3, $4, 'ADMIN'::"Role", '{}'::text[], now())`, [a.id, a.email, a.nomComplet, hash]);
  });

  const donnees: DonneesRun = {
    urlBase, secretAcces: secret(32), secretRafraichissement: secret(32), comptes, regions,
    troncons: [], produits: [], synchro: null, depot: null, empreinteAvant: null,
  };
  enregistrerRun(donnees);
  return donnees;
}

export function lireRun(): DonneesRun {
  if (!fs.existsSync(FICHIER_RUN)) throw new Error(`${FICHIER_RUN} absent : le lanceur de l'API n'a pas prepare la base.`);
  return JSON.parse(fs.readFileSync(FICHIER_RUN, "utf8")) as DonneesRun;
}

export function enregistrerRun(d: DonneesRun): void {
  fs.mkdirSync(DOSSIER_RUN, { recursive: true });
  fs.writeFileSync(FICHIER_RUN, JSON.stringify(d), { mode: 0o600 });
}

/** Mise a jour partielle de run.json (relit puis ecrit : plusieurs etapes l'enrichissent). */
export function majRun(f: (d: DonneesRun) => void): DonneesRun {
  const d = lireRun();
  f(d);
  enregistrerRun(d);
  return d;
}

/** Detruit `essai_eo_e2e` et ce qui a ete genere (identifiants). Les sorties de test sont gardees sauf demande. */
export async function nettoyer(avecSorties = false): Promise<void> {
  const p = parametresPg();
  exigerLocal(p);
  await avec(url(p, "postgres"), (c) => c.query(`DROP DATABASE IF EXISTS ${NOM_BASE} WITH (FORCE)`));
  fs.rmSync(FICHIER_RUN, { force: true });
  // Sous Windows, l'API tourne encore (webServer s'arrete apres le teardown) avec son dossier pour repertoire courant : la suppression
  // peut etre refusee. Ce n'est pas une erreur, le lanceur suivant le recree et le vide.
  const cibles = avecSorties ? [DOSSIER_RUN] : [`${DOSSIER_RUN}/api`];
  for (const cible of cibles) {
    try { fs.rmSync(cible, { recursive: true, force: true }); } catch { /* voir ci-dessus */ }
  }
}

/** Connexion a la base jetable (lecture et semis de fixtures). Garde a chaque ouverture. */
export async function avecBase<T>(f: (c: Client) => Promise<T>): Promise<T> {
  const p = parametresPg();
  exigerLocal(p);
  return avec(url(p, NOM_BASE), f);
}
