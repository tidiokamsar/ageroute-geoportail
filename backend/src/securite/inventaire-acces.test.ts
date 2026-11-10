import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";

/**
 * INVENTAIRE DES GARDES D'ACCES de l'application reelle (chantier C1, decision 3).
 *
 * `routes-authentifiees.test.ts` prouve qu'AUCUNE route non publique ne repond sans jeton. Il ne
 * dit rien du ROLE, du MODULE ni du PERIMETRE TERRITORIAL. Ce fichier enumere les routes montees
 * par `createApp()` et releve, pour chacune, les gardes de ROLE, de MODULE et de TERRITOIRE qui la
 * precedent (gardes posees sur la route, sur le routeur, ou au montage).
 *
 * COMMENT LES GARDES SONT RECONNUES
 *
 * `requireRole`, `requireModuleAccess` et `requireTerritoire` sont des fabriques qui rendent des
 * fonctions anonymes : on ne peut pas les lire au moment de l'enumeration. Ce fichier remplace
 * donc les trois fabriques par des versions qui MARQUENT la fonction rendue (arguments compris).
 * Seule la marque change : le comportement est celui d'origine, mais ce fichier n'envoie aucune
 * requete, il lit seulement la pile Express.
 *
 * CE QUE L'INVENTAIRE NE VOIT PAS (limite assumee, documentee dans docs/securite/CONTROLE-ACCES.md)
 *
 *   - Les controles faits DANS un handler ou un service (ex. `controleTerritorial` de la fabrique
 *     CRUD, filtre `where` par region d'une liste, `modulesAutorisesDe` dans la recherche). Ils
 *     sont releves a la lecture du code, et prouves par les tests de comportement.
 *   - La justesse d'une garde : ce fichier dit qu'elle existe, pas qu'elle protege la bonne chose.
 *
 * Variable `INVENTAIRE_SORTIE` : chemin d'un fichier JSON a ecrire (outil de generation de la
 * matrice du document). Sans elle, le test n'ecrit rien.
 */

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
});

vi.mock("../lib/prisma", () => {
  const fantome = (): unknown =>
    new Proxy(function () {}, {
      get: (_cible, propriete) => (typeof propriete === "symbol" || propriete === "then" ? undefined : fantome()),
      apply: () => Promise.resolve(undefined),
    });
  return { prisma: fantome() };
});
vi.mock("morgan", () => ({ default: () => (_req: unknown, _res: unknown, next: () => void) => next() }));

/* eslint-disable @typescript-eslint/no-explicit-any */
const { MARQUE, marquer } = vi.hoisted(() => {
  const MARQUE = "__garde";
  const marquer = <T extends object>(fn: T, garde: Record<string, unknown>): T => {
    (fn as any)[MARQUE] = { ...(fn as any)[MARQUE], ...garde };
    return fn;
  };
  return { MARQUE, marquer };
});

vi.mock("../middleware/rbac.middleware", async (original) => {
  const m = await original<typeof import("../middleware/rbac.middleware")>();
  return { ...m, requireRole: (...roles: string[]) => marquer(m.requireRole(...(roles as never[])), { role: roles }) };
});
vi.mock("../middleware/module-access.middleware", async (original) => {
  const m = await original<typeof import("../middleware/module-access.middleware")>();
  return { ...m, requireModuleAccess: (cle: string) => marquer(m.requireModuleAccess(cle as never), { module: cle }) };
});
vi.mock("../middleware/territoire.middleware", async (original) => {
  const m = await original<typeof import("../middleware/territoire.middleware")>();
  return {
    ...m,
    requireTerritoire: (regions: never) => marquer(m.requireTerritoire(regions), { territoire: "oui" }),
    requireTerritoireMasque: (regions: never, introuvable: never) => marquer(m.requireTerritoireMasque(regions, introuvable), { territoire: "masque" }),
  };
});
// Lot B3 : les routes du workflow n'ont pas de garde de ROLE (la matrice des droits decide, par profil effectif) : la garde `gardeWorkflow(action)` porte la marque
// `actions`, lue ici comme les trois autres gardes.
vi.mock("../projets-voirie/workflow/garde", async (original) => {
  const m = await original<typeof import("../projets-voirie/workflow/garde")>();
  return { ...m, gardeWorkflow: (a: never) => marquer(m.gardeWorkflow(a), { actions: Array.isArray(a) ? [...(a as string[])] : [a as string] }) };
});
vi.mock("../territoire/territoire.v1", async (original) => {
  const m = await original<typeof import("../territoire/territoire.v1")>();
  const nommes: Record<string, unknown> = { ...m };
  for (const [nom, v] of Object.entries(m)) if (typeof v === "function" && nom !== "territoireFiche") marquer(v as object, { territoire: nom });
  nommes.territoireFiche = (entite: string) => marquer(m.territoireFiche(entite as never), { territoire: `territoireFiche(${entite})` });
  return nommes;
});
vi.mock("../territoire/territoire.v2", async (original) => {
  const m = await original<typeof import("../territoire/territoire.v2")>();
  for (const [nom, v] of Object.entries(m)) if (typeof v === "function" && nom.startsWith("territoire")) marquer(v as object, { territoire: nom });
  return m;
});

import { createApp } from "../app";

interface Garde { auth: boolean; roles: string[][]; modules: string[]; territoire: string[]; actions: string[] }
export interface LigneInventaire {
  methode: string;
  chemin: string;
  auth: boolean;
  /** Une entree par garde de role empilee (intersection). */
  roles: string[][];
  modules: string[];
  territoire: string[];
  /** Actions de la matrice du workflow (lot B3) exigees par la route (au moins une). */
  actions: string[];
}

const SUFFIXE_MONTAGE = String.raw`\/?(?=\/|$)`;
const PARAMETRE_MONTAGE = new RegExp(String.raw`\(\?:\(\[\^\\\/\]\+\?\)\)`, "g");

function prefixeDeMontage(couche: any): string {
  if (couche.regexp?.fast_slash) return "";
  let source: string = couche.regexp.source;
  source = source.replace(SUFFIXE_MONTAGE, "").replace(/^\^/, "");
  let n = 0;
  source = source.replace(PARAMETRE_MONTAGE, () => `:p${n++}`);
  source = source.split("\\/").join("/");
  if (/[\\()?*+[\]^$|]/.test(source)) throw new Error(`Point de montage non interpretable : ${couche.regexp}`);
  return source;
}

