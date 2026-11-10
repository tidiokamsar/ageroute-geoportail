import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as argon2 from "argon2";
import { expect, request, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { requete } from "./base";
import type { CompteRun } from "./donnees";
import { ORIGINE_API, RACINE_DEPOT } from "./env";

/**
 * Outils des scenarios du module « Projets de voirie et reseaux » (specs 10 a 17).
 *
 *   - comptes dedies, crees directement dans la base jetable `essai_e2e` (le jeu de depart du harnais donne a chaque compte les modules d'un
 *     agent de terrain, sans la cle `projets-voirie`) : mots de passe tires au hasard, adresses en `.invalid`, rien ecrit dans le depot ;
 *   - client d'API authentifie (jeton obtenu par POST /api/auth/login, adresse annoncee propre a chaque client : le plafond de connexion est
 *     de 10 par 15 min et par adresse) ;
 *   - lectures directes de la base pour verifier ce que le serveur a ECRIT (jamais seulement ce que l'ecran affiche) ;
 *   - gestes de l'interface : assistant d'import en sept etapes, ouverture d'un projet ;
 *   - controle d'accessibilite par axe-core (le meme moteur que les tests unitaires du frontend), dans le navigateur reel.
 */

// ------------------------------------------------------------------------------------------------ Comptes

export type RoleCompte = "ADMIN" | "GESTIONNAIRE" | "LECTEUR" | "INSPECTEUR";
/** Meme forme que `CompteRun` (les gestes de connexion du harnais en attendent un) ; le code PIN n'est jamais utilise par ces scenarios. */
export type CompteVoirie = CompteRun;

const secret = (octets = 18) => randomBytes(octets).toString("base64url");

/** Cree un compte actif dans la base jetable. `modules` : cles de module du compte (`[]` = aucune restriction, comportement historique). */
/** Modules d'un compte du module : le tableau de bord (page d'arrivee apres la connexion) et `projets-voirie`. */
export const MODULES_VOIRIE = ["dashboard", "projets-voirie"];

export async function creerCompte(prefixe: string, nomComplet: string, role: RoleCompte, modules: string[] = MODULES_VOIRIE): Promise<CompteVoirie> {
  const id = randomUUID();
  const motDePasse = secret();
  const email = `${prefixe}-${randomUUID().slice(0, 8)}@e2e.test.invalid`;
  const hash = await argon2.hash(motDePasse, { type: argon2.argon2id });
  await requete(
    `INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "modulesAutorises", "updatedAt")
     VALUES ($1, $2, $3, $4, $5::"Role", $6::text[], now())`,
    [id, email, nomComplet, hash, role, modules]);
  return { id, email, motDePasse, pin: secret(9), nomComplet, role };
}

export async function creerRegion(nom: string): Promise<number> {
  const r = await requete<{ id: number }>(`INSERT INTO regions (nom) VALUES ($1) ON CONFLICT (nom) DO UPDATE SET nom = EXCLUDED.nom RETURNING id`, [nom]);
  return r[0].id;
}

/** Rattache un compte a une region : il n'est plus national, le perimetre territorial s'applique. */
export async function accorderPerimetre(userId: string, regionId: number, accordeParId: string): Promise<void> {
  await requete(`INSERT INTO perimetres_comptes ("userId", "regionId", "accordeParId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [userId, regionId, accordeParId]);
}

// ------------------------------------------------------------------------------------------------ Client d'API

export interface ReponseApi { statut: number; corps: any; texte: string; entetes: Record<string, string> }
export interface FichierEnvoye { name: string; buffer: Buffer; mimeType?: string }

const adresseAleatoire = () => { const o = randomBytes(3); return `10.${(o[0] % 250) + 1}.${(o[1] % 250) + 1}.${(o[2] % 250) + 1}`; };

export const BASE = "/api/v2/projets-voirie";
/** Delai d'une requete d'API : au-dela de celui des analyses du serveur (120 s dans ce harnais), pour lire sa reponse (200, 504) plutot que couper avant. */
const DELAI_REQUETE_MS = 150_000;

export class ApiVoirie {
  private constructor(private readonly ctx: APIRequestContext, readonly jeton: string | null) {}

  /** Client connecte : POST /api/auth/login, comme l'interface. */
  static async connecter(compte: Pick<CompteVoirie, "email" | "motDePasse">): Promise<ApiVoirie> {
    const entetes = { "X-Forwarded-For": adresseAleatoire() };
    const ctx = await request.newContext({ baseURL: ORIGINE_API, extraHTTPHeaders: entetes });
    const r = await ctx.post("/api/auth/login", { data: { email: compte.email, password: compte.motDePasse } });
    expect(r.status(), `connexion de ${compte.email}`).toBe(200);
    const jeton = ((await r.json()) as { accessToken: string }).accessToken;
    await ctx.dispose();
    return new ApiVoirie(await request.newContext({ baseURL: ORIGINE_API, timeout: DELAI_REQUETE_MS, extraHTTPHeaders: { ...entetes, authorization: `Bearer ${jeton}` } }), jeton);
  }

  /** Client SANS jeton (ou avec un jeton donne, valide ou non). */
  static async anonyme(jeton?: string): Promise<ApiVoirie> {
    const entetes: Record<string, string> = { "X-Forwarded-For": adresseAleatoire() };
    if (jeton) entetes.authorization = `Bearer ${jeton}`;
    return new ApiVoirie(await request.newContext({ baseURL: ORIGINE_API, timeout: DELAI_REQUETE_MS, extraHTTPHeaders: entetes }), jeton ?? null);
  }

  async fermer(): Promise<void> { await this.ctx.dispose(); }

  private async rendre(r: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<ReponseApi> {
    const texte = await r.text();
    let corps: any = null;
    try { corps = JSON.parse(texte); } catch { /* corps non JSON (CSV...) */ }
    return { statut: r.status(), corps, texte, entetes: r.headers() };
  }

  get(chemin: string): Promise<ReponseApi> { return this.ctx.get(chemin).then((r) => this.rendre(r)); }
  /** GET d'un contenu binaire (archive ZIP) : octets bruts, plus le corps JSON quand la reponse est une erreur. */
  async getBinaire(chemin: string): Promise<ReponseApi & { octets: Buffer }> {
    const r = await this.ctx.get(chemin);
    const octets = await r.body();
    let corps: any = null;
    if (!(r.headers()["content-type"] ?? "").includes("zip")) { try { corps = JSON.parse(octets.toString("utf8")); } catch { /* non JSON */ } }
    return { statut: r.status(), corps, texte: corps ? octets.toString("utf8") : "", entetes: r.headers(), octets };
  }
  post(chemin: string, data?: unknown): Promise<ReponseApi> { return this.ctx.post(chemin, data === undefined ? {} : { data }).then((r) => this.rendre(r)); }
  patch(chemin: string, data?: unknown): Promise<ReponseApi> { return this.ctx.patch(chemin, { data }).then((r) => this.rendre(r)); }
  put(chemin: string, data?: unknown): Promise<ReponseApi> { return this.ctx.put(chemin, { data }).then((r) => this.rendre(r)); }
  delete(chemin: string): Promise<ReponseApi> { return this.ctx.delete(chemin).then((r) => this.rendre(r)); }

  /** Envoi multipart d'un fichier et de champs texte (depot, inventaire, apercu). */
  async multipart(chemin: string, fichier: FichierEnvoye | null, champs: Record<string, string | undefined> = {}): Promise<ReponseApi> {
    const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {};
    for (const [k, v] of Object.entries(champs)) if (v !== undefined) multipart[k] = v;
    if (fichier) multipart.fichier = { name: fichier.name, mimeType: fichier.mimeType ?? "application/octet-stream", buffer: fichier.buffer };
    return this.ctx.post(chemin, { multipart }).then((r) => this.rendre(r));
  }

  // ---- Raccourcis du module
  /**
   * Cree un projet (201 exige). Lot T1 : le territoire est obligatoire. Sans `territoireId` dans `extra`, le projet est rattache a la NATION (projet
   * national, comme un projet sans region avant T1) ; avec un `regionId` seul, a un territoire de niveau REGION porte par cette region (cree une
   * fois par l'API, par un ADMIN dedie : `territoireDeRegion`).
   */
  async creerProjet(code: string, extra: Record<string, unknown> = {}): Promise<string> {
    const territoireId = extra.territoireId ?? (typeof extra.regionId === "number" ? await territoireDeRegion(extra.regionId) : await territoireNational());
    const r = await this.post(BASE, { code, nom: `Projet ${code}`, territoireId, ...extra });
    expect(r.statut, `creation du projet ${code} : ${r.texte}`).toBe(201);
    return r.corps.projet.id as string;
  }

  async creerConcessionnaire(nom: string, typeReseau = "TELECOM"): Promise<string> {
    const r = await this.post(`${BASE}/concessionnaires`, { nom, typeReseau });
    expect(r.statut, `creation du concessionnaire ${nom} : ${r.texte}`).toBe(201);
    return r.corps.concessionnaire.id as string;
  }

  /** Depose un fichier (jeu en quarantaine) ; rend la reponse brute. */
  deposer(projetId: string, fichier: FichierEnvoye, champs: Record<string, string | undefined>, options: { simuler?: boolean } = {}): Promise<ReponseApi> {
    return this.multipart(`${BASE}/${projetId}/jeux${options.simuler ? "?simuler=true" : ""}`, fichier, champs);
  }

  /** Depose, exige un 201 et rend l'identifiant du jeu. */
  async deposerOk(projetId: string, fichier: FichierEnvoye, champs: Record<string, string | undefined>): Promise<string> {
    const r = await this.deposer(projetId, fichier, champs);
    expect(r.statut, `depot de ${fichier.name} : ${r.texte.slice(0, 400)}`).toBe(201);
    return r.corps.jeu.id as string;
  }

  autoriser(projetId: string, jeuId: string, justification = JUSTIFICATION): Promise<ReponseApi> {
    return this.post(`${BASE}/${projetId}/jeux/${jeuId}/autoriser`, { justification });
  }

  /** Depose puis autorise (deux appels) ; rend l'identifiant du jeu. */
  async deposerEtAutoriser(projetId: string, fichier: FichierEnvoye, champs: Record<string, string | undefined>): Promise<string> {
    const id = await this.deposerOk(projetId, fichier, champs);
    const a = await this.autoriser(projetId, id);
    expect(a.statut, `autorisation de ${fichier.name} : ${a.texte.slice(0, 400)}`).toBe(200);
    return id;
  }

  /**
   * Lance une analyse de conflits. La cadence du serveur (3 s dans ce harnais) renvoie 429 `ANALYSE_TROP_FREQUENTE` avec `retryAfterS` : on
   * attend le delai dit PAR LE SERVEUR puis on recommence ; toute autre reponse est rendue telle quelle.
   */
  async analyser(projetId: string): Promise<ReponseApi> {
    for (let essai = 0; essai < 8; essai++) {
      const r = await this.post(`${BASE}/${projetId}/analyses`, {});
      if (r.statut !== 429) return r;
      const attente = Number(r.corps?.retryAfterS ?? 3);
      await new Promise((ok) => setTimeout(ok, (attente + 0.3) * 1000));
    }
    throw new Error("analyse : 429 persistant");
  }

  /** Lance une comparaison de deux sources (lot S1) ; meme traitement de la cadence (429 COMPARAISON_TROP_FREQUENTE) que `analyser`. */
  async comparer(projetId: string, jeuAId: string, jeuBId: string): Promise<ReponseApi> {
    for (let essai = 0; essai < 8; essai++) {
      const r = await this.post(`${BASE}/${projetId}/comparaisons`, { jeuAId, jeuBId });
      if (r.statut !== 429) return r;
      await new Promise((ok) => setTimeout(ok, (Number(r.corps?.retryAfterS ?? 3) + 0.3) * 1000));
    }
    throw new Error("comparaison : 429 persistant");
  }
}

export const JUSTIFICATION = "Controle effectue avec le chef de projet";

// ------------------------------------------------------------------------------------------------ Territoires (lot T1)

let adminTerritoires: Promise<ApiVoirie> | null = null;
/** ADMIN dedie aux territoires de preparation (cree une fois par fichier de specs, comme les autres comptes du module). */
export function adminDesTerritoires(): Promise<ApiVoirie> {
  if (!adminTerritoires) adminTerritoires = creerCompte("e2e-voirie-terr", "Admin Territoires E2E", "ADMIN").then((c) => ApiVoirie.connecter(c));
  return adminTerritoires;
}

let nation: Promise<string> | null = null;
/** Identifiant de la nation (creee par la migration T1), lu par l'API (`GET /territoires?niveau=NATION`). */
export function territoireNational(): Promise<string> {
  if (!nation) {
    nation = (async () => {
      const r = await (await adminDesTerritoires()).get(`${BASE}/territoires?niveau=NATION&actifs=true`);
      expect(r.statut, `nation : ${r.texte.slice(0, 300)}`).toBe(200);
      expect(r.corps.territoires.length, "une nation active").toBeGreaterThan(0);
      return r.corps.territoires[0].id as string;
    })();
  }
  return nation;
}

/** Cree un territoire par l'API (ADMIN), sous `parentId` (la nation par defaut) ; rend son identifiant. */
export async function creerTerritoire(t: { code: string; nom: string; niveau: string; parentId?: string; regionId?: number; emprise?: unknown; crsMetriqueEpsg?: number }, admin?: ApiVoirie): Promise<string> {
  const api = admin ?? (await adminDesTerritoires());
  const parentId = t.parentId ?? (t.niveau === "NATION" ? undefined : await territoireNational());
  const r = await api.post(`${BASE}/territoires`, { ...t, parentId, source: "essai de bout en bout, donnees synthetiques" });
  expect(r.statut, `creation du territoire ${t.code} : ${r.texte.slice(0, 300)}`).toBe(201);
  return r.corps.territoire.id as string;
}

const parRegion = new Map<number, Promise<string>>();
/** Territoire de niveau REGION porte par la region administrative `regionId` (perimetre des comptes) ; cree au premier appel. */
export function territoireDeRegion(regionId: number): Promise<string> {
  let t = parRegion.get(regionId);
  if (!t) {
    t = (async () => {
      const code = `E2E-REG-${regionId}-${randomUUID().slice(0, 6).toUpperCase()}`;
      return creerTerritoire({ code, nom: `Region synthetique ${regionId}`, niveau: "REGION", regionId });
    })();
    parRegion.set(regionId, t);
  }
  return t;
}

export const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Code de projet valide et unique (`^[A-Z0-9][A-Z0-9_-]{1,63}$`), a partir du marqueur de test. */
export const codeProjet = (marqueur: string, suffixe = ""): string => `${marqueur}${suffixe ? `-${suffixe}` : ""}`.toUpperCase().replace(/[^A-Z0-9_-]/g, "-");

// ------------------------------------------------------------------------------------------------ Lectures de la base

export interface LigneJeu {
  id: string; projetId: string; role: string; statut: string; version: number; sha256: string; nomFichier: string; format: string; nbObjets: number;
  longueurTotaleM: number; origineFichier: string | null; confidentialite: string; concessionnaireId: string | null; remplaceId: string | null; natureObjets: string;
  avertissements: Array<{ code: string; nb?: number }>; resume: any;
}

export function jeuxDuProjet(projetId: string): Promise<LigneJeu[]> {
  return requete<LigneJeu>(
    `SELECT id, "projetId", role::text AS role, statut::text AS statut, version, sha256, "nomFichier", format::text AS format, "nbObjets",
            "longueurTotaleM", "origineFichier", confidentialite::text AS confidentialite, "concessionnaireId", "remplaceId",
            "natureObjets"::text AS "natureObjets", avertissements, resume
       FROM projets_voirie_jeux WHERE "projetId" = $1 ORDER BY "createdAt", id`, [projetId]);
}

export async function nombreObjetsDuJeu(jeuId: string): Promise<number> {
  return Number((await requete<{ n: string }>(`SELECT count(*)::text AS n FROM projets_voirie_objets WHERE "jeuId" = $1`, [jeuId]))[0].n);
}

/** Lignes d'audit d'un type d'entite (et d'une entite si donnee), du plus ancien au plus recent. */
export function auditDe(entityType: string, entityId?: string): Promise<Array<{ action: string; entityId: string; userId: string | null; after: any; before: any }>> {
  return requete(
    `SELECT action::text AS action, "entityId", "userId", "after", "before" FROM audit_logs
      WHERE "entityType" = $1 ${entityId ? `AND "entityId" = $2` : ""} ORDER BY "createdAt", id`, entityId ? [entityType, entityId] : [entityType]);
}

/**
 * Comptes de tout ce qu'un conflit pourrait « executer » (ordres, chantiers) et du referentiel officiel : ils ne doivent JAMAIS bouger
 * pendant un scenario du module (aucune ecriture dans le referentiel, aucun ordre cree par un conflit).
 */
export async function comptesInterdits(): Promise<Record<string, number>> {
  const tables = ["troncons", "ouvrages", "points_noirs", "postes", "chantiers", "portions", "ordres_travaux", "defauts"];
  const sortie: Record<string, number> = {};
  for (const t of tables) sortie[t] = Number((await requete<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`))[0].n);
  return sortie;
}

