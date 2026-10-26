import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lancerDetecteurs, lancerEnLectureSeule, NON_COUVERT, TOUTES_FAMILLES } from "./detecteurs.service";
import type { ClientLecture } from "./detecteurs.depot";

/**
 * Service et depot des detecteurs : ce que ces tests defendent (sans base ; le comportement reel est
 * eprouve par tests-integration/qualite-detecteurs.integration.ts contre PostGIS).
 *   - lecture seule : aucun mot d'ecriture dans le SQL, aucune instruction autre que SELECT/WITH emise,
 *     et la transaction de `lancerEnLectureSeule` est ouverte en READ ONLY avant toute lecture ;
 *   - la pagination par curseur parcourt toutes les pages et s'arrete a la derniere ;
 *   - une base sans limite de niveau 1 ne produit pas un deluge de « hors territoire » ;
 *   - le rapport dit ce qu'il ne couvre pas et quels seuils provisoires il a appliques.
 */

const lire = (f: string) => readFileSync(join(__dirname, f), "utf8");
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");

describe("Lecture seule : analyse statique des sources", () => {
  const depot = sansCommentaires(lire("detecteurs.depot.ts"));
  const service = sansCommentaires(lire("detecteurs.service.ts"));
  const noyau = sansCommentaires(lire("detecteurs.noyau.ts"));
  const MOTS_ECRITURE = /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|copy|upsert|merge)\b/i;

  it("le depot ne contient aucun mot d'ecriture SQL ni appel d'ecriture Prisma", () => {
    expect(depot).not.toMatch(MOTS_ECRITURE);
    expect(depot).not.toMatch(/\$executeRaw|\$executeRawUnsafe|\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(depot).not.toMatch(/\$queryRawUnsafe/);
  });
  it("le depot n'importe pas le client global : il recoit le client en parametre", () => {
    expect(depot).not.toMatch(/from "\.\.\/lib\/prisma"/);
  });
  it("le noyau ne contient aucun appel d'ecriture", () => {
    expect(noyau).not.toMatch(/\$executeRaw|\.(create|update|upsert|delete)\(/);
  });
  it("le service n'a qu'une instruction non lue : SET TRANSACTION READ ONLY", () => {
    expect(service).not.toMatch(MOTS_ECRITURE);
    const executions = [...service.matchAll(/\$executeRaw[^;]*;/g)].map((m) => m[0].replace(/\s+/g, " "));
    expect(executions).toEqual(["$executeRaw`SET TRANSACTION READ ONLY`;"]);
  });
  it("le service n'ecrit pas dans le journal d'audit (une lecture n'est pas une ecriture du patrimoine)", () => {
    expect(service).not.toMatch(/logAudit|auditLog|audit_logs/);
  });
});

interface Appel { sql: string; valeurs: unknown[] }

/** Texte SQL d'un appel `$queryRaw` en gabarit etiquete, fragments Prisma.Sql compris. */
function texte(strings: TemplateStringsArray, valeurs: unknown[]): string {
  let s = "";
  strings.forEach((part, i) => {
    s += part;
    const v = valeurs[i];
    if (v && typeof v === "object" && "strings" in (v as object)) s += (v as { strings: string[] }).strings.join(" ");
  });
  return s.replace(/\s+/g, " ").trim();
}

function fauxClient(reponses: (appel: Appel) => unknown): { db: ClientLecture; appels: Appel[] } {
  const appels: Appel[] = [];
  const $queryRaw = (strings: TemplateStringsArray, ...valeurs: unknown[]) => {
    const appel = { sql: texte(strings, valeurs), valeurs };
    appels.push(appel);
    return Promise.resolve(reponses(appel));
  };
  return { db: { $queryRaw } as unknown as ClientLecture, appels };
}

function mesure(id: string, sur: Record<string, unknown> = {}) {
  return {
    id, code: `C-${id}`, regionId: 1, regionNom: "Boké", longueurKm: 10, pkDebut: 0, pkFin: 10, etat: "BON",
    dateDerniereEvaluation: new Date("2026-01-01T00:00:00Z"),
    geomPresente: true, geomVide: false, geomValide: true, raisonInvalide: null,
    geomType: "ST_LineString", geomSrid: 4326, longueurGeomM: 10_000, ...sur,
  };
}

/** Reponses par defaut : base vide sauf indication. */
function reponses(sur: { mesures?: (curseur: unknown) => unknown[]; limites?: { n: bigint; invalides: bigint }; regions?: unknown[]; chaines?: unknown[]; paires?: unknown[] } = {}) {
  return (a: Appel): unknown => {
    if (a.sql.includes("count(*) AS n FROM troncons")) return [{ n: 3n }];
    if (a.sql.includes("FROM regions ORDER BY id")) return [{ id: 1, nom: "Boké" }, { id: 2, nom: "Kindia" }];
    if (a.sql.includes("FROM limites_admin") && a.sql.includes("FILTER")) return [sur.limites ?? { n: 2n, invalides: 0n }];
    if (a.sql.includes("WITH lim AS")) return sur.regions ?? [];
    if (a.sql.includes("AS \"geomValide\"")) return (sur.mesures ?? (() => []))(a.valeurs.find((v) => typeof v === "string"));
    if (a.sql.includes("t.\"sectionPk\", t.\"regionId\"")) return sur.chaines ?? [];
    if (a.sql.includes("AS \"partenaireId\"")) return sur.paires ?? [];
    throw new Error(`Requete inattendue : ${a.sql.slice(0, 80)}`);
  };
}

const MAINTENANT = new Date("2026-10-26T12:00:00Z");

describe("Requetes emises", () => {
  it("toutes sont des SELECT ou des WITH ... SELECT, jamais autre chose", async () => {
    const { db, appels } = fauxClient(reponses({ mesures: () => [mesure("a")] }));
    await lancerDetecteurs(db, { portee: { regionId: 1 }, maintenant: MAINTENANT, tailleLot: 10 });
    expect(appels.length).toBeGreaterThan(5);
    for (const a of appels) expect(a.sql).toMatch(/^(SELECT|WITH)\b/);
  });
  it("la portee regionale est passee en parametre lie, jamais concatenee", async () => {
    const { db, appels } = fauxClient(reponses());
    await lancerDetecteurs(db, { portee: { regionId: 42 }, maintenant: MAINTENANT });
    expect(appels.some((a) => a.valeurs.includes(42))).toBe(true);
    for (const a of appels) expect(a.sql).not.toContain("42");
  });
});

describe("Pagination par curseur", () => {
  it("parcourt toutes les pages et s'arrete a la derniere (incomplete)", async () => {
    const curseurs: unknown[] = [];
    const pages: Record<string, unknown[]> = {
      "": [mesure("a"), mesure("b")],
      b: [mesure("c"), mesure("d")],
      d: [mesure("e")],
    };
    const { db } = fauxClient(reponses({ mesures: (curseur) => { curseurs.push(curseur ?? null); return pages[String(curseur ?? "")] ?? []; } }));
    const r = await lancerDetecteurs(db, { portee: { regionId: null }, familles: ["GEOMETRIE"], maintenant: MAINTENANT, tailleLot: 2 });
    expect(curseurs).toEqual([null, "b", "d"]);
    expect(r.total).toBe(0);
  });
  it("une page exactement pleine declenche une page de plus, vide", async () => {
    const curseurs: unknown[] = [];
    const pages: Record<string, unknown[]> = { "": [mesure("a"), mesure("b")], b: [] };
    const { db } = fauxClient(reponses({ mesures: (curseur) => { curseurs.push(curseur ?? null); return pages[String(curseur ?? "")] ?? []; } }));
    await lancerDetecteurs(db, { portee: { regionId: null }, familles: ["GEOMETRIE"], maintenant: MAINTENANT, tailleLot: 2 });
    expect(curseurs).toEqual([null, "b"]);
  });
});

describe("Rapport", () => {
  it("compte par code, par region, et liste les codes sans anomalie", async () => {
    const { db } = fauxClient(reponses({
      mesures: (curseur) => (curseur ? [] : [
        mesure("a", { pkDebut: 0, pkFin: 0 }),
        mesure("b", { pkDebut: 0, pkFin: 0, regionId: 2 }),
        mesure("c", { geomValide: false, raisonInvalide: "Self-intersection" }),
        mesure("d"),
      ]),
    }));
    const r = await lancerDetecteurs(db, { portee: { regionId: null }, familles: ["PK", "GEOMETRIE"], maintenant: MAINTENANT });
    const par = Object.fromEntries(r.parCode.map((c) => [c.code, c.nombre]));
    expect(par).toEqual({ PK_SENTINELLE_ZERO: 2, GEOM_INVALIDE: 1 });
    expect(r.parRegion.map((x) => [x.regionId, x.regionNom, x.total])).toEqual([[1, "Boké", 2], [2, "Kindia", 1]]);
    expect(r.codesSansAnomalie).toContain("PK_CHEVAUCHEMENT");
    expect(r.codesSansAnomalie).not.toContain("PK_SENTINELLE_ZERO");
    // Les familles non demandees n'apparaissent pas parmi les codes « sans anomalie ».
    expect(r.codesSansAnomalie).not.toContain("DOUBLON_GEOMETRIE_STRICT");
    expect(r.populationTronconsActifs).toBe(3);
  });
  it("une famille non demandee n'est pas executee (aucune requete de region ni de doublons)", async () => {
    const { db, appels } = fauxClient(reponses({ mesures: () => [] }));
    await lancerDetecteurs(db, { portee: { regionId: 1 }, familles: ["ETAT"], maintenant: MAINTENANT });
    expect(appels.some((a) => a.sql.includes("WITH lim AS"))).toBe(false);
    expect(appels.some((a) => a.sql.includes("partenaireId"))).toBe(false);
    expect(appels.some((a) => a.sql.includes("sectionPk"))).toBe(false);
  });
  it("rend les seuils appliques, provisoires, avec leur origine, et ce qui n'est pas couvert", async () => {
    const { db } = fauxClient(reponses());
    const r = await lancerDetecteurs(db, { portee: { regionId: 1 }, maintenant: MAINTENANT, seuils: { PK_TROU_KM: 2 } });
    expect(r.seuils.every((s) => s.statut === "PROVISOIRE" && s.origine.length > 10)).toBe(true);
    expect(r.seuils.find((s) => s.nom === "PK_TROU_KM")?.valeur).toBe(2);
    expect(r.nonCouvert).toEqual([...NON_COUVERT]);
    expect(r.familles).toEqual(TOUTES_FAMILLES);
    expect(r.genereLe).toBe(MAINTENANT.toISOString());
  });
  it("refuse un seuil invalide", async () => {
    const { db } = fauxClient(reponses());
    await expect(lancerDetecteurs(db, { portee: { regionId: 1 }, seuils: { PK_TROU_KM: -3 } })).rejects.toThrow(/invalide/);
  });
});

describe("Region : base sans limites", () => {
  it("n'execute pas la famille REGION et l'avertit, au lieu de dire tout hors territoire", async () => {
    const { db, appels } = fauxClient(reponses({ limites: { n: 0n, invalides: 0n } }));
    const r = await lancerDetecteurs(db, { portee: { regionId: null }, familles: ["REGION"], maintenant: MAINTENANT });
    expect(appels.some((a) => a.sql.includes("WITH lim AS"))).toBe(false);
    expect(r.avertissements.join(" ")).toMatch(/Aucune limite de niveau 1/);
    expect(r.total).toBe(0);
  });
  it("signale les limites invalides ecartees", async () => {
    const { db } = fauxClient(reponses({ limites: { n: 5n, invalides: 2n } }));
    const r = await lancerDetecteurs(db, { portee: { regionId: null }, familles: ["REGION"], maintenant: MAINTENANT });
    expect(r.avertissements.join(" ")).toMatch(/2 limite\(s\) de niveau 1 invalide\(s\)/);
  });
  it("classe une mesure de region (hors territoire)", async () => {
    const { db } = fauxClient(reponses({
      regions: [{ id: "x", code: "X", regionId: 1, regionNom: "Boké", regionCle: "boke", regionNonRenseignee: false, regionALimite: true, perimetre: null, parts: [] }],
    }));
    const r = await lancerDetecteurs(db, { portee: { regionId: null }, familles: ["REGION"], maintenant: MAINTENANT });
    expect(r.parCode.map((c) => c.code)).toEqual(["HORS_TERRITOIRE"]);
  });
});

describe("Chainage de PK et portee", () => {
  const chaines = [
    { id: "a", code: "A", nom: "RN1", sectionPk: "1", regionId: 1, pkDebut: 0, pkFin: 10 },
    { id: "b", code: "B", nom: "RN1", sectionPk: "1", regionId: 2, pkDebut: 8, pkFin: 20 },
    { id: "c", code: "C", nom: "RN9", sectionPk: "1", regionId: 3, pkDebut: 0, pkFin: 10 },
    { id: "d", code: "D", nom: "RN9", sectionPk: "1", regionId: 3, pkDebut: 5, pkFin: 15 },
  ];
  it("en portee nationale, tout est retenu", async () => {
    const { db } = fauxClient(reponses({ chaines }));
    const r = await lancerDetecteurs(db, { portee: { regionId: null }, familles: ["PK"], maintenant: MAINTENANT });
    expect(r.parCode.find((c) => c.code === "PK_CHEVAUCHEMENT")?.nombre).toBe(2);
  });
  it("en portee regionale, on garde les anomalies dont le troncon OU son partenaire est dans la region", async () => {
    const { db } = fauxClient(reponses({ chaines }));
    // Region 1 : b (region 2) chevauche a (region 1) -> retenu ; la paire c/d est en region 3 -> ecartee.
    const r = await lancerDetecteurs(db, { portee: { regionId: 1 }, familles: ["PK"], maintenant: MAINTENANT });
    expect(r.parCode.find((c) => c.code === "PK_CHEVAUCHEMENT")?.nombre).toBe(1);
  });
});

describe("Doublons : plafond de paires", () => {
  it("avertit quand le plafond de paires est atteint", async () => {
    const paire = { id: "a", code: "A", regionId: 1, partenaireId: "b", partenaireCode: "B", partenaireRegionId: 1, partenaireSourceReference: null, binaireIdentique: true, inverseIdentique: false, hausdorffDeg: null };
    const { db } = fauxClient(reponses({ paires: new Array(200_000).fill(paire) }));
    const r = await lancerDetecteurs(db, { portee: { regionId: 1 }, familles: ["DOUBLON"], maintenant: MAINTENANT });
    expect(r.avertissements.join(" ")).toMatch(/plafond de 200000 paires/);
  });
});

describe("lancerEnLectureSeule", () => {
  it("ouvre une transaction READ ONLY AVANT toute lecture, avec un delai long", async () => {
    const ordre: string[] = [];
    const tx = {
      $executeRaw: (s: TemplateStringsArray) => { ordre.push(`exec:${s.join("").trim()}`); return Promise.resolve(0); },
      $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => { ordre.push("lecture"); return Promise.resolve(reponses()({ sql: texte(s, v), valeurs: v })); },
    };
    const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>, opts: { timeout: number }) => { void opts; return fn(tx); });
    await lancerEnLectureSeule({ $transaction: transaction } as never, { portee: { regionId: 1 }, familles: ["ETAT"], maintenant: MAINTENANT });
    expect(ordre[0]).toBe("exec:SET TRANSACTION READ ONLY");
    expect(ordre.slice(1).every((o) => o === "lecture")).toBe(true);
    expect(transaction.mock.calls[0][1].timeout).toBeGreaterThan(60_000);
  });
});
