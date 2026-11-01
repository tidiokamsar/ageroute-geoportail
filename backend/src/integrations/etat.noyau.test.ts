import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decider, delaiAvantReprise, estTerminal, POLITIQUE_PAR_DEFAUT, transitionPermise, TRANSITIONS,
} from "./etat.noyau";
import { STATUTS_OUTBOX, type ResultatEmission } from "./types";

/**
 * Machine a etats et politique de reprise. Ce que ces tests defendent :
 *   - ENVOYE est terminal (c'est ce qui rend le rejeu sans effet) ;
 *   - la liste des transitions est IDENTIQUE a celle du declencheur de la base ;
 *   - la temporisation est exponentielle, bornee, et la gigue ne depasse jamais le plafond ;
 *   - un echec temporaire se retente jusqu'a la borne puis part en file morte ; un refus definitif
 *     n'est pas retente.
 */
const MAINTENANT = new Date("2026-10-24T08:00:00.000Z");
const P = { tentativesMax: 4, delaiBaseMs: 1_000, delaiPlafondMs: 10_000 };

const accepte: ResultatEmission = { issue: "ACCEPTE", accuseReference: "R-1", codeHttp: 200 };
const temporaire: ResultatEmission = { issue: "ECHEC_TEMPORAIRE", codeErreur: "HTTP_503", message: "reponse HTTP 503", codeHttp: 503 };
const definitif: ResultatEmission = { issue: "ECHEC_DEFINITIF", codeErreur: "HTTP_422", message: "refus HTTP 422", codeHttp: 422 };

describe("transitions", () => {
  it("ENVOYE est terminal : aucune transition n'en sort", () => {
    expect(TRANSITIONS.ENVOYE).toEqual([]);
    expect(estTerminal("ENVOYE")).toBe(true);
    for (const vers of STATUTS_OUTBOX) expect(transitionPermise("ENVOYE", vers)).toBe(false);
  });

  it("ABANDONNE ne se releve que par une relance humaine (EN_ATTENTE)", () => {
    expect(TRANSITIONS.ABANDONNE).toEqual(["EN_ATTENTE"]);
  });

  it("on n'atteint ENVOYE que depuis EN_COURS", () => {
    const sources = STATUTS_OUTBOX.filter((s) => transitionPermise(s, "ENVOYE"));
    expect(sources).toEqual(["EN_COURS"]);
  });

  it("EN_ATTENTE ne saute pas l'etape EN_COURS", () => {
    expect(transitionPermise("EN_ATTENTE", "ENVOYE")).toBe(false);
    expect(transitionPermise("EN_ATTENTE", "ECHEC")).toBe(false);
  });

  it("la liste est IDENTIQUE a celle du declencheur outbox_garde de la migration", () => {
    const sql = readFileSync(join(__dirname, "../../prisma/migrations/20261024200000_outbox_integrations/migration.sql"), "utf8");
    const bloc = sql.slice(sql.indexOf("IF NOT ((OLD.\"statut\", NEW.\"statut\") IN ("), sql.indexOf("RAISE EXCEPTION 'outbox_evenements : transition"));
    const paires = [...bloc.matchAll(/\('([A-Z_]+)', '([A-Z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const attendues = STATUTS_OUTBOX.flatMap((de) => TRANSITIONS[de].map((vers) => `${de}>${vers}`)).sort();
    expect(paires.length).toBeGreaterThan(5);
    expect(paires).toEqual(attendues);
  });
});

describe("temporisation exponentielle bornee", () => {
  it("double a chaque echec jusqu'au plafond", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => delaiAvantReprise(n, P))).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });

  it("ne depasse jamais le plafond, meme pour un nombre d'echecs absurde", () => {
    expect(delaiAvantReprise(10_000, P)).toBe(10_000);
    expect(delaiAvantReprise(Number.MAX_SAFE_INTEGER, P)).toBe(10_000);
  });

  it("la gigue ne fait que RACCOURCIR (jamais plus de 20 %) : le plafond reste un plafond", () => {
    for (const g of [0, 0.25, 0.5, 0.999999, 5, -3]) {
      const d = delaiAvantReprise(6, P, g);
      expect(d).toBeLessThanOrEqual(10_000);
      expect(d).toBeGreaterThanOrEqual(8_000);
    }
  });

  it("traite 0 ou un negatif comme le premier echec", () => {
    expect(delaiAvantReprise(0, P)).toBe(1_000);
    expect(delaiAvantReprise(-5, P)).toBe(1_000);
  });

  it("les valeurs par defaut sont raisonnables : 30 s de base, 1 h de plafond, 8 tentatives", () => {
    expect(POLITIQUE_PAR_DEFAUT).toEqual({ tentativesMax: 8, delaiBaseMs: 30_000, delaiPlafondMs: 3_600_000 });
  });
});