/** Empreinte du referentiel des troncons (contenu, pas seulement le nombre de lignes). */
export async function empreinteTroncons(): Promise<string> {
  return (await requete<{ h: string }>(`SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY code)), 'vide') AS h FROM troncons t`))[0].h;
}

// ------------------------------------------------------------------------------------------------ Interface : assistant d'import

export const DIALOGUE_ASSISTANT = "Ajouter des données au projet";

export async function ouvrirProjet(page: Page, projetId: string, nom?: string): Promise<void> {
  await page.goto(`/projets-voirie/${projetId}`);
  if (nom) await expect(page.getByRole("heading", { level: 1, name: nom })).toBeVisible();
}

export async function ouvrirAssistant(page: Page) {
  await page.getByRole("button", { name: "Ajouter des données" }).click();
  const dialogue = page.getByRole("dialog", { name: DIALOGUE_ASSISTANT });
  await expect(dialogue).toBeVisible();
  // Les formats et les limites viennent de l'API : on attend l'etape de depot complete.
  await expect(dialogue.getByTestId("formats-acceptes")).toBeVisible();
  return dialogue;
}

export interface SaisieDepotUi {
  fichier: FichierEnvoye;
  role?: "AXES_TRAVAUX" | "RESEAU_TIERS" | "LIMITES_ROUTE" | "AUTRE";
  /** Identifiant d'un concessionnaire existant (liste), ou nom a creer par le formulaire de l'assistant. */
  concessionnaireId?: string;
  nouveauConcessionnaire?: { nom: string; type?: string };
  origine?: string;
  nature?: string;
  /**
   * Classe de precision choisie dans l'assistant. Par defaut « B » (les scenarios du lot C1 ont ete ecrits ainsi pendant le defaut C1-01, corrige
   * depuis : « Inconnue » n'est plus envoyee au serveur). `null` : la liste n'est pas touchee, la valeur par defaut de l'interface reste.
   */
  classe?: "A" | "B" | "C" | "D" | "E" | "INCONNUE" | null;
  /** Lot S1 / UI-C : methode d'acquisition (code du referentiel METHODE_ACQUISITION), choisie dans la liste de l'assistant. */
  methode?: string;
  /** Lot T1 / UI-C : type de reseau configurable (code du referentiel TYPE_RESEAU). */
  typeReseauCode?: string;
}

