import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ERREURS_JOB, STATUTS_JOB, TRANSITIONS, codeApi, codeRelancable, decider, echeancePerte, messageErreur, progressionDepuisEtape, spoolIdDe, RE_SPOOL_ID,
  transitionPermise, type JobObserve, type ParametresDecision, type StatutJob,
} from "./contrat.noyau";

/** Machine a etats des jobs, correspondance des codes d'erreur et decision du sondage : noyau PUR (lot B2). */

const T0 = new Date("2026-11-08T10:00:00.000Z");
const dans = (s: number) => new Date(T0.getTime() + s * 1000);
const P: ParametresDecision = { maintenant: T0, delaiJobS: 90, concurrence: 2, margeS: 30 };
const job = (o: Partial<JobObserve> = {}): JobObserve => ({ statut: "EN_COURS", tentatives: 1, tentativesMax: 3, reclameLe: T0, expireLe: dans(86_400), ...o });

describe("transitions des jobs", () => {
  it("les statuts finals ne mènent nulle part, TERMINE ne mène qu'à EXPIRE", () => {
    for (const s of ["ECHEC", "ANNULE", "EXPIRE"] as StatutJob[]) expect(TRANSITIONS[s]).toEqual([]);
    expect(TRANSITIONS.TERMINE).toEqual(["EXPIRE"]);
    expect(transitionPermise("EN_ATTENTE", "TERMINE")).toBe(false);
    expect(transitionPermise("ECHEC", "EN_ATTENTE")).toBe(false);
    expect(transitionPermise("EN_COURS", "EN_ATTENTE")).toBe(true); // relance controlée
  });

  it("miroir exact du déclencheur de la base (migration 20261102200000)", () => {
    const sql = readFileSync(path.join(__dirname, "../../../prisma/migrations/20261102200000_import_jobs_gdal/migration.sql"), "utf8");
    const bloc = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION projets_voirie_import_jobs_transition"), sql.indexOf("CREATE OR REPLACE FUNCTION projets_voirie_import_jobs_refuse_suppression"));
    const dansLaBase: Record<string, string[]> = {};
    for (const m of bloc.matchAll(/OLD\."statut" = '([A-Z_]+)'\s+AND NEW\."statut" (?:IN \(([^)]*)\)|= '([A-Z_]+)')/g)) {
      dansLaBase[m[1]] = (m[2] ? [...m[2].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]) : [m[3]]);
    }
    for (const s of STATUTS_JOB) {
      expect([...(dansLaBase[s] ?? [])].sort(), `transitions depuis ${s}`).toEqual([...TRANSITIONS[s]].sort());
    }
  });
});

describe("codes d'erreur : jamais le texte du conteneur", () => {
  it("un code inconnu devient CONVERSION_ECHEC, et l'API n'a que des messages fixes", () => {
    expect(codeApi("N_IMPORTE_QUOI")).toBe("CONVERSION_ECHEC");
    expect(codeApi(null)).toBe("CONVERSION_ECHEC");
    expect(codeApi("__proto__")).toBe("CONVERSION_ECHEC");
    expect(codeApi("constructor")).toBe("CONVERSION_ECHEC");
    expect(codeApi("CRS_CONFLIT")).toBe("CRS_CONFLIT");
    expect(messageErreur("CRS_CONFLIT")).toMatch(/CRS/);
    for (const [code, def] of Object.entries(ERREURS_JOB)) {
      expect(def.message, code).not.toMatch(/\/(tmp|spool|opt)\b|\\|C:/);
    }
  });

  it("seul INTERROMPU justifie une nouvelle tentative", () => {
    const relancables = Object.keys(ERREURS_JOB).filter((c) => codeRelancable(c));
    expect(relancables).toEqual(["INTERROMPU"]);
  });

  it("tous les codes du contrat du conteneur (CHAINE-GDAL.md 4.3 et DXF) ont un libellé", () => {
    const doc = readFileSync(path.join(__dirname, "../../../../docs/projets-voirie/CHAINE-GDAL.md"), "utf8");
    const section = doc.slice(doc.indexOf("### 4.3 Codes d'échec"), doc.indexOf("### 4.4"));
    const codes = [...section.matchAll(/`([A-Z][A-Z_]{3,})`/g)].map((m) => m[1]).filter((c) => c !== "PILOTES_NON_CONFORMES");
    expect(codes.length).toBeGreaterThan(40);
    const manquants = codes.filter((c) => !Object.prototype.hasOwnProperty.call(ERREURS_JOB, c));
    expect(manquants).toEqual([]);
  });
});

