import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

/**
 * INTROSPECTION D'AUTHENTIFICATION : aucune route non publique ne repond a un appel SANS jeton.
 *
 * LA CLASSE DE DEFAUTS VISEE
 *
 * Le 23/10/2026, `troncons-bulk-etat` a ete montee sans `requireAuth`. Les tests de chaque
 * routeur simulent l'authentification (`vi.mock("../middleware/auth.middleware")`), donc aucun
 * d'eux ne pouvait voir l'absence de la garde. Ce fichier est le seul qui monte l'application
 * REELLE (`createApp()`) avec le VRAI `requireAuth` : seule la base (`lib/prisma`) est simulee.
 *
 * CE QUE LE TEST FAIT
 *
 *   1. Il enumere toutes les routes enregistrees dans la pile Express (routeurs imbriques et
 *      points de montage `app.use` / `router.use` compris).
 *   2. Pour chacune, hors liste blanche, il envoie une requete SANS en-tete Authorization et
 *      exige 401. Le test est comportemental et non structurel : il ne depend ni du nom des
 *      gardes, ni de l'endroit ou elles sont posees (route, `router.use`, montage).
 *   3. Il verifie que la liste blanche est honnete : chaque exception correspond a une route
 *      reelle (une exception perimee est signalee) et porte sa preuve.
 *   4. Il verifie que l'enumeration n'est pas vide ou tronquee (plancher du nombre de routes).
 *
 * CE QU'IL GARANTIT
 *
 *   Qu'un client sans jeton n'obtient jamais autre chose que 401 sur une route non listee,
 *   quel que soit le chemin par lequel la garde est posee.
 *
 * CE QU'IL NE GARANTIT PAS
 *
 *   - Les AUTORISATIONS : un jeton valide mais sans le bon role, le bon module ou le bon
 *     perimetre territorial est un autre sujet (rbac, module-access, territoire/*.test.ts).
 *   - La validite du jeton : un jeton forge, expire ou revoque est teste ailleurs (utils/jwt).
 *   - Les routes publiques de la liste blanche : leur propre surface (validation, limitation
 *     de debit, donnees exposees) reste a revoir une par une.
 *   - Les routes ajoutees HORS de la pile Express (serveur HTTP brut, upgrade WebSocket, fichiers
 *     statiques servis par un proxy comme nginx/Traefik) : l'application n'en a pas, mais le test
 *     ne le verifierait pas.
 *   - Un handler qui repondrait lui-meme 401 sans jeton tout en ayant fait un effet de bord avant
 *     la garde : improbable, mais le code 401 seul ne le distinguerait pas.
 *   - Que les requetes sans jeton n'ont aucun effet de bord : la base est simulee, donc un
 *     handler non garde n'atteint pas de vraies donnees. En production il le ferait.
 *
 * QUAND IL ECHOUE
 *
 *   Soit une route vient d'etre montee sans garde (cas a corriger), soit une route publique
 *   legitime est nouvelle : l'ajouter a `ROUTES_PUBLIQUES` AVEC sa preuve, apres decision humaine.
 *   Ne jamais l'ajouter pour faire passer le test.
 */

// Variables d'environnement MINIMALES pour que `config/env.ts` accepte de demarrer. Aucune vraie
// valeur : des chaines d'essai. Elles sont posees AVANT l'import de l'application (vi.hoisted),
// et ecrasent volontairement un eventuel .env local pour que l'essai soit deterministe.
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
  process.env.CORS_ORIGIN = "http://localhost:5173";
  // Les valeurs par defaut des plafonds de debit sont celles verifiees plus bas.
  delete process.env.RATE_LIMIT_REFRESH_MAX;
  delete process.env.RATE_LIMIT_V2_MAX;
});

// Seule la base est simulee. `requireAuth`, `verifyAccessToken`, les routeurs et tous les
// middlewares sont les VRAIS : c'est tout l'objet de ce fichier. Tout acces a la base rend une
// promesse resolue a `undefined` : un handler non garde qui l'atteindrait echouerait en 500, ce
// qui est aussi detecte (le test exige exactement 401).
vi.mock("../lib/prisma", () => {
  const fantome = (): unknown =>
    new Proxy(function () {}, {
      get: (_cible, propriete) => (typeof propriete === "symbol" || propriete === "then" ? undefined : fantome()),
      apply: () => Promise.resolve(undefined),
    });
  return { prisma: fantome() };
});

// Le journal d'acces de morgan (une ligne par requete) noierait la sortie : il est sans objet ici.
vi.mock("morgan", () => ({ default: () => (_req: unknown, _res: unknown, next: () => void) => next() }));

import { createApp } from "../app";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface RouteEnumeree {
  methode: string;
  /** Chemin complet avec parametres nommes, ex. `/api/troncons/:id`. */
  chemin: string;
}

const SUFFIXE_MONTAGE = String.raw`\/?(?=\/|$)`;
const PARAMETRE_MONTAGE = new RegExp(String.raw`\(\?:\(\[\^\\\/\]\+\?\)\)`, "g");