type Dialogue = Locator;

/** Etape 1 : depose le fichier, renseigne le jeu, clique « Analyser le fichier » ; attend l'etape « Format et couches » (ou rend la main si une erreur s'affiche). */
export async function etapeDepot(page: Page, d: Dialogue, s: SaisieDepotUi): Promise<void> {
  await d.locator('input[type="file"]').setInputFiles({ name: s.fichier.name, mimeType: s.fichier.mimeType ?? "application/octet-stream", buffer: s.fichier.buffer });
  await expect(d.getByText(s.fichier.name).first()).toBeVisible();
  if (s.role) await d.getByLabel("Rôle du fichier").selectOption(s.role);
  if (s.nature) await d.getByLabel("Nature des objets").selectOption(s.nature);
  if (s.nouveauConcessionnaire) {
    await d.getByRole("button", { name: "Le concessionnaire n'est pas dans la liste : le créer" }).click();
    await d.getByLabel("Nom", { exact: true }).fill(s.nouveauConcessionnaire.nom);
    if (s.nouveauConcessionnaire.type) await d.getByLabel("Type de réseau").last().selectOption(s.nouveauConcessionnaire.type);
    await d.getByRole("button", { name: "Créer le concessionnaire" }).click();
    await expect(d.getByLabel("Concessionnaire propriétaire du réseau")).not.toHaveValue("");
  } else if (s.concessionnaireId) {
    await d.getByLabel("Concessionnaire propriétaire du réseau").selectOption(s.concessionnaireId);
  }
  // Choisir le concessionnaire reprend son type : le type du jeu se choisit APRES (premier champ « Type de réseau », celui du jeu).
  if (s.typeReseauCode) await d.getByLabel("Type de réseau").first().selectOption(s.typeReseauCode);
  if (s.methode) await d.getByLabel("Méthode d'acquisition (facultatif)").selectOption(s.methode);
  if (s.classe !== null) await d.getByLabel("Classe de précision").selectOption(s.classe ?? "B");
  if (s.origine) await d.getByLabel("Origine du fichier (facultatif)").fill(s.origine);
  await d.getByRole("button", { name: "Analyser le fichier" }).click();
}

