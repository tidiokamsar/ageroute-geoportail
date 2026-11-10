import { describe, expect, it } from "vitest";
import * as S from "./projetsVoirieSources";
import { lireComparaison } from "./projetsVoirieSourcesApi";

/**
 * Revue du lot UI-C, M1 : « bareme approuve » n'est JAMAIS deduit de originePrecision = CLASSE. Seuls les champs explicites du serveur
 * (correctifs fix/vague3-revue-t1s1 : regle.bareme.source = REGLE_APPROUVEE avec approuveParId, resume.bareme.regle.approuveParId) l'attestent.
 * Serveur ancien (champs absents) : « provenance du corridor non attestee » ; regle systeme : jamais « approuve ». Donnees synthetiques.
 */

const BASE = { id: "c", statut: "TERMINEE", jeux: [] };
const classe = { precisionM: 2, originePrecision: "CLASSE" as const };

describe("provenance du bareme d'une comparaison", () => {
  it("serveur ancien (aucun champ de provenance) : non attestee, meme avec un bareme dans la regle", () => {
    const c = lireComparaison({ ...BASE, regle: { regleId: "r", code: "R-1", version: 2, precisionParClasseM: { A: 0.5, B: 1, C: 2, D: 5 } }, resume: { totaux: {} } })!;
    const p = S.provenanceBareme(c, false);
    expect(p.etat).toBe("NON_ATTESTE");
    expect(S.provenancePrecision(classe, p)).toBe("2 m, attribuée à la classe par le barème de la règle R-1 v2 (provenance du corridor non attestée)");
    expect(S.provenancePrecision(classe, p)).not.toMatch(/approuvé/);
  });
  it("regle systeme : « bareme provisoire du systeme », jamais « approuve », meme si un champ le pretendait", () => {
    const c = lireComparaison({ ...BASE, regle: { regleId: "r0", code: "S1-CORRIDOR-0.1", version: 0, precisionParClasseM: { A: 0.5 }, bareme: { applicable: true, applique: true, source: "REGLE_APPROUVEE", approuveParId: "x" } } })!;
    const p = S.provenanceBareme(c, true);
    expect(p.etat).toBe("SYSTEME");
    expect(S.provenancePrecision(classe, p)).toBe("2 m, attribuée à la classe par le barème provisoire du système (règle S1-CORRIDOR-0.1 v0), jamais approuvé");
  });
  it("bareme atteste par le serveur (source REGLE_APPROUVEE et approbateur) : « bareme approuve », avec la regle et la version", () => {
    const c = lireComparaison({
      ...BASE, regle: { regleId: "r5", code: "R-B", version: 3, precisionParClasseM: { A: 0.5, B: 1, C: 2, D: 5 }, bareme: { applicable: true, applique: true, source: "REGLE_APPROUVEE", approuveParId: "u9" } },
      resume: { totaux: {}, bareme: { applique: true, couples: 4, regle: { regleId: "r5", code: "R-B", version: 3, approuveParId: "u9" } }, corridor: { origine: "BAREME_APPROUVE" } },
    })!;
    const p = S.provenanceBareme(c, false);
    expect(p).toMatchObject({ etat: "ATTESTE", code: "R-B", version: 3, couples: 4 });
    expect(S.provenancePrecision(classe, p)).toBe("2 m, attribuée à la classe par le barème approuvé de la règle R-B v3");
  });
  it("source REGLE_APPROUVEE sans approbateur : non attestee", () => {
    const c = lireComparaison({ ...BASE, regle: { code: "R", version: 1, precisionParClasseM: { A: 1 }, bareme: { source: "REGLE_APPROUVEE", approuveParId: null } } })!;
    expect(S.provenanceBareme(c, false).etat).toBe("NON_ATTESTE");
  });
  it("aucun bareme : etat AUCUN ; une precision declaree reste dite telle", () => {
    const c = lireComparaison({ ...BASE, regle: { code: "S1-CORRIDOR-0.2", version: 0, precisionParClasseM: null }, resume: { totaux: {}, bareme: { applique: false, couples: 0, regle: null } } })!;
    const p = S.provenanceBareme(c, false);
    expect(p.etat).toBe("AUCUN");
    expect(S.provenancePrecision({ precisionM: 1, originePrecision: "OBJET" }, p)).toBe("1 m, déclarée pour l'objet");
  });
});
