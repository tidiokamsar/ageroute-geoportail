import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Revue de la vague 1, M1 : la revue des suppressions ne se contourne pas en retirant le jeu autorise avant d'autoriser le depot en attente
 * (et O1 : un refus de revue est definitif). La base est simulee : ce qui est prouve ici, c'est CE QUE LE SERVICE DECIDE ; le scenario exact,
 * contre le SQL reel, est dans `tests-integration/import-formats.integration.mts` (section 11 bis).
 */
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://127.0.0.1:1/essai";
  process.env.JWT_ACCESS_SECRET = "essai-access-secret-essai-access-secret-0000";
  process.env.JWT_REFRESH_SECRET = "essai-refresh-secret-essai-refresh-secret-000";
});

interface Jeu {
  id: string; projetId: string; role: string; concessionnaireId: string | null; statut: string; version: number; remplaceId: string | null;
  resume: unknown; creeParId: string; deletedAt?: Date | null;
}
interface Evenement { id: string; jeuId: string; type: string; acteurId: string; justification: string; details: unknown; createdAt: Date }

const { base } = vi.hoisted(() => ({
  base: {
    jeux: [] as Jeu[],
    objets: {} as Record<string, { id: string; nom: string; empreinte: string }[]>,
    evenements: [] as Evenement[],
    audits: [] as { action: string; entityId: string }[],
    horloge: 0,
  },
}));

vi.mock("../utils/audit", () => ({
  logAuditTransactionnelle: async (_tx: unknown, e: { action: string; entityId: string }) => { base.audits.push({ action: e.action, entityId: e.entityId }); },
}));

type Critere = string | { in?: string[]; not?: string } | undefined;
const correspond = (valeur: unknown, c: Critere): boolean => {
  if (c === undefined) return true;
  if (typeof c === "string") return valeur === c;
  if (c.in) return c.in.includes(valeur as string);
  if (c.not !== undefined) return valeur !== c.not;
  return true;
};
const filtrer = (where: Record<string, Critere | null>) =>
  base.jeux.filter((j) => Object.entries(where).every(([k, c]) => (c === null ? (j as never as Record<string, unknown>)[k] === null : correspond((j as never as Record<string, unknown>)[k], c as Critere))));

const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...valeurs: unknown[]) => {
    const texte = strings.join("?");
    if (texte.includes("FOR UPDATE")) return [{ id: "p1" }];
    if (texte.includes("projets_voirie_objets")) return (base.objets[valeurs[valeurs.length - 1] as string] ?? []).map((o, i) => ({ ...o, id: String(i), attr: null }));
    return [];
  },
  jeuDonneesProjet: {
    findFirst: async ({ where }: { where: Record<string, Critere> }) => filtrer(where)[0] ?? null,
    findMany: async ({ where }: { where: Record<string, Critere> }) => filtrer(where),
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ ...base.jeux.find((j) => j.id === where.id)!, nbObjets: 0, concessionnaire: null, creePar: null, decidePar: null }),
    update: async ({ where, data }: { where: { id: string }; data: Partial<Jeu> }) => { Object.assign(base.jeux.find((j) => j.id === where.id)!, data); },
    updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Partial<Jeu> }) => { for (const j of base.jeux) if (where.id.in.includes(j.id)) Object.assign(j, data); },
  },
  evenementImportProjet: {
    findFirst: async ({ where }: { where: { jeuId: string; type: { in: string[] } } }) =>
      [...base.evenements].reverse().find((e) => e.jeuId === where.jeuId && where.type.in.includes(e.type)) ?? null,
    create: async ({ data }: { data: Omit<Evenement, "id" | "createdAt"> }) => {
      const e = { ...data, id: `ev${base.evenements.length + 1}`, createdAt: new Date(2026, 10, 7, 10, 0, base.horloge++) };
      base.evenements.push(e);
      return e;
    },
  },
  user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, nomComplet: "Acteur" }) },
};

vi.mock("../lib/prisma", () => ({ prisma: { $transaction: async (f: (t: typeof tx) => unknown) => f(tx) } }));

import { decider, retirerJeu } from "./projets.service";
import { revueSuppressions } from "./formats/revue-versions.service";
import { calculerDeltaDetaille } from "./formats/delta-detaille.noyau";