/** Attend l'etape annoncee (le titre de l'etape prend le focus, texte « Etape N sur 7 : ... »). */
export async function attendreEtape(d: Dialogue, libelle: string): Promise<void> {
  await expect(d.getByTestId("etape-texte")).toContainText(libelle);
}

// ------------------------------------------------------------------------------------------------ Accessibilite (axe-core, navigateur reel)

export interface ViolationAxe { id: string; impact: string | null; aide: string; cibles: string[] }

/**
 * Passe axe-core (WCAG 2.0/2.1 A et AA, y compris le contraste, que jsdom ne peut pas mesurer) sur le contenu courant de la page ou d'une
 * region. La carte Leaflet (fond de tuiles refuse par le harnais, panneaux de la bibliotheque) est exclue : elle n'est pas du code du module.
 */
export async function violationsAxe(page: Page, options: { racine?: string } = {}): Promise<ViolationAxe[]> {
  const source = fs.readFileSync(path.join(RACINE_DEPOT, "frontend", "node_modules", "axe-core", "axe.min.js"), "utf8");
  await page.evaluate(source);
  return page.evaluate(async (racine) => {
    const axe = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const contexte = { include: [[racine ?? "body"]], exclude: [[".leaflet-container"]] };
    const r = await axe.run(contexte, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, aide: v.help, cibles: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
  }, options.racine);
}

/** Assertion lisible : aucune violation axe, ou la liste complete dans le message d'echec. */
export async function exigerAccessible(page: Page, contexte: string, options: { racine?: string } = {}): Promise<void> {
  const v = await violationsAxe(page, options);
  expect(v, `axe-core, ${contexte} : ${v.map((x) => `${x.id} (${x.impact}) ${x.cibles.join(" | ")}`).join(" ; ")}`).toEqual([]);
}

/** Etape « Format et couches » d'un tableau : lire des points regroupes par une cle (un axe par valeur de cle), colonnes explicites. */
export async function configurerCsvLignes(d: Locator, colonnes: { x: string; y: string; cle: string; ordre?: string }): Promise<void> {
  await d.getByRole("radio", { name: /Lignes : des points regroupés par une clé/ }).check();
  await d.getByLabel("Colonne X", { exact: true }).selectOption(colonnes.x);
  await d.getByLabel("Colonne Y", { exact: true }).selectOption(colonnes.y);
  await d.getByLabel("Colonne clé (une ligne par valeur)").selectOption(colonnes.cle);
  if (colonnes.ordre) await d.getByLabel("Colonne d'ordre (facultatif)").selectOption(colonnes.ordre);
}

/** Options multipart de lecture d'un plan d'axes en tableau (champs de l'API d'import). */
export const CHAMPS_CSV_AXES = { colonneX: "x", colonneY: "y", colonneCle: "axe", colonneOrdre: "ordre" } as const;

export const continuer = (d: Locator): Locator => d.getByRole("button", { name: "Continuer", exact: true });

// ------------------------------------------------------------------------------------------------ Pieces de dossier synthetiques (lot D1)

/** PDF minimal SYNTHETIQUE (une page vide, texte invente) : le serveur le reconnait par sa signature `%PDF-`. Jamais un vrai plan. */
export function pdfSynthetique(titre: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n% plan de reference synthetique : ${titre.replace(/[^A-Za-z0-9 -]/g, "")}\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n` +
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n" +
    "trailer << /Root 1 0 R >>\n%%EOF\n", "latin1");
}

/** DWG SYNTHETIQUE : la signature de version `AC1032` suivie d'octets quelconques (aucun dessin) ; le serveur ne le convertit jamais. */
export function dwgSynthetique(): Buffer {
  return Buffer.concat([Buffer.from("AC1032", "latin1"), Buffer.alloc(122, 0x2a)]);
}

/** Interroge l'API jusqu'a ce que `ok` soit vrai (ou le delai ecoule) : pour un effet consigne APRES la reponse (remise d'un export). */
export async function attendreQue<T>(lire: () => Promise<T>, ok: (v: T) => boolean, delaiMs = 15_000): Promise<T> {
  const fin = Date.now() + delaiMs;
  let v = await lire();
  while (!ok(v) && Date.now() < fin) { await new Promise((r) => setTimeout(r, 300)); v = await lire(); }
  return v;
}
