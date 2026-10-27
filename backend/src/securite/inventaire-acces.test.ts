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

interface Garde { auth: boolean; roles: string[][]; modules: string[]; territoire: string[] }
export interface LigneInventaire {
  methode: string;
  chemin: string;
  auth: boolean;
  /** Une entree par garde de role empilee (intersection). */
  roles: string[][];
  modules: string[];
  territoire: string[];
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

const vide = (): Garde => ({ auth: false, roles: [], modules: [], territoire: [] });
const fusion = (a: Garde, b: Garde): Garde => ({
  auth: a.auth || b.auth,
  roles: [...a.roles, ...b.roles],
  modules: [...a.modules, ...b.modules],
  territoire: [...a.territoire, ...b.territoire],
});

function gardeDe(handle: any): Garde {
  const g = vide();
  if (handle?.name === "requireAuth") g.auth = true;
  const m = handle?.[MARQUE];
  if (m?.role) g.roles.push(m.role);
  if (m?.module) g.modules.push(m.module);
  if (m?.territoire) g.territoire.push(String(m.territoire));
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
          sortie.push({ methode: meth === "_all" ? "ALL" : meth.toUpperCase(), chemin: complet, auth: g.auth, roles: g.roles, modules: g.modules, territoire: g.territoire });
        }
      }
    } else if (couche.name === "router" && couche.handle?.stack) {
      const pref = prefixeDeMontage(couche);
      let g = heritees;
      for (const c of courantes) if (c.prefixe === "" || pref === c.prefixe || pref.startsWith(`${c.prefixe}/`)) g = fusion(g, c.garde);
      enumerer(couche.handle.stack, prefixe + pref, g, sortie);
    } else {
      const g = gardeDe(couche.handle);
      if (g.auth || g.roles.length || g.modules.length || g.territoire.length) {
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
  { motif: /^\w+ \/api\/v2\/teledetection\//, raison: "D-C1-4 : lecture a tout compte connecte, ecriture ADMIN et GESTIONNAIRE (documente dans teledetection.routes.ts)" },
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
const DOMAINES_TERRITORIAUX = [/^\w+ \/api\/ordres-travaux(\/|$)/, /^\w+ \/api\/v2\/missions(\/|$)/, /^\w+ \/api\/v2\/programmation(\/|$)/];
const SANS_GARDE_TERRITORIALE: Exception[] = [
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

  it("expose exactement la liste et le detail, en lecture seule", () => {
    expect(roulage.map(cle).sort()).toEqual(["GET /api/v2/roulage/sessions", "GET /api/v2/roulage/sessions/:id"]);
  });

  it("les deux routes exigent un compte connecte ET le module `inspections` (le meme que la collecte), sans reserve de role", () => {
    for (const l of roulage) {
      expect(l.auth, cle(l)).toBe(true);
      expect(l.modules, cle(l)).toEqual(["inspections"]);
      // La visibilite par compte (siens / regions / tous) est dans la clause SQL, prouvee par roulage.routes.test.ts et le banc.
      expect(l.roles, cle(l)).toEqual([]);
    }
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
      /^POST \/api\/v2\/export\/selection$/,         // lecture (export), module controle dans le handler
      /^POST \/api\/simulateur\/budget$/,            // calcul sans ecriture, module `programmation`
      /^POST \/api\/v2\/taches-internes/,            // ROLES_ECRITURE verifie dans le handler (ADMIN, GESTIONNAIRE, INSPECTEUR)
    ];
    const sansRole = lignes
      .filter((l) => !estPublique(l) && l.methode !== "GET" && l.roles.length === 0)
      .filter((l) => !LIBRE.some((p) => p.test(cle(l))))
      .map(cle);
    expect(sansRole, `Ecritures sans garde de role et sans exception documentee :\n${sansRole.join("\n")}`).toEqual([]);
  });
});