const ACTEUR = { id: "u-chef", role: "GESTIONNAIRE" };
const jeu = (id: string, statut: string, version: number, remplaceId: string | null = null): Jeu => ({
  id, projetId: "p1", role: "RESEAU_TIERS", concessionnaireId: "c1", statut, version, remplaceId, resume: {}, creeParId: "u-depose",
});
const objet = (nom: string) => ({ id: nom, nom, empreinte: `e-${nom}` });
const JUSTIF = "Controle effectue avec le chef de projet";

beforeEach(() => {
  base.evenements = []; base.audits = []; base.horloge = 0;
  // v1 (R1, R2) ; v2 (R1 seul) : la version 2 RETIRE R2.
  base.objets = { v1: [objet("R1"), objet("R2")], v2: [objet("R1")] };
  base.jeux = [jeu("v1", "AUTORISE", 1), jeu("v2", "CONTROLE", 2, "v1")];
});

const statut = (id: string) => base.jeux.find((j) => j.id === id)!.statut;
const echec = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; code?: string; extra?: Record<string, unknown> }) => e);
const empreinteRetires = () => calculerDeltaDetaille(base.objets.v2.map((o) => ({ cle: o.nom, nom: o.nom, empreinte: o.empreinte, ref: o.id })), base.objets.v1.map((o) => ({ cle: o.nom, nom: o.nom, empreinte: o.empreinte, ref: o.id }))).empreinteRetires;

describe("M1, garde 1 : retirer le jeu AUTORISE pendant qu'une nouvelle version l'attend", () => {
  it("est refuse (409 DEPOT_EN_ATTENTE avec le jeuId du depot) et ne retire rien", async () => {
    const e = await echec(retirerJeu(ACTEUR, "p1", "v1"));
    expect(e).toMatchObject({ status: 409, code: "DEPOT_EN_ATTENTE" });
    expect(e!.extra).toMatchObject({ jeuId: "v2", version: 2 });
    expect(statut("v1")).toBe("AUTORISE");
    expect(base.audits).toEqual([]);
  });

  it("le depot en attente, lui, se retire ; puis le jeu autorise se retire (rien n'attend plus)", async () => {
    await retirerJeu(ACTEUR, "p1", "v2");
    expect(statut("v2")).toBe("RETIRE");
    await retirerJeu(ACTEUR, "p1", "v1");
    expect(statut("v1")).toBe("RETIRE");
  });

  it("sans depot en attente, le retrait du jeu autorise reste possible (acte explicite et audite)", async () => {
    base.jeux = [jeu("v1", "AUTORISE", 1)];
    await retirerJeu(ACTEUR, "p1", "v1");
    expect(statut("v1")).toBe("RETIRE");
    expect(base.audits).toEqual([{ action: "DELETE", entityId: "v1" }]);
  });

  it("un jeu de role AUTRE (sans versions) n'est pas concerne", async () => {
    base.jeux = [{ ...jeu("a1", "AUTORISE", 1), role: "AUTRE", concessionnaireId: null }, { ...jeu("a2", "CONTROLE", 1), role: "AUTRE", concessionnaireId: null }];
    await retirerJeu(ACTEUR, "p1", "a1");
    expect(statut("a1")).toBe("RETIRE");
  });
});

