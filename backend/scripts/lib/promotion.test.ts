import { describe, expect, it } from "vitest";
import {
  analyserEmprise, analyserCategories, analyserPrefixe,
  analyserEtat, analyserClasse, estDeclaration, casLibelleSql,
  CATEGORIES_VALIDES, LIBELLE,
} from "./promotion";

/**
 * Promotion de voirie locale en troncons — les garde-fous.
 *
 * Ce script franchit la frontiere que toute la phase 4 avait maintenue : une voie
 * promue devient un actif du patrimoine et compte dans les indicateurs. Les tests
 * portent donc sur ce qui borne son rayon d'action, pas sur le SQL.
 */

describe("L'emprise borne le rayon d'action", () => {
  it("refuse l'absence d'emprise — sinon c'est tout le pays", () => {
    expect(() => analyserEmprise(undefined)).toThrow(/obligatoire/i);
  });

  it("refuse une emprise plus large que le plafond cartographique", () => {
    // La Guinee entiere : 48 deg².
    expect(() => analyserEmprise("-15,7,-7,13")).toThrow(/trop large/i);
  });

  it("accepte l'emprise de Kaloum", () => {
    expect(analyserEmprise("-13.725,9.495,-13.680,9.540"))
      .toEqual([-13.725, 9.495, -13.68, 9.54]);
  });

  it("refuse une emprise mal formee ou inversee", () => {
    for (const b of ["1,2,3", "a,b,c,d", "-13,9,-14,10", "-13,9,-12,8", "999,9,1000,10"]) {
      expect(() => analyserEmprise(b), b).toThrow();
    }
  });
});

describe("Les categories passent par une liste blanche", () => {
  it("ecarte une valeur inventee sans echouer", () => {
    const c = analyserCategories("ACCES,'; DROP TABLE troncons--");
    expect(c).toEqual(["ACCES"]);
  });

  it("echoue si plus rien ne reste", () => {
    expect(() => analyserCategories("INEXISTANTE")).toThrow(/aucune categorie/i);
  });

  it("dedoublonne", () => {
    expect(analyserCategories("ACCES,acces,ACCES")).toEqual(["ACCES"]);
  });

  it("retient la voirie de quartier par defaut, jamais les sentiers", () => {
    const d = analyserCategories(undefined);
    expect(d).toContain("RESIDENTIELLE");
    expect(d).not.toContain("SENTIER");
    expect(d).not.toContain("PIETON");
  });
});

describe("L'etat est la seule decision metier", () => {
  it("vaut NON_EVALUE par defaut — c'est la verite tant qu'on n'a pas inspecte", () => {
    expect(analyserEtat(undefined)).toBe("NON_EVALUE");
    expect(estDeclaration(analyserEtat(undefined))).toBe(false);
  });

  it("traite toute autre valeur comme une declaration", () => {
    for (const e of ["BON", "MOYEN", "MAUVAIS", "CRITIQUE"]) {
      expect(estDeclaration(analyserEtat(e))).toBe(true);
    }
  });

  it("refuse un etat hors enumeration plutot que d'echouer au milieu de l'insert", () => {
    expect(() => analyserEtat("EXCELLENT")).toThrow(/invalide/i);
  });
});

describe("Classe et prefixe", () => {
  it("classe urbaine par defaut", () => {
    expect(analyserClasse(undefined)).toBe("RU");
  });

  it("refuse une classe inconnue", () => {
    expect(() => analyserClasse("AUTOROUTE")).toThrow(/invalide/i);
  });

  it("reduit le prefixe a l'alphanumerique — il entre dans le code du troncon", () => {
    expect(analyserPrefixe("kaloum")).toBe("KALOUM");
    expect(analyserPrefixe("ka'--loum")).toBe("KALOUM");
  });

  it("refuse un prefixe qui ne laisse rien", () => {
    expect(() => analyserPrefixe("'; --")).toThrow(/alphanumerique/i);
  });
});

describe("Le libelle de repli suit la categorie de la ligne", () => {
  const sql = casLibelleSql();

  it("couvre toutes les categories", () => {
    for (const c of CATEGORIES_VALIDES) {
      expect(sql).toContain(`when '${c}' then`);
    }
  });

  it("ne confond pas une desserte avec une voie residentielle", () => {
    // Le defaut qu'un premier jet avait introduit : le libelle de la premiere
    // categorie rencontree s'appliquait a toutes les lignes.
    expect(sql).toContain(`when 'ACCES' then '${LIBELLE.ACCES}'`);
    expect(sql).toContain(`when 'RESIDENTIELLE' then '${LIBELLE.RESIDENTIELLE}'`);
    expect(LIBELLE.ACCES).not.toBe(LIBELLE.RESIDENTIELLE);
  });

  it("n'ouvre aucune chaine SQL", () => {
    // Chaque apostrophe doit etre appariee : un nombre impair trahirait une chaine
    // laissee ouverte, donc une injection possible par le libelle.
    expect((sql.match(/'/g) ?? []).length % 2).toBe(0);
  });
});