describe("décision du sondage (decider)", () => {
  it("un job EN_COURS dont le conteneur a fini est VALIDE, jamais cru sur parole", () => {
    expect(decider(job(), { etat: "termine" }, P)).toEqual({ type: "VALIDER" });
  });

  it("échec du conteneur : code connu, ou INTERROMPU relancé tant qu'il reste des tentatives", () => {
    expect(decider(job(), { etat: "echec", code: "CRS_CONFLIT" }, P)).toEqual({ type: "ECHEC", code: "CRS_CONFLIT" });
    expect(decider(job(), { etat: "echec", code: "TEXTE_INVENTE_PAR_LE_CONTENEUR" }, P)).toEqual({ type: "ECHEC", code: "CONVERSION_ECHEC" });
    expect(decider(job({ tentatives: 1 }), { etat: "echec", code: "INTERROMPU" }, P)).toEqual({ type: "RELANCER", raison: "INTERROMPU" });
    expect(decider(job({ tentatives: 3 }), { etat: "echec", code: "INTERROMPU" }, P)).toEqual({ type: "ECHEC", code: "INTERROMPU" });
  });

  it("un job transmis sans réponse : attente jusqu'à l'échéance de perte, puis relance bornée, puis JOB_PERDU", () => {
    const echeance = echeancePerte(T0, P);
    expect(echeance.getTime() - T0.getTime()).toBe((90 * 2 + 30) * 1000);
    expect(decider(job(), { etat: "absent" }, { ...P, maintenant: dans(209) })).toEqual({ type: "RIEN" });
    expect(decider(job(), { etat: "en_cours", etape: "conversion" }, { ...P, maintenant: dans(100) })).toEqual({ type: "PROGRES", etape: "conversion" });
    expect(decider(job(), { etat: "absent" }, { ...P, maintenant: dans(210) })).toEqual({ type: "RELANCER", raison: "JOB_PERDU" });
    expect(decider(job({ tentatives: 3 }), { etat: "absent" }, { ...P, maintenant: dans(210) })).toEqual({ type: "ECHEC", code: "JOB_PERDU" });
    expect(decider(job({ tentatives: 3 }), { etat: "en_cours", etape: "conversion" }, { ...P, maintenant: dans(900) })).toEqual({ type: "ECHEC", code: "JOB_PERDU" });
  });

  it("un statut illisible est traité comme une absence jusqu'à l'échéance, puis refusé (SORTIE_INVALIDE)", () => {
    expect(decider(job(), { etat: "illisible" }, { ...P, maintenant: dans(10) })).toEqual({ type: "RIEN" });
    expect(decider(job({ tentatives: 3 }), { etat: "illisible" }, { ...P, maintenant: dans(300) })).toEqual({ type: "ECHEC", code: "SORTIE_INVALIDE" });
  });

  it("l'expiration prime : fichiers temporaires jamais conservés au-delà de expireLe", () => {
    expect(decider(job({ statut: "EN_ATTENTE", expireLe: dans(-1) }), null, P)).toEqual({ type: "EXPIRER" });
    expect(decider(job({ statut: "TERMINE", expireLe: dans(-1) }), null, P)).toEqual({ type: "EXPIRER" });
    expect(decider(job({ statut: "EN_COURS", expireLe: dans(-1) }), { etat: "termine" }, P)).toEqual({ type: "EXPIRER" });
    expect(decider(job({ statut: "EN_ATTENTE", expireLe: dans(60) }), null, P)).toEqual({ type: "RIEN" });
    for (const s of ["ECHEC", "ANNULE", "EXPIRE"] as StatutJob[]) expect(decider(job({ statut: s, expireLe: dans(-1) }), null, P)).toEqual({ type: "RIEN" });
  });

  it("aucune relance sans limite : au plus tentativesMax", () => {
    let tentatives = 1;
    let relances = 0;
    for (let i = 0; i < 20; i++) {
      const d = decider(job({ tentatives, tentativesMax: 3 }), { etat: "echec", code: "INTERROMPU" }, P);
      if (d.type !== "RELANCER") break;
      relances++;
      tentatives++;
    }
    expect(relances).toBe(2);
  });
});

describe("identifiants du spool et progression", () => {
  it("<uuid>-t<n> respecte le contrat du conteneur et le motif strict", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(spoolIdDe(id, 2)).toBe(`${id}-t2`);
    expect(RE_SPOOL_ID.test(spoolIdDe(id, 2))).toBe(true);
    expect(/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(spoolIdDe(id, 2))).toBe(true);
    for (const mauvais of ["../x", `${id}`, `${id}-t0`, `${id}-t10`, `${id}/../x-t1`, "A".repeat(80)]) expect(RE_SPOOL_ID.test(mauvais), mauvais).toBe(false);
  });

  it("l'étape du conteneur donne un pourcentage croissant, une étape inconnue 0", () => {
    expect(progressionDepuisEtape("conversion")).toBeGreaterThan(progressionDepuisEtape("inventaire"));
    expect(progressionDepuisEtape("__proto__")).toBe(0);
    expect(progressionDepuisEtape(42)).toBe(0);
  });
});