describe("M1, garde 2 : le jeu retire n'efface pas la reference de la revue (donnee deja dans cet etat)", () => {
  beforeEach(() => { base.jeux[0].statut = "RETIRE"; });

  it("autoriser la version 2 sans revue : 409 SUPPRESSIONS_A_REVOIR (avant : autorisee sans revue)", async () => {
    const e = await echec(decider(ACTEUR, "p1", "v2", "AUTORISE", JUSTIF));
    expect(e).toMatchObject({ status: 409, code: "SUPPRESSIONS_A_REVOIR" });
    expect(e!.extra).toMatchObject({ nb: 1 });
    expect(statut("v2")).toBe("CONTROLE");
  });

  it("la revue reste possible (reference = le jeu retire, plus d'AUCUNE_SUPPRESSION) ; acceptee, l'autorisation passe", async () => {
    const r = await revueSuppressions(ACTEUR, "p1", "v2", "ACCEPTER", "R2 a ete depose, confirme par le concessionnaire");
    expect(r.suppressions).toMatchObject({ statut: "ACCEPTEES", nb: 1 });
    expect(base.evenements[0].details).toMatchObject({ jeuComparaisonId: "v1", statutComparaison: "RETIRE" });
    await decider(ACTEUR, "p1", "v2", "AUTORISE", JUSTIF);
    expect(statut("v2")).toBe("AUTORISE");
  });

  it("une revue REFUSEE bloque l'autorisation (409 SUPPRESSIONS_REFUSEES) meme avec un jeu de reference retire", async () => {
    await revueSuppressions(ACTEUR, "p1", "v2", "REFUSER", "Le regard R2 existe toujours sur le terrain");
    expect(await echec(decider(ACTEUR, "p1", "v2", "AUTORISE", JUSTIF))).toMatchObject({ status: 409, code: "SUPPRESSIONS_REFUSEES" });
    expect(statut("v2")).toBe("CONTROLE");
  });

  it("une version qui ne retire rien s'autorise sans revue (aucune regression)", async () => {
    base.objets.v2 = [objet("R1"), objet("R2"), objet("R3")];
    await decider(ACTEUR, "p1", "v2", "AUTORISE", JUSTIF);
    expect(statut("v2")).toBe("AUTORISE");
  });

  it("un premier depot (aucune reference) s'autorise sans revue", async () => {
    base.jeux = [jeu("v1", "CONTROLE", 1)];
    await decider(ACTEUR, "p1", "v1", "AUTORISE", JUSTIF);
    expect(statut("v1")).toBe("AUTORISE");
  });
});

describe("M1, cas nominal inchange : le jeu autorise existe", () => {
  it("autoriser sans revue : 409 ; avec revue acceptee : v2 AUTORISE, v1 REMPLACE", async () => {
    expect(await echec(decider(ACTEUR, "p1", "v2", "AUTORISE", JUSTIF))).toMatchObject({ code: "SUPPRESSIONS_A_REVOIR" });
    await revueSuppressions(ACTEUR, "p1", "v2", "ACCEPTER", "R2 a ete depose, confirme par le concessionnaire");
    await decider(ACTEUR, "p1", "v2", "AUTORISE", JUSTIF);
    expect([statut("v1"), statut("v2")]).toEqual(["REMPLACE", "AUTORISE"]);
  });
});

describe("O1 : un refus de revue est definitif pour l'ensemble retire", () => {
  it("ACCEPTER apres REFUSER : 409 SUPPRESSIONS_REFUSEES, aucun evenement de plus", async () => {
    await revueSuppressions(ACTEUR, "p1", "v2", "REFUSER", "Le regard R2 existe toujours sur le terrain");
    const e = await echec(revueSuppressions({ id: "u-autre", role: "ADMIN" }, "p1", "v2", "ACCEPTER", "Je prefere accepter finalement"));
    expect(e).toMatchObject({ status: 409, code: "SUPPRESSIONS_REFUSEES" });
    expect(base.evenements).toHaveLength(1);
  });

  it("REFUSER apres ACCEPTER reste permis (sens prudent) et bloque l'autorisation", async () => {
    await revueSuppressions(ACTEUR, "p1", "v2", "ACCEPTER", "R2 a ete depose, confirme par le concessionnaire");
    const r = await revueSuppressions(ACTEUR, "p1", "v2", "REFUSER", "Le concessionnaire revient sur sa confirmation");
    expect(r.suppressions.statut).toBe("REFUSEES");
    expect(await echec(decider(ACTEUR, "p1", "v2", "AUTORISE", JUSTIF))).toMatchObject({ code: "SUPPRESSIONS_REFUSEES" });
  });

  it("un autre ensemble retire (fichier corrige, autre empreinte) rouvre la revue : ACCEPTER redevient possible", async () => {
    await revueSuppressions(ACTEUR, "p1", "v2", "REFUSER", "Le regard R2 existe toujours sur le terrain");
    // Le refus porte sur l'ensemble {R2} ; ici le jeu en controle retire autre chose ({R1}) : la revue precedente ne le couvre plus.
    base.objets.v2 = [objet("R2")];
    const r = await revueSuppressions(ACTEUR, "p1", "v2", "ACCEPTER", "R1 est bien supprime selon le concessionnaire");
    expect(r.suppressions.statut).toBe("ACCEPTEES");
    expect(empreinteRetires()).toBeTypeOf("string");
  });
});