const vide = (): Garde => ({ auth: false, roles: [], modules: [], territoire: [], actions: [] });
const fusion = (a: Garde, b: Garde): Garde => ({
  auth: a.auth || b.auth,
  roles: [...a.roles, ...b.roles],
  modules: [...a.modules, ...b.modules],
  territoire: [...a.territoire, ...b.territoire],
  actions: [...a.actions, ...b.actions],
});

function gardeDe(handle: any): Garde {
  const g = vide();
  if (handle?.name === "requireAuth") g.auth = true;
  const m = handle?.[MARQUE];
  if (m?.role) g.roles.push(m.role);
  if (m?.module) g.modules.push(m.module);
  if (m?.territoire) g.territoire.push(String(m.territoire));
  if (m?.actions) g.actions.push(...(m.actions as string[]));
  return g;
}

/**
 * `heritees` : gardes posees par les `use` du parent AVANT le montage de ce routeur. Dans un
 * routeur, une garde `use` s'applique aux routes enregistrees APRES elle (ordre de la pile).
 */
function enumerer(pile: any[], prefixe: string, heritees: Garde, sortie: LigneInventaire[]): void {
  const courantes: { prefixe: string; garde: Garde }[] = [];
  for (const couche of pile) {
    if (couche.route) {
      const chemins: unknown[] = Array.isArray(couche.route.path) ? couche.route.path : [couche.route.path];
      for (const chemin of chemins) {
        const local = chemin === "/" ? "" : String(chemin);
        const complet = `${prefixe}${local}` || "/";
        let g = heritees;
        for (const c of courantes) if (c.prefixe === "" || local === c.prefixe || local.startsWith(`${c.prefixe}/`)) g = fusion(g, c.garde);
        for (const sous of couche.route.stack) g = fusion(g, gardeDe(sous.handle));
        for (const meth of Object.keys(couche.route.methods).filter((k) => couche.route.methods[k])) {
          sortie.push({ methode: meth === "_all" ? "ALL" : meth.toUpperCase(), chemin: complet, auth: g.auth, roles: g.roles, modules: g.modules, territoire: g.territoire, actions: g.actions });
        }
      }
    } else if (couche.name === "router" && couche.handle?.stack) {
      const pref = prefixeDeMontage(couche);
      let g = heritees;
      for (const c of courantes) if (c.prefixe === "" || pref === c.prefixe || pref.startsWith(`${c.prefixe}/`)) g = fusion(g, c.garde);
      enumerer(couche.handle.stack, prefixe + pref, g, sortie);
    } else {
      const g = gardeDe(couche.handle);
      if (g.auth || g.roles.length || g.modules.length || g.territoire.length || g.actions.length) {
        courantes.push({ prefixe: couche.regexp?.fast_slash ? "" : prefixeDeMontage(couche), garde: g });
      }
    }
  }
}

export function inventaire(): LigneInventaire[] {
  const brut: LigneInventaire[] = [];
  enumerer((createApp() as any)._router.stack, "", vide(), brut);
  const vues = new Set<string>();
  return brut.filter((r) => {
    const cle = `${r.methode} ${r.chemin}`;
    if (vues.has(cle)) return false;
    vues.add(cle);
    return true;
  });
}

const lignes = inventaire();

describe("Inventaire des gardes d'acces", () => {
  it("enumere un nombre plausible de routes avec leurs gardes", () => {
    expect(lignes.length).toBeGreaterThan(150);
    expect(lignes.some((l) => l.modules.includes("ordres-travaux"))).toBe(true);
    expect(lignes.some((l) => l.roles.some((r) => r.includes("ADMIN")))).toBe(true);
    expect(lignes.some((l) => l.territoire.length > 0)).toBe(true);
  });

  it("ecrit l'inventaire si demande", () => {
    const sortie = process.env.INVENTAIRE_SORTIE;
    if (sortie) writeFileSync(sortie, JSON.stringify(lignes, null, 1));
    expect(true).toBe(true);
  });
});

// ================================================================================================
// GARDES STRUCTURELLES : une route nouvelle ne passe pas sans que quelqu'un ait decide de son acces.
// ================================================================================================

const PUBLIQUES = [/^\/api\/public(\/|$)/, /^\/api\/health(\/|$)/, /^\/api\/auth\/(login|refresh|logout|2fa\/login-verify)$/];
const estPublique = (l: LigneInventaire) => PUBLIQUES.some((p) => p.test(l.chemin));
const adminSeul = (l: LigneInventaire) => l.roles.some((r) => r.length === 1 && r[0] === "ADMIN");

interface Exception { motif: RegExp; raison: string }
const cle = (l: LigneInventaire) => `${l.methode} ${l.chemin}`;

/**
 * ROUTES SANS CONTROLE DE MODULE. Une route authentifiee qui n'est ni reservee a ADMIN ni gardee par un module doit figurer
 * ici AVEC sa raison : soit le module est controle DANS le handler, soit l'ouverture est voulue, soit c'est une decision en
 * attente (identifiant D-C1-n de docs/securite/CONTROLE-ACCES.md). Ajouter une ligne pour faire passer le test est une
 * decision de securite, pas une formalite.
 */