describe("decider", () => {
  it("accepte -> ENVOYE avec la reference d'accuse", () => {
    const d = decider(accepte, { tentativesAvant: 0, maintenant: MAINTENANT, politique: P });
    expect(d).toEqual({ statut: "ENVOYE", tentatives: 1, accuseReference: "R-1", doublon: false });
  });

  it("un doublon reconnu par le destinataire vaut envoi", () => {
    const d = decider({ issue: "DOUBLON_RECONNU", accuseReference: "R-0", codeHttp: 200 }, { tentativesAvant: 2, maintenant: MAINTENANT, politique: P });
    expect(d).toMatchObject({ statut: "ENVOYE", tentatives: 3, doublon: true });
  });

  it("echec temporaire -> ECHEC, reprise a maintenant + delai exponentiel", () => {
    const d1 = decider(temporaire, { tentativesAvant: 0, maintenant: MAINTENANT, politique: P });
    expect(d1).toMatchObject({ statut: "ECHEC", tentatives: 1 });
    expect((d1 as { prochaineTentativeLe: Date }).prochaineTentativeLe.getTime()).toBe(MAINTENANT.getTime() + 1_000);
    const d2 = decider(temporaire, { tentativesAvant: 1, maintenant: MAINTENANT, politique: P });
    expect((d2 as { prochaineTentativeLe: Date }).prochaineTentativeLe.getTime()).toBe(MAINTENANT.getTime() + 2_000);
  });

  it("tentatives epuisees -> ABANDONNE (file morte), avec le motif et le dernier code", () => {
    const d = decider(temporaire, { tentativesAvant: 3, maintenant: MAINTENANT, politique: P });
    expect(d).toMatchObject({ statut: "ABANDONNE", tentatives: 4, code: "HTTP_503" });
    expect((d as { motifAbandon: string }).motifAbandon).toContain("TENTATIVES_EPUISEES");
    expect((d as { motifAbandon: string }).motifAbandon).toContain("4 sur 4");
  });

  it("un accuse invalide est retente comme un echec temporaire (on ignore si le destinataire a traite)", () => {
    const d = decider({ issue: "ACCUSE_INVALIDE", codeErreur: "ACCUSE_ILLISIBLE", message: "x", codeHttp: 200 }, { tentativesAvant: 0, maintenant: MAINTENANT, politique: P });
    expect(d).toMatchObject({ statut: "ECHEC", tentatives: 1, code: "ACCUSE_ILLISIBLE" });
  });

  it("un refus definitif part DIRECTEMENT en file morte, sans retente", () => {
    const d = decider(definitif, { tentativesAvant: 0, maintenant: MAINTENANT, politique: P });
    expect(d).toMatchObject({ statut: "ABANDONNE", tentatives: 1, code: "HTTP_422" });
    expect((d as { motifAbandon: string }).motifAbandon).toContain("REFUS_DEFINITIF");
  });

  it("le nombre de tentatives ne depasse jamais tentativesMax (contrainte outbox_compteurs)", () => {
    for (let avant = 0; avant < P.tentativesMax; avant += 1) {
      for (const r of [accepte, temporaire, definitif]) {
        const d = decider(r, { tentativesAvant: avant, maintenant: MAINTENANT, politique: P });
        expect(d.tentatives).toBeLessThanOrEqual(P.tentativesMax);
      }
    }
  });

  it("sans fin : quatre echecs consecutifs menent exactement a ABANDONNE a la quatrieme", () => {
    const statuts: string[] = [];
    let n = 0;
    for (;;) {
      const d = decider(temporaire, { tentativesAvant: n, maintenant: MAINTENANT, politique: P });
      statuts.push(d.statut);
      n = d.tentatives;
      if (d.statut !== "ECHEC") break;
    }
    expect(statuts).toEqual(["ECHEC", "ECHEC", "ECHEC", "ABANDONNE"]);
  });
});