/** Reconstitue le prefixe d'un `app.use(chemin, routeur)` depuis l'expression reguliere d'Express 4. */
function prefixeDeMontage(couche: any): string {
  if (couche.regexp?.fast_slash) return "";
  let source: string = couche.regexp.source;
  source = source.replace(SUFFIXE_MONTAGE, "").replace(/^\^/, "");
  let n = 0;
  source = source.replace(PARAMETRE_MONTAGE, () => `:p${n++}`);
  source = source.split("\\/").join("/");
  if (/[\\()?*+[\]^$|]/.test(source)) {
    // Echouer bruyamment plutot que sauter une route : un trou d'enumeration est un trou de securite.
    throw new Error(`Point de montage non interpretable : ${couche.regexp} (ajouter son cas a prefixeDeMontage)`);
  }
  return source;
}

function enumerer(pile: any[], prefixe: string, sortie: RouteEnumeree[]): void {
  for (const couche of pile) {
    if (couche.route) {
      const chemins: unknown[] = Array.isArray(couche.route.path) ? couche.route.path : [couche.route.path];
      for (const chemin of chemins) {
        if (typeof chemin !== "string") {
          throw new Error(`Route a chemin non textuel (${String(chemin)}) sous ${prefixe || "/"} : a traiter explicitement`);
        }
        const complet = `${prefixe}${chemin === "/" ? "" : chemin}` || "/";
        for (const m of Object.keys(couche.route.methods).filter((k) => couche.route.methods[k])) {
          sortie.push({ methode: m === "_all" ? "ALL" : m.toUpperCase(), chemin: complet });
        }
      }
    } else if (couche.name === "router" && couche.handle?.stack) {
      enumerer(couche.handle.stack, prefixe + prefixeDeMontage(couche), sortie);
    }
  }
}

function routesDe(app: Express): RouteEnumeree[] {
  const brut: RouteEnumeree[] = [];
  enumerer((app as any)._router.stack, "", brut);
  const vues = new Set<string>();
  return brut.filter((r) => {
    const cle = `${r.methode} ${r.chemin}`;
    if (vues.has(cle)) return false;
    vues.add(cle);
    return true;
  });
}

/** Transforme `/api/troncons/:id/x` en une URL appelable. */
function urlAppelable(chemin: string): string {
  return chemin.replace(/:[A-Za-z0-9_]+\??/g, "x").replace(/\*/g, "x");
}

/**
 * ROUTES PUBLIQUES : les seules a repondre sans jeton. Chaque entree porte la PREUVE, tiree du
 * code, de la raison pour laquelle elle l'est. `chemin` est une expression reguliere ancree sur
 * le chemin complet ; `methodes` omis signifie toutes les methodes.
 */
interface RoutePublique {
  methodes?: string[];
  chemin: RegExp;
  preuve: string;
}

const ROUTES_PUBLIQUES: RoutePublique[] = [
  {
    chemin: /^\/api\/public(\/.*)?$/,
    preuve:
      "app.ts : `app.use(\"/api/public\", publicRouter)`. modules/public/public.routes.ts : \"Routes PUBLIQUES : aucun requireAuth\", " +
      "limitees a 60 requetes/minute/adresse par `publicRouter.use(rateLimit(...))`. Carte publique et metadonnees ISO 19115.",
  },
  {
    methodes: ["GET"],
    chemin: /^\/api\/health(\/.*)?$/,
    preuve:
      "app.ts : `app.use(\"/api/health\", healthRouter)` avant tout garde. Sonde d'etat appelee par l'orchestrateur " +
      "(Traefik/Docker) qui n'a pas de jeton ; modules/health/health.routes.ts.",
  },
  {
    methodes: ["POST"],
    chemin: /^\/api\/auth\/login$/,
    preuve: "auth.routes.ts : `authRouter.post(\"/login\", loginHandler)` sans requireAuth : c'est la route qui DELIVRE le jeton. Limitee a 10/15 min/adresse (app.ts).",
  },
  {
    methodes: ["POST"],
    chemin: /^\/api\/auth\/2fa\/login-verify$/,
    preuve:
      "auth.routes.ts : deuxieme etape de la connexion, authentifiee par le `challengeToken` du corps (auth.schema.ts) et non par un jeton d'acces. " +
      "Limitee a 10/15 min/adresse (app.ts).",
  },
  {
    methodes: ["POST"],
    chemin: /^\/api\/auth\/refresh$/,
    preuve:
      "auth.routes.ts : authentifiee par le jeton de rafraichissement (cookie HttpOnly ou corps), pas par un jeton d'acces qui a expire. " +
      "Limitee par limiteurRefresh (app.ts).",
  },
  {
    methodes: ["POST"],
    chemin: /^\/api\/auth\/logout$/,
    preuve:
      "auth.routes.ts : `authRouter.post(\"/logout\", logoutHandler)` sans requireAuth, volontairement : la deconnexion revoque le seul jeton " +
      "de rafraichissement presente (auth.service.logout), utile meme quand le jeton d'acces a expire.",
  },
];

const routes = routesDe(createApp());