const SANS_MODULE: Exception[] = [
  { motif: /^\w+ \/api\/auth\//, raison: "libre-service du compte connecte (profil, 2FA, deconnexion globale)" },
  { motif: /^GET \/api\/regions$/, raison: "referentiel administratif (liste de regions), utilise par tous les formulaires" },
  { motif: /^GET \/api\/(troncons|ouvrages|points-noirs|postes|voirie-locale)(\/|$)/, raison: "VOULU : lecture ouverte du patrimoine pour tout compte connecte (selecteurs, carte, fiche de troncon), commentaire de troncons.routes.ts" },
  { motif: /^GET \/api\/chantiers(\/|$)/, raison: "D-C1-1 : meme ouverture que le patrimoine (carte, fiche de troncon, selecteur des marches) ; depuis AD-7 les champs financiers (montant, bailleur, contrat, entreprise) sont MASQUES (null) pour un compte sans module chantiers ou marches, l'export exige le module chantiers, le perimetre regional s'applique ; decision metier en attente" },
  { motif: /^\w+ \/api\/gouvernance\//, raison: "droit porte par `users.peutDeleguerValidation`, verifie dans les gestionnaires (delegations.controller.ts)" },
  { motif: /^GET \/api\/audit$/, raison: "module de l'entite consultee, controle dans le handler (MODULE_PAR_ENTITE) ; type inconnu refuse" },
  { motif: /^GET \/api\/qualite\/:entityType\/:entityId$/, raison: "module de l'entite, controle dans le handler (MODULE_PAR_ENTITE)" },
  { motif: /^GET \/api\/search$/, raison: "chaque type n'est interroge que si le module correspondant est accorde (modulesAutorisesDe)" },
  { motif: /^GET \/api\/documents(\/|$)/, raison: "D-C1-3 : documents lisibles par tout compte connecte (onglet Documents de la fiche de troncon) ; decision en attente" },
  { motif: /^GET \/api\/photos\/:filename$/, raison: "module du proprietaire du fichier, controle dans le handler, 404 uniforme" },
  { motif: /^\w+ \/api\/v2\/imports(\/|$)/, raison: "reserve ADMIN et GESTIONNAIRE (role) ; pas de module d'import dans lib/modules.ts" },
  { motif: /^\w+ \/api\/v2\/exploitation\//, raison: "D-C1-4 : exploitation (main courante, patrouilles, veille, info route) sans cle de module ; ecriture ouverte a tout compte par decision documentee, lecture a tout compte connecte" },
  { motif: /^POST \/api\/v2\/export\/selection$/, raison: "module de la table demandee, controle dans le handler (liste blanche des tables)" },
  { motif: /^GET \/api\/v2\/fiche-360\/troncons\/:id\/portions$/, raison: "portee territoriale (garde `requireTerritoire`) ; les portions sont un volet du referentiel de troncon" },
  { motif: /^\w+ \/api\/v2\/correspondances(\/|$)/, raison: "D-C1-4 : table de correspondance des identifiants externes ; lecture a tout compte connecte, ecriture ADMIN et GESTIONNAIRE" },
  { motif: /^GET \/api\/v2\/mobile\/apk(\/info)?$/, raison: "telechargement de l'application de terrain par tout compte connecte (journalise SECURITY_EVENT)" },
  { motif: /^GET \/api\/v2$/, raison: "inventaire de la surface v2, reserve aux comptes connectes" },
];

/**
 * ROUTES DE DOMAINE TERRITORIAL (A10). Dans ces domaines, toute route qui designe une ressource ou en ecrit une doit porter une
 * garde territoriale. Les lectures de liste, dont le filtre est dans le handler (`filtreRegion`, `regions` du depot), sont
 * listees : leur comportement est prouve par le banc `controle-acces.integration.mts`, pas par la structure.
 */
const DOMAINES_TERRITORIAUX = [/^\w+ \/api\/ordres-travaux(\/|$)/, /^\w+ \/api\/v2\/missions(\/|$)/, /^\w+ \/api\/v2\/programmation(\/|$)/, /^\w+ \/api\/v2\/projets-voirie(\/|$)/];
const SANS_GARDE_TERRITORIALE: Exception[] = [
  { motif: /^GET \/api\/v2\/projets-voirie$/, raison: "liste filtree dans le service (regions du compte : un compte regional ne voit que les projets de ses regions) ; banc projets-voirie" },
  { motif: /^\w+ \/api\/v2\/projets-voirie\/concessionnaires$/, raison: "annuaire national des concessionnaires de reseau : des organismes, pas des donnees regionales" },
  // Lot T1 : territoires (liste et comptes filtres par perimetre dans le service, creation ADMIN seul : un ADMIN est national), referentiels et configuration (nationaux).
  { motif: /^GET \/api\/v2\/projets-voirie\/territoires(\/comptes)?$/, raison: "liste et comptes filtres dans le service par la region effective des territoires (regions du compte) ; banc territoires-referentiels" },
  { motif: /^POST \/api\/v2\/projets-voirie\/territoires$/, raison: "creation reservee a l'ADMIN, qui est toujours national ; lot T1" },
  { motif: /^\w+ \/api\/v2\/projets-voirie\/referentiels(\/|$)/, raison: "referentiels configurables nationaux (types de reseau, categories, types de document, methodes, statuts de qualite) : aucune donnee regionale ; ecriture ADMIN" },
  { motif: /^\w+ \/api\/v2\/projets-voirie\/configuration(\/|$)/, raison: "configuration nationale du module (emprise, CRS, protections) : aucune donnee regionale ; ecriture ADMIN" },
  // Lot X1 : tableau de bord NATIONAL, filtre dans le service par les regions du compte (meme regle que la liste des projets).
  { motif: /^GET \/api\/v2\/projets-voirie\/tableau-de-bord$/, raison: "agregats filtres dans le service par les regions du compte (projets de ses regions seulement ; national : tout) ; banc exports-tableaux" },
  { motif: /^GET \/api\/v2\/projets-voirie\/workflow\/mon-profil$/, raison: "profil de workflow du compte connecte (role, rattachements, droits) : la liste des projets est filtree dans le service par les regions du compte ; lot B3" },
  { motif: /^GET \/api\/ordres-travaux$/, raison: "liste filtree dans le handler (regions du compte) ; banc F1" },
  { motif: /^GET \/api\/ordres-travaux\/stats$/, raison: "statistiques filtrees dans le service (regions du compte) ; banc F1" },
  { motif: /^GET \/api\/ordres-travaux\/assignables$/, raison: "annuaire des agents assignables : personnes, pas des OT ; D-C1-5" },
  { motif: /^GET \/api\/v2\/missions$/, raison: "liste filtree dans le handler (filtreRegion) ; banc F2" },
  { motif: /^GET \/api\/v2\/missions\/:id$/, raison: "fiche filtree dans le handler (filtreRegion, 404) ; banc F2" },
  { motif: /^POST \/api\/v2\/missions\/:id\/statut$/, raison: "mission retrouvee avec le filtre de region dans le handler (404) ; banc F2" },
  { motif: /^GET \/api\/v2\/programmation(\/totaux)?$/, raison: "liste et totaux filtres dans le handler (filtreRegionDuTroncon) ; banc F3" },
  { motif: /^GET \/api\/v2\/programmation\/moteur\/simulations$/, raison: "liste filtree dans le depot (regions) ; banc F6" },
  { motif: /^GET \/api\/v2\/programmation\/moteur\/fiches$/, raison: "liste filtree dans le depot (regions) ; banc F6" },
  { motif: /^GET \/api\/v2\/programmation\/moteur\/ppe\/simulations$/, raison: "liste filtree dans le depot (regions) ; banc F6" },
  { motif: /^\w+ \/api\/v2\/programmation\/moteur\/parametres(\/|$)/, raison: "ponderations et seuils : reglages nationaux, pas des donnees regionales" },
  { motif: /^GET \/api\/v2\/programmation\/moteur\/praticabilite$/, raison: "etat de branchement d'un referentiel national (D-02), aucune donnee regionale" },
];

describe("Consultation des releves en roulage (/api/v2/roulage)", () => {
  const roulage = lignes.filter((l) => l.chemin.startsWith("/api/v2/roulage"));

  it("expose exactement la consultation (liste, detail) et la relecture de l'agent (mes-sessions), en lecture seule", () => {
    expect(roulage.map(cle).sort()).toEqual([
      "GET /api/v2/roulage/mes-sessions", "GET /api/v2/roulage/mes-sessions/:id",
      "GET /api/v2/roulage/sessions", "GET /api/v2/roulage/sessions/:id",
    ]);
  });

  it("les quatre routes exigent un compte connecte ET le module `inspections` (le meme que la collecte), sans reserve de role", () => {
    for (const l of roulage) {
      expect(l.auth, cle(l)).toBe(true);
      expect(l.modules, cle(l)).toEqual(["inspections"]);
      // La visibilite par compte (siens / regions / tous) est dans la clause SQL, prouvee par roulage.routes.test.ts et le banc.
      expect(l.roles, cle(l)).toEqual([]);
    }
  });
});

describe("Observation de la Terre (/api/v2/teledetection)", () => {
  const eo = lignes.filter((l) => l.chemin.startsWith("/api/v2/teledetection"));
  // Roles du contrat (docs/observation-terre/CONTRAT-API-UI.md §2) : transitions, depot de lot et synchronisation du catalogue
  // ADMIN/GESTIONNAIRE ; preuves de terrain ouvertes en plus a INSPECTEUR ; test d'une source ADMIN seul.
  const ROLES_ECRITURE: Record<string, string[]> = {
    "POST /api/v2/teledetection/propositions/:id/transition": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/teledetection/propositions/:id/verification": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/teledetection/propositions/:id/preuves": ["ADMIN", "GESTIONNAIRE", "INSPECTEUR"],
    "POST /api/v2/teledetection/sources/:code/verifier": ["ADMIN"],
    "POST /api/v2/teledetection/sources/:code/synchroniser-catalogue": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/teledetection/produits": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/teledetection/propositions": ["ADMIN", "GESTIONNAIRE"],
  };

  it("toute route exige un compte connecte ET le module `teledetection` (gardes lisibles malgre l'enveloppe qui pose le `code`)", () => {
    expect(eo.length).toBeGreaterThanOrEqual(16);
    for (const l of eo) {
      expect(l.auth, cle(l)).toBe(true);
      expect(l.modules, cle(l)).toEqual(["teledetection"]);
    }
  });

  it("chaque ecriture porte exactement la garde de role du contrat, et aucune lecture n'en porte", () => {
    const ecritures = eo.filter((l) => l.methode !== "GET");
    expect(ecritures.map(cle).sort()).toEqual(Object.keys(ROLES_ECRITURE).sort());
    for (const l of ecritures) expect(l.roles.map((r) => [...r].sort()), cle(l)).toEqual([[...ROLES_ECRITURE[cle(l)]].sort()]);
    for (const l of eo.filter((x) => x.methode === "GET")) expect(l.roles, cle(l)).toEqual([]);
  });
});

describe("Projets de voirie et reseaux (/api/v2/projets-voirie)", () => {
  // Le workflow (lot B3) a sa section : droits par profil effectif, pas par role technique.
  const pv = lignes.filter((l) => l.chemin.startsWith("/api/v2/projets-voirie") && !/\/workflow(\/|$)/.test(l.chemin));
  const ECRITURES: Record<string, string[]> = {
    "POST /api/v2/projets-voirie": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/concessionnaires": ["ADMIN", "GESTIONNAIRE"],
    "PATCH /api/v2/projets-voirie/:id": ["ADMIN", "GESTIONNAIRE"],
    "DELETE /api/v2/projets-voirie/:id": ["ADMIN"],
    "POST /api/v2/projets-voirie/:id/jeux": ["ADMIN", "GESTIONNAIRE"],
    "DELETE /api/v2/projets-voirie/:id/jeux/:jeuId": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/jeux/:jeuId/autoriser": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/jeux/:jeuId/rejeter": ["ADMIN", "GESTIONNAIRE"],
    // Export CSV de l'analyse (agregats, sans geometrie) : une lecture, mais reservee aux roles d'ecriture et auditee.
    "GET /api/v2/projets-voirie/:id/analyse/export.csv": ["ADMIN", "GESTIONNAIRE"],
    // Dossiers de conflit (lot RC-3). L'approbation d'une regle est reservee a l'ADMIN ; les transitions reservees a l'ADMIN le sont dans le service (403 ROLE_INSUFFISANT).
    // Corrections de la revue RC-3 : AUCUNE route ni aucun role ne change (les 16 routes restent) ; seuls les codes de reponse evoluent (404 PROJET_INTROUVABLE
    // aussi pour un compte national, 404 CONFLIT_INTROUVABLE pour un dossier dont le jeu n'est pas autorise, 429 ANALYSE_TROP_FREQUENTE, 504 EXPORT_TROP_LONG),
    // prouves par api-v2/projets-voirie.conflits.routes.test.ts et par le banc PostGIS (docs/securite/CONTROLE-ACCES.md).
    "POST /api/v2/projets-voirie/:id/regles": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/regles/:regleId/approuver": ["ADMIN"],
    "POST /api/v2/projets-voirie/:id/analyses": ["ADMIN", "GESTIONNAIRE"],
    "GET /api/v2/projets-voirie/:id/conflits/export.csv": ["ADMIN", "GESTIONNAIRE"],
    "PATCH /api/v2/projets-voirie/:id/conflits/:cid": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/conflits/:cid/statut": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/conflits/:cid/preuves": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/conflits/:cid/decisions": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/conflits/:cid/decisions/:did/approuver": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/conflits/:cid/decisions/:did/refuser": ["ADMIN", "GESTIONNAIRE"],
    // Formats d'import ouverts, CRS, mapping, versions (lot A1) : wizard reserve aux roles qui deposent ; lectures comprises (elles portent sur la quarantaine).
    "GET /api/v2/projets-voirie/:id/import/options": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/import/inventaire": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/import/apercu": ["ADMIN", "GESTIONNAIRE"],
    // Lot B2 : jobs de conversion GDAL (GeoPackage, Shapefile ZIP, DXF) ; prouves par api-v2/projets-voirie.gdal.routes.test.ts et le banc gdal-jobs.
    "POST /api/v2/projets-voirie/:id/import/jobs": ["ADMIN", "GESTIONNAIRE"],
    "GET /api/v2/projets-voirie/:id/import/jobs": ["ADMIN", "GESTIONNAIRE"],
    "GET /api/v2/projets-voirie/:id/import/jobs/:jobId": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/import/jobs/:jobId/annuler": ["ADMIN", "GESTIONNAIRE"],
    "GET /api/v2/projets-voirie/:id/jeux/:jeuId/delta": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/jeux/:jeuId/revue-suppressions": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/jeux/:jeuId/retour-arriere": ["ADMIN", "GESTIONNAIRE"],
    // Reseaux physiques et circuits logiques (lot B1) : descripteurs d'objets, relations, propositions d'associations. Toutes les ecritures sont auditees ;
    // le comptage et les listes sont des lectures, limitees aux jeux que le compte peut lire (prouve par le banc PostGIS reseau-physique-logique).
    "PUT /api/v2/projets-voirie/:id/reseau/objets/:objetId/descripteur": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/reseau/relations": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/reseau/relations/:relId/valider": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/reseau/relations/:relId/refuser": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/reseau/relations/:relId/revoquer": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/reseau/associations/proposer": ["ADMIN", "GESTIONNAIRE"],
    // Territoires, referentiels et configuration (lot T1, CONTRAT-TERRITOIRES.md section 7) : toute ecriture est reservee a l'ADMIN.
    "POST /api/v2/projets-voirie/territoires": ["ADMIN"],
    "PATCH /api/v2/projets-voirie/territoires/:tid": ["ADMIN"],
    "DELETE /api/v2/projets-voirie/territoires/:tid": ["ADMIN"],
    "POST /api/v2/projets-voirie/referentiels/:domaine": ["ADMIN"],
    "PATCH /api/v2/projets-voirie/referentiels/:domaine/:code": ["ADMIN"],
    "DELETE /api/v2/projets-voirie/referentiels/:domaine/:code": ["ADMIN"],
    "PUT /api/v2/projets-voirie/configuration/:cle": ["ADMIN"],
    // Sources multiples et comparaison entre sources (lot S1) : regles de rapprochement (approbation ADMIN seul), comparaison persistee, ouverture d'un dossier
    // de divergence par une action humaine justifiee. Prouve par api-v2/projets-voirie.sources.routes.test.ts et le banc sources-comparaison.
    "POST /api/v2/projets-voirie/:id/regles-rapprochement": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/regles-rapprochement/:regleRapId/approuver": ["ADMIN"],
    "POST /api/v2/projets-voirie/:id/comparaisons": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/comparaisons/:cmpId/dossiers-conflit": ["ADMIN", "GESTIONNAIRE"],
    // Documents du dossier (lot D1) : creation, depot, version, statut, retrait (le retrait d'une piece VALIDE est reserve a l'ADMIN par le service).
    // Prouve par api-v2/projets-voirie.documents.routes.test.ts et le banc documents-projet.
    "POST /api/v2/projets-voirie/:id/documents": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/documents/:docId/depot": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/documents/:docId/versions": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/documents/:docId/statut": ["ADMIN", "GESTIONNAIRE"],
    "DELETE /api/v2/projets-voirie/:id/documents/:docId": ["ADMIN", "GESTIONNAIRE"],
    // Export du dossier technique (lot X1) : archive et journal reserves aux comptes qui decident (lectures, mais elles remettent des geometries et des
    // noms) ; derogation de confidentialite ADMIN seul. Prouve par api-v2/projets-voirie.dossier-technique.routes.test.ts et le banc exports-tableaux.
    "GET /api/v2/projets-voirie/:id/export/dossier": ["ADMIN", "GESTIONNAIRE"],
    "GET /api/v2/projets-voirie/:id/export/journal": ["ADMIN", "GESTIONNAIRE"],
    "POST /api/v2/projets-voirie/:id/export/derogations": ["ADMIN"],
    "GET /api/v2/projets-voirie/:id/export/derogations": ["ADMIN"],
  };

  it("expose exactement les 15 routes du socle, les 16 des dossiers de conflit, les 6 de l'import (lot A1), les 10 des reseaux (lot B1), les 4 des jobs de conversion GDAL (lot B2), les 15 des territoires, referentiels et configuration (lot T1), les 9 des sources (lot S1), les 8 des documents (lot D1) et les 6 de l export et des tableaux de bord (lot X1), ni plus (aucun export de geometrie, aucune route d'ordre ou de deplacement), ni moins", () => {
    expect(pv.map(cle).sort()).toEqual([
      "DELETE /api/v2/projets-voirie/:id", "DELETE /api/v2/projets-voirie/:id/jeux/:jeuId",
      "GET /api/v2/projets-voirie", "GET /api/v2/projets-voirie/:id", "GET /api/v2/projets-voirie/:id/analyse",
      "GET /api/v2/projets-voirie/:id/analyse/export.csv", "GET /api/v2/projets-voirie/:id/carte", "GET /api/v2/projets-voirie/:id/jeux",
      "GET /api/v2/projets-voirie/concessionnaires", "PATCH /api/v2/projets-voirie/:id",
      "POST /api/v2/projets-voirie", "POST /api/v2/projets-voirie/:id/jeux", "POST /api/v2/projets-voirie/:id/jeux/:jeuId/autoriser",
      "POST /api/v2/projets-voirie/:id/jeux/:jeuId/rejeter", "POST /api/v2/projets-voirie/concessionnaires",
      // Dossiers de conflit (lot RC-3, contrat CONTRAT-CONFLITS.md, section 6)
      "GET /api/v2/projets-voirie/:id/regles", "POST /api/v2/projets-voirie/:id/regles", "POST /api/v2/projets-voirie/:id/regles/:regleId/approuver",
      "POST /api/v2/projets-voirie/:id/analyses", "GET /api/v2/projets-voirie/:id/analyses", "GET /api/v2/projets-voirie/:id/analyses/:aid",
      "GET /api/v2/projets-voirie/:id/analyses/:aid/comparaison",
      "GET /api/v2/projets-voirie/:id/conflits", "GET /api/v2/projets-voirie/:id/conflits/export.csv", "GET /api/v2/projets-voirie/:id/conflits/:cid",
      "PATCH /api/v2/projets-voirie/:id/conflits/:cid", "POST /api/v2/projets-voirie/:id/conflits/:cid/statut", "POST /api/v2/projets-voirie/:id/conflits/:cid/preuves",
      "POST /api/v2/projets-voirie/:id/conflits/:cid/decisions", "POST /api/v2/projets-voirie/:id/conflits/:cid/decisions/:did/approuver",
      "POST /api/v2/projets-voirie/:id/conflits/:cid/decisions/:did/refuser",
      // Formats d'import ouverts, CRS, mapping, versions (lot A1, contrat CONTRAT-IMPORT.md)
      "GET /api/v2/projets-voirie/:id/import/options", "POST /api/v2/projets-voirie/:id/import/inventaire", "POST /api/v2/projets-voirie/:id/import/apercu",
      "GET /api/v2/projets-voirie/:id/jeux/:jeuId/delta", "POST /api/v2/projets-voirie/:id/jeux/:jeuId/revue-suppressions", "POST /api/v2/projets-voirie/:id/jeux/:jeuId/retour-arriere",
      // Jobs de conversion GDAL (lot B2, CONTRAT-IMPORT.md section 13)
      "POST /api/v2/projets-voirie/:id/import/jobs", "GET /api/v2/projets-voirie/:id/import/jobs", "GET /api/v2/projets-voirie/:id/import/jobs/:jobId",
      "POST /api/v2/projets-voirie/:id/import/jobs/:jobId/annuler",
      // Reseaux physiques et circuits logiques (lot B1, CONTRAT-RESEAUX.md, section 5)
      "GET /api/v2/projets-voirie/:id/reseau/objets", "GET /api/v2/projets-voirie/:id/reseau/objets/:objetId",
      "PUT /api/v2/projets-voirie/:id/reseau/objets/:objetId/descripteur",
      "GET /api/v2/projets-voirie/:id/reseau/relations", "POST /api/v2/projets-voirie/:id/reseau/relations",
      "POST /api/v2/projets-voirie/:id/reseau/relations/:relId/valider", "POST /api/v2/projets-voirie/:id/reseau/relations/:relId/refuser",
      "POST /api/v2/projets-voirie/:id/reseau/relations/:relId/revoquer",
      "POST /api/v2/projets-voirie/:id/reseau/associations/proposer", "GET /api/v2/projets-voirie/:id/reseau/comptage",
      // Territoires hierarchiques, referentiels configurables, configuration nationale (lot T1, CONTRAT-TERRITOIRES.md section 7)
      "GET /api/v2/projets-voirie/territoires", "GET /api/v2/projets-voirie/territoires/comptes", "POST /api/v2/projets-voirie/territoires",
      "GET /api/v2/projets-voirie/territoires/:tid", "PATCH /api/v2/projets-voirie/territoires/:tid", "DELETE /api/v2/projets-voirie/territoires/:tid",
      "GET /api/v2/projets-voirie/referentiels", "GET /api/v2/projets-voirie/referentiels/:domaine", "POST /api/v2/projets-voirie/referentiels/:domaine",
      "GET /api/v2/projets-voirie/referentiels/:domaine/:code", "PATCH /api/v2/projets-voirie/referentiels/:domaine/:code", "DELETE /api/v2/projets-voirie/referentiels/:domaine/:code",
      "GET /api/v2/projets-voirie/configuration", "GET /api/v2/projets-voirie/configuration/:cle", "PUT /api/v2/projets-voirie/configuration/:cle",
      // Sources multiples et comparaison entre sources (lot S1, CONTRAT-SOURCES.md, section 5)
      "GET /api/v2/projets-voirie/:id/sources", "GET /api/v2/projets-voirie/:id/regles-rapprochement", "POST /api/v2/projets-voirie/:id/regles-rapprochement",
      "POST /api/v2/projets-voirie/:id/regles-rapprochement/:regleRapId/approuver", "POST /api/v2/projets-voirie/:id/comparaisons", "GET /api/v2/projets-voirie/:id/comparaisons",
      "GET /api/v2/projets-voirie/:id/comparaisons/:cmpId", "GET /api/v2/projets-voirie/:id/comparaisons/:cmpId/objets", "POST /api/v2/projets-voirie/:id/comparaisons/:cmpId/dossiers-conflit",
      // Documents du dossier et ce que les documents permettent (lot D1, CONTRAT-DOCUMENTS.md, section 5)
      "GET /api/v2/projets-voirie/:id/completude", "GET /api/v2/projets-voirie/:id/documents", "POST /api/v2/projets-voirie/:id/documents",
      "GET /api/v2/projets-voirie/:id/documents/:docId", "POST /api/v2/projets-voirie/:id/documents/:docId/depot", "POST /api/v2/projets-voirie/:id/documents/:docId/versions",
      "POST /api/v2/projets-voirie/:id/documents/:docId/statut", "DELETE /api/v2/projets-voirie/:id/documents/:docId",
      // Export du dossier technique et tableaux de bord (lot X1, CONTRAT-EXPORTS.md, sections 4.1 et 6.1)
      "GET /api/v2/projets-voirie/:id/export/dossier", "GET /api/v2/projets-voirie/:id/export/journal", "POST /api/v2/projets-voirie/:id/export/derogations",
      "GET /api/v2/projets-voirie/:id/export/derogations", "GET /api/v2/projets-voirie/tableau-de-bord", "GET /api/v2/projets-voirie/tableau-de-bord/territoires/:tid",
    ].sort());
    // Lot S1 : aucune route de fusion, de connexion calculee ni de proposition automatique de connexion.
    expect(pv.filter((l) => /fusion|fusionn|connect|connexion|continuite/i.test(l.chemin))).toEqual([]);
    // Aucune route ne cree d'ordre, de deplacement ni de decision automatique.
    expect(pv.filter((l) => /ordre|deplac|ordonn/i.test(l.chemin))).toEqual([]);
  });

  it("toute route exige un compte connecte ET le module `projets-voirie`", () => {
    for (const l of pv) {
      expect(l.auth, cle(l)).toBe(true);
      expect(l.modules, cle(l)).toEqual(["projets-voirie"]);
    }
  });

  it("chaque ecriture (et l'export CSV) porte exactement la garde de role du contrat ; les autres lectures n'en portent aucune", () => {
    const gardees = pv.filter((l) => l.methode !== "GET" || ECRITURES[cle(l)]);
    expect(gardees.map(cle).sort()).toEqual(Object.keys(ECRITURES).sort());
    for (const l of gardees) expect(l.roles.map((r) => [...r].sort()), cle(l)).toEqual([[...ECRITURES[cle(l)]].sort()]);
    for (const l of pv.filter((x) => x.methode === "GET" && !ECRITURES[cle(x)])) expect(l.roles, cle(l)).toEqual([]);
  });

  it("toute route qui designe un projet ou un territoire porte la garde territoriale a 404 masque (lecture comme ecriture), la creation d'un projet la garde a 403", () => {
    for (const l of pv.filter((x) => x.chemin.includes("/:id") || x.chemin.includes("/:tid"))) expect(l.territoire, cle(l)).toEqual(["masque"]);
    expect(pv.find((l) => cle(l) === "POST /api/v2/projets-voirie")!.territoire).toEqual(["oui"]);
  });
});

describe("Workflow concessionnaire, referents, taches, preuves et recolement (/api/v2/projets-voirie/.../workflow, lot B3)", () => {
  const wf = lignes.filter((l) => l.chemin.startsWith("/api/v2/projets-voirie") && /\/workflow(\/|$)/.test(l.chemin));
  const P = "/api/v2/projets-voirie/:id/workflow";
  // Actions de la matrice (profils.noyau.ts) exigees par chaque route. Les routes ne portent PAS de garde de role technique : le droit se decide par PROFIL EFFECTIF
  // (ADMIN, GESTIONNAIRE, INSPECTEUR, LECTEUR, REFERENT) selon une matrice a defaut prudent, configurable.
  const ACTIONS_WORKFLOW: Record<string, string[]> = {
    [`GET /api/v2/projets-voirie/workflow/mon-profil`]: [],
    [`GET ${P}/referents`]: ["referent.lire"],
    [`POST ${P}/referents`]: ["referent.gerer"],
    [`POST ${P}/referents/:rattachementId/revoquer`]: ["referent.gerer"],
    [`GET ${P}/jeux`]: ["workflow.lire"],
    [`GET ${P}/conflits`]: ["workflow.lire"],
    [`GET ${P}/demandes`]: ["workflow.lire"],
    [`POST ${P}/demandes`]: ["demande.ecrire"],
    [`GET ${P}/demandes/:demandeId`]: ["workflow.lire"],
    [`PATCH ${P}/demandes/:demandeId`]: ["demande.ecrire"],
    [`POST ${P}/demandes/:demandeId/statut`]: ["demande.ecrire"],
    [`POST ${P}/demandes/:demandeId/preuves`]: ["preuve.ajouter"],
    [`GET ${P}/taches`]: ["workflow.lire", "tache.executer"],
    [`POST ${P}/taches`]: ["tache.gerer"],
    [`GET ${P}/taches/:tacheId`]: ["workflow.lire", "tache.executer"],
    [`PATCH ${P}/taches/:tacheId`]: ["tache.gerer"],
    [`POST ${P}/taches/:tacheId/statut`]: ["tache.executer"],
    [`POST ${P}/taches/:tacheId/preuves`]: ["preuve.ajouter"],
    [`GET ${P}/recolements`]: ["workflow.lire"],
    [`POST ${P}/recolements`]: ["recolement.ecrire"],
    [`GET ${P}/recolements/:recolementId`]: ["workflow.lire"],
    [`PATCH ${P}/recolements/:recolementId`]: ["recolement.ecrire"],
    [`POST ${P}/recolements/:recolementId/statut`]: ["recolement.ecrire"],
    [`POST ${P}/recolements/:recolementId/preuves`]: ["preuve.ajouter"],
  };

  it("expose exactement les 24 routes du workflow : ni envoi de message, ni export de geometrie, ni ordre ou deplacement", () => {
    expect(wf.map(cle).sort()).toEqual(Object.keys(ACTIONS_WORKFLOW).sort());
    expect(wf.filter((l) => /ordre|deplac|ordonn|export|envoi|envoyer|courriel|mail|message|notif|sms|geometr/i.test(l.chemin))).toEqual([]);
  });

  it("toute route exige un compte connecte ET le module `projets-voirie`", () => {
    for (const l of wf) {
      expect(l.auth, cle(l)).toBe(true);
      expect(l.modules, cle(l)).toEqual(["projets-voirie"]);
    }
  });

  it("chaque route porte exactement la ou les actions de la matrice du contrat, et aucune n'est reservee par un role technique", () => {
    for (const l of wf) {
      expect(l.actions, cle(l)).toEqual(ACTIONS_WORKFLOW[cle(l)]);
      expect(l.roles, cle(l)).toEqual([]);
    }
  });

  it("toute action nommee par une route existe dans la matrice du noyau (garde contre une faute de frappe qui laisserait la route ouverte a personne ou a tous)", async () => {
    const { ACTIONS } = await import("../projets-voirie/workflow/profils.noyau");
    for (const a of Object.values(ACTIONS_WORKFLOW).flat()) expect(ACTIONS as readonly string[], a).toContain(a);
  });

  it("toute route qui designe un projet porte la garde territoriale a 404 masque ; mon-profil filtre dans le service", () => {
    for (const l of wf.filter((x) => x.chemin.includes("/:id"))) expect(l.territoire, cle(l)).toEqual(["masque"]);
    expect(wf.find((l) => cle(l) === "GET /api/v2/projets-voirie/workflow/mon-profil")!.territoire).toEqual([]);
  });
});

describe("Gardes structurelles : aucune route ne passe sans qu'on ait decide de son acces", () => {
  it("toute route authentifiee non publique sans module ni reserve ADMIN est une exception DOCUMENTEE", () => {
    const sansModule = lignes.filter((l) => !estPublique(l) && l.modules.length === 0 && !adminSeul(l));
    const inconnues = sansModule.filter((l) => !SANS_MODULE.some((e) => e.motif.test(cle(l)))).map(cle);
    expect(inconnues, `Routes sans controle de module et sans exception documentee :\n${inconnues.join("\n")}`).toEqual([]);
  });

  it("aucune exception de module n'est perimee ni sans raison", () => {
    const sansModule = lignes.filter((l) => !estPublique(l) && l.modules.length === 0 && !adminSeul(l)).map(cle);
    for (const e of SANS_MODULE) {
      expect(e.raison.length, `${e.motif} sans raison`).toBeGreaterThan(30);
      expect(sansModule.some((c) => e.motif.test(c)), `exception perimee : ${e.motif}`).toBe(true);
    }
  });

  it("toute route d'un domaine territorial porte une garde territoriale, sauf les listes filtrees dans le handler", () => {
    const manquantes = lignes
      .filter((l) => DOMAINES_TERRITORIAUX.some((d) => d.test(cle(l))) && !adminSeul(l) && l.territoire.length === 0)
      .filter((l) => !SANS_GARDE_TERRITORIALE.some((e) => e.motif.test(cle(l))))
      .map(cle);
    expect(manquantes, `Routes d'un domaine territorial sans garde territoriale :\n${manquantes.join("\n")}`).toEqual([]);
  });

  it("aucune exception territoriale n'est perimee ni sans raison", () => {
    const candidates = lignes.filter((l) => DOMAINES_TERRITORIAUX.some((d) => d.test(cle(l))) && l.territoire.length === 0).map(cle);
    for (const e of SANS_GARDE_TERRITORIALE) {
      expect(e.raison.length, `${e.motif} sans raison`).toBeGreaterThan(30);
      expect(candidates.some((c) => e.motif.test(c)), `exception perimee : ${e.motif}`).toBe(true);
    }
  });

  it("les routes d'administration restent reservees a ADMIN (comptes, reglages, integrations, perimetres)", () => {
    for (const prefixe of ["/api/users", "/api/admin", "/api/v2/integrations", "/api/v2/perimetres"]) {
      const concernees = lignes.filter((l) => l.chemin.startsWith(prefixe));
      expect(concernees.length, prefixe).toBeGreaterThan(0);
      expect(concernees.filter((l) => !adminSeul(l)).map(cle), `${prefixe} doit rester reserve a ADMIN`).toEqual([]);
    }
  });

  it("toute ecriture est reservee par un role, ou figure dans la liste documentee des ecritures ouvertes", () => {
    const LIBRE: RegExp[] = [
      /^POST \/api\/auth\//,
      /^POST \/api\/gouvernance\//,          // droit peutDeleguerValidation, dans le handler
      // Collecte de terrain : module `inspections` ou `geoportail`, portee par agent (perimetreDefauts, perimetreObservations),
      // validation par delegation (governance/delegation.service). D-C1-6 : un LECTEUR qui a le module peut ecrire.
      /^\w+ \/api\/v2\/(sync|devices|defauts|observations|portions|geo|field)(\/|$)/,
      /^POST \/api\/v2\/missions\/:id\/statut$/,   // portee par affectation et region dans le handler
      /^POST \/api\/v2\/exploitation\/(main-courante|veille\/escalades\/evaluer)/, // D-C1-4 : ecriture ouverte a tout compte par decision documentee (exploitation.routes.ts, veille.routes.ts)
      /^POST \/api\/v2\/programmation\/moteur\/(ppe\/)?simulations\/:id\/rejouer$/, // recalcul sans ecriture
      /^POST \/api\/v2\/aide-decision\/scenarios\/(comparer|:id\/rejouer)$/, // AD : comparaison (lecture) et rejeu (recalcul sans ecriture), module et perimetre verifies dans le routeur
      /^POST \/api\/v2\/referentiel\/troncons\/anomalies\/previsualisation$/, // BDRI lot C : calcule ce que l'application ferait, SANS rien ecrire ; module `troncons` verifie par le routeur, meme ouverture que la lecture du registre (a relire : aucune garde de role)
      /^POST \/api\/v2\/export\/selection$/,         // lecture (export), module controle dans le handler
      /^POST \/api\/simulateur\/budget$/,            // calcul sans ecriture, module `programmation`
      /^POST \/api\/v2\/taches-internes/,            // ROLES_ECRITURE verifie dans le handler (ADMIN, GESTIONNAIRE, INSPECTEUR)
      /^\w+ \/api\/v2\/projets-voirie\/:id\/workflow\//, // lot B3 : droit par PROFIL EFFECTIF (matrice du workflow, gardeWorkflow(action)) : un agent de terrain et un referent concessionnaire (LECTEUR rattache) ecrivent dans un cadre borne ; verifie par la section « Workflow » de ce fichier
    ];
    const sansRole = lignes
      .filter((l) => !estPublique(l) && l.methode !== "GET" && l.roles.length === 0)
      .filter((l) => !LIBRE.some((p) => p.test(cle(l))))
      .map(cle);
    expect(sansRole, `Ecritures sans garde de role et sans exception documentee :\n${sansRole.join("\n")}`).toEqual([]);
  });
});
