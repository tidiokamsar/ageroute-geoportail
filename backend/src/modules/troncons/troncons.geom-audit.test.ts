import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * L'ecriture du trace d'un tronçon : ce que ces tests defendent.
 *
 * LE DEFAUT, CONSTATE LE 13/10/2026
 *
 * `updateGeomOnly` ecrivait la geometrie et n'auditait RIEN. Le controleur ne lui
 * transmettait meme pas l'identifiant de l'utilisateur, pourtant verifie juste au-dessus.
 *
 * Le trace d'un tronçon n'est pas un champ decoratif : c'est lui qui commande la carte,
 * la longueur geometrique, l'appariement GPS et donc le lineaire publie. Il pouvait etre
 * remplace sans qu'on puisse dire par qui ni quand — la regle 3 d'AGENTS.md, « toute
 * ecriture est auditee », manquee sur le champ le plus consequent de la base.
 *
 * CE QUI EST VERIFIE ICI
 *
 * Qu'une ecriture de trace laisse une trace, que cette trace nomme son auteur, et qu'elle
 * dit ce qui a ete REMPLACE — un trace de mille points qui devient un trace de deux, ou
 * qui perd quarante kilometres, doit se voir.
 *
 * CE QUI NE L'EST PAS : que PostgreSQL annule. `$transaction` est simule.
 */

const h = vi.hoisted(() => ({
  /** Operations observees dans la transaction, dans l'ordre. */
  journal: [] as string[],
  audits: [] as Record<string, unknown>[],
  /** Resume du trace existant que `$queryRaw` doit rendre. */
  resumeExistant: [{ points: 1240, metres: 21570.4 }] as unknown[],
}));

vi.mock("../../lib/prisma", () => {
  const client = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      // Controle du trace AVANT toute ecriture (lot I) : hors transaction, hors du journal verifie ici.
      if (strings.join("?").includes("ST_IsValidReason")) return [{ valide: true, raison: "Valid Geometry", xmin: -13.7, ymin: 9.5, xmax: -13.6, ymax: 9.6 }];
      h.journal.push("lecture-resume");
      return h.resumeExistant;
    }),
    $executeRaw: vi.fn(async () => {
      h.journal.push("ecriture-geom");
      return 1;
    }),
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.journal.push("audit");
        h.audits.push(data);
        return data;
      }),
    },
    troncon: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    valeurQualite: { upsert: vi.fn(async () => ({})) },
  };
  return {
    prisma: {
      ...client,
      // Le client de transaction EST le meme objet : ce test ne distingue pas les deux,
      // il verifie que les trois operations passent par un seul appel transactionnel.
      $transaction: vi.fn(async (arg: unknown) => {
        if (typeof arg === "function") {
          h.journal.push("transaction-ouverte");
          return (arg as (t: unknown) => Promise<unknown>)(client);
        }
        return Promise.all(arg as Promise<unknown>[]);
      }),
    },
  };
});

vi.mock("../../lib/excel", () => ({
  buildExportBuffer: vi.fn(), parseImportBuffer: vi.fn(), formatImportError: vi.fn(),
}));
vi.mock("../../lib/regions", () => ({ resolveRegionId: vi.fn() }));

import { tronconsService } from "./troncons.service";

const trace = { type: "LineString", coordinates: [[-13.7, 9.5], [-13.6, 9.6], [-13.5, 9.7]] as number[][] };

beforeEach(() => {
  h.journal = [];
  h.audits = [];
  h.resumeExistant = [{ points: 1240, metres: 21570.4 }];
  vi.clearAllMocks();
});

describe("Une geometrie ne se reecrit plus sans trace", () => {
  it("AUDITE l'ecriture du trace, avec son auteur", async () => {
    await tronconsService.updateGeomOnly("t1", trace, "u1");
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      userId: "u1", action: "UPDATE", entityType: "Troncon", entityId: "t1",
    });
  });

  it("dit CE QUI A ETE REMPLACE, pas seulement qu'il y a eu un changement", async () => {
    // Un trace de 1 240 points et 21,5 km remplace par un trace de 3 points : la trace
    // doit permettre de le reperer, sinon la degradation du lineaire publie passe
    // inapercue.
    await tronconsService.updateGeomOnly("t1", trace, "u1");
    expect(h.audits[0].before).toEqual({ geom: { points: 1240, metres: 21570 } });
    expect(h.audits[0].after).toEqual({ geom: { points: 3 } });
  });

  it("ne journalise PAS la geometrie elle-meme", async () => {
    // Un tronçon porte couramment des milliers de points. Les recopier a chaque edition
    // gonflerait une table qui doit rester consultable.
    await tronconsService.updateGeomOnly("t1", trace, "u1");
    const serialise = JSON.stringify(h.audits[0]);
    expect(serialise).not.toContain("coordinates");
    expect(serialise.length).toBeLessThan(400);
  });

  it("distingue un trace AJOUTE d'un trace remplace", async () => {
    // Aucune geometrie avant : `before` doit le dire plutot que de rendre des zeros, qui
    // se liraient comme un trace de longueur nulle.
    h.resumeExistant = [{ points: null, metres: null }];
    await tronconsService.updateGeomOnly("t1", trace, "u1");
    expect(h.audits[0].before).toEqual({ geom: null });
  });

  it("gere un tronçon absent sans inventer de resume", async () => {
    h.resumeExistant = [];
    await tronconsService.updateGeomOnly("t1", trace, "u1");
    expect(h.audits[0].before).toEqual({ geom: null });
  });
});

describe("Les trois operations partent ensemble", () => {
  it("ouvre UNE transaction et y lit, ecrit, puis audite", async () => {
    await tronconsService.updateGeomOnly("t1", trace, "u1");
    expect(h.journal).toEqual(["transaction-ouverte", "lecture-resume", "ecriture-geom", "audit"]);
  });

  it("lit le resume AVANT d'ecrire, et dans la transaction", async () => {
    // Lire avant d'ouvrir la transaction laisserait une fenetre ou une autre edition
    // s'intercale : l'audit comparerait alors a un etat qui n'a jamais precede celui-ci.
    await tronconsService.updateGeomOnly("t1", trace, "u1");
    expect(h.journal.indexOf("lecture-resume")).toBeGreaterThan(h.journal.indexOf("transaction-ouverte"));
    expect(h.journal.indexOf("lecture-resume")).toBeLessThan(h.journal.indexOf("ecriture-geom"));
  });
});