function estPublique(r: RouteEnumeree): RoutePublique | undefined {
  return ROUTES_PUBLIQUES.find(
    (p) => p.chemin.test(r.chemin) && (!p.methodes || p.methodes.includes(r.methode) || r.methode === "ALL")
  );
}

describe("L'enumeration des routes est fiable", () => {
  it("trouve un nombre de routes plausible (plancher contre une enumeration tronquee)", () => {
    // Mesure du 25/10/2026 : plusieurs centaines. Le plancher est volontairement bas ; il sert
    // a detecter une enumeration cassee (0 route, ou seulement la racine), pas a figer un nombre.
    expect(routes.length).toBeGreaterThan(150);
  });

  it("voit des routes de chaque famille montee, y compris les routeurs imbriques de /api/v2", () => {
    const chemins = routes.map((r) => r.chemin);
    for (const attendu of ["/api/auth/login", "/api/troncons", "/api/v2/geo", "/api/v2/mobile/apk", "/api/public/carte/geo", "/api/health"]) {
      expect(chemins.some((c) => c === attendu || c.startsWith(`${attendu}/`)), `route ${attendu} introuvable`).toBe(true);
    }
  });

  it("la liste blanche ne contient aucune exception perimee ni sans preuve", () => {
    for (const p of ROUTES_PUBLIQUES) {
      expect(p.preuve.length, `exception ${p.chemin} sans preuve`).toBeGreaterThan(40);
      expect(
        routes.some((r) => p.chemin.test(r.chemin) && (!p.methodes || p.methodes.includes(r.methode))),
        `exception ${p.chemin} ne correspond a aucune route : a retirer`
      ).toBe(true);
    }
  });
});

describe("Aucune route non publique ne repond sans jeton", () => {
  const protegees = routes.filter((r) => !estPublique(r));

  it("a des routes a verifier", () => {
    expect(protegees.length).toBeGreaterThan(100);
  });

  // Une adresse distincte par requete (X-Forwarded-For, `trust proxy` = 1) : les limiteurs de
  // debit comptent par adresse, et l'essai ne doit pas se heurter aux plafonds de /api/v2.
  let compteur = 0;
  const adresseSuivante = () => `10.${(compteur >> 16) & 255}.${(compteur >> 8) & 255}.${compteur++ & 255}`;

  it("renvoie 401 sur TOUTES (aucun ecart n'est tolere)", async () => {
    const app = createApp();
    const ecarts: string[] = [];

    for (const r of protegees) {
      const methodes = r.methode === "ALL" ? ["GET", "POST"] : [r.methode];
      for (const methode of methodes) {
        const reponse = await (request(app) as any)[methode.toLowerCase()](urlAppelable(r.chemin))
          .set("X-Forwarded-For", adresseSuivante())
          .timeout(10_000);
        if (reponse.status !== 401) ecarts.push(`${methode} ${r.chemin} -> ${reponse.status}`);
      }
    }

    // Le message liste TOUTES les routes fautives d'un coup, pas seulement la premiere.
    expect(ecarts, `Routes qui repondent autre chose que 401 sans jeton :\n${ecarts.join("\n")}`).toEqual([]);
  }, 120_000);

  it("refuse aussi un jeton invalide (garde reelle, pas seulement l'absence d'en-tete)", async () => {
    const app = createApp();
    const r = await request(app)
      .get("/api/troncons")
      .set("Authorization", "Bearer pas.un.jeton")
      .set("X-Forwarded-For", adresseSuivante());
    expect(r.status).toBe(401);
  });
});

describe("La limitation de debit est branchee dans l'application reelle", () => {
  it("/api/auth/refresh annonce son plafond par defaut (60 par 15 min)", async () => {
    const r = await request(createApp()).post("/api/auth/refresh").set("X-Forwarded-For", "10.200.0.1");
    expect(r.headers["ratelimit-limit"]).toBe("60");
  });

  it("/api/v2 annonce son plafond global par defaut (1200 par minute)", async () => {
    const r = await request(createApp()).get("/api/v2").set("X-Forwarded-For", "10.200.0.2");
    expect(r.headers["ratelimit-limit"]).toBe("1200");
  });

  it("le plafond de /api/v2 coupe une adresse qui boucle sans toucher les autres", async () => {
    // Une application a part avec un plafond minuscule, pour ne pas faire 1200 requetes.
    const { limiteurApiV2 } = await import("../middleware/rate-limit.middleware");
    const express = (await import("express")).default;
    const a = express();
    a.set("trust proxy", 1);
    a.use("/api/v2", limiteurApiV2({ max: 2, fenetreMs: 60_000 }), (_req, res) => res.json({ ok: true }));
    const appel = (ip: string) => request(a).get("/api/v2/x").set("X-Forwarded-For", ip);
    expect((await appel("10.9.9.9")).status).toBe(200);
    expect((await appel("10.9.9.9")).status).toBe(200);
    expect((await appel("10.9.9.9")).status).toBe(429);
    expect((await appel("10.9.9.8")).status).toBe(200);
  });
});
