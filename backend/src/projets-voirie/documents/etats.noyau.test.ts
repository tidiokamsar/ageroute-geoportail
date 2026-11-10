import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  effetNouvelleVersion, exploitabilite, STATUTS_DEMANDABLES, STATUTS_DOCUMENT, TRANSITIONS, transitionAdmise, transitionsDemandables, verifierChangement,
  type EntreeChangement, type StatutDocument,
} from "./etats.noyau";
import { avertissementsPiece, detecterFormatPiece, empreinteSha256, nomFichierSur } from "./piece.noyau";

const MIGRATION = join(__dirname, "..", "..", "..", "prisma", "migrations", "20261104100000_completude_documentaire", "migration.sql");
const base: EntreeChangement = { de: "EN_ANALYSE", vers: "EXPLOITABLE", acteurId: "u-valideur", deposeParId: "u-deposant", justification: "piece lisible et complete", format: "PDF", jeuId: null, jeuStatut: null };
const verdict = (e: Partial<EntreeChangement>) => verifierChangement({ ...base, ...e });
const codeDe = (v: ReturnType<typeof verifierChangement>) => (v.ok ? null : v.code);

describe("matrice des transitions (contrat section 4), identique a la base", () => {
  it("la matrice du noyau est EXACTEMENT celle de la fonction SQL documents_projet_voirie_transition_admise", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const corps = sql.slice(sql.indexOf("documents_projet_voirie_transition_admise(p_de text"), sql.indexOf("$fn$;", sql.indexOf("documents_projet_voirie_transition_admise(p_de text")));
    const paires = [...corps.matchAll(/\('([A-Z_]+)', '([A-Z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    expect(paires).toEqual(TRANSITIONS.map(([a, b]) => `${a}>${b}`).sort());
    expect(paires.length).toBe(20);
  });

  it("REJETE et REMPLACE sont terminaux ; VALIDE ne mene qu'a REMPLACE ; personne ne revient a ATTENDU", () => {
    for (const s of STATUTS_DOCUMENT) {
      expect(transitionAdmise("REJETE", s)).toBe(false);
      expect(transitionAdmise("REMPLACE", s)).toBe(false);
      expect(transitionAdmise(s, "ATTENDU")).toBe(false);
      if (s !== "REMPLACE") expect(transitionAdmise("VALIDE", s)).toBe(false);
    }
    expect(transitionsDemandables("VALIDE")).toEqual([]);
    expect(transitionsDemandables("ATTENDU")).toEqual([]);
    expect(transitionsDemandables("EXPLOITABLE")).toEqual(["A_CORRIGER", "VALIDE", "REJETE"]);
  });

  it("chaque couple (de, vers) demande : accepte si et seulement si la matrice l'admet (81 couples, hors gardes)", () => {
    for (const de of STATUTS_DOCUMENT) {
      for (const vers of STATUTS_DOCUMENT) {
        const v = verdict({ de, vers, justification: "justification suffisante", format: null });
        const attendu = (STATUTS_DEMANDABLES as readonly string[]).includes(vers) && transitionAdmise(de, vers);
        expect(v.ok, `${de} -> ${vers}`).toBe(attendu);
        if (!attendu) expect(codeDe(v)).toBe("TRANSITION_INTERDITE");
      }
    }
  });
});

describe("gardes d'un changement de statut, dans l'ordre du contrat", () => {
  it("ATTENDU, RECU et REMPLACE ne se demandent jamais (poses par le serveur) ; les transitions possibles sont rendues", () => {
    for (const vers of ["ATTENDU", "RECU", "REMPLACE", "INCONNU"]) {
      const v = verdict({ de: "RECU", vers });
      expect(codeDe(v)).toBe("TRANSITION_INTERDITE");
      if (!v.ok) expect(v.extra?.possibles).toEqual(["EN_ANALYSE", "REJETE"]);
    }
  });

  it("INCOMPLET, A_CORRIGER, VALIDE et REJETE exigent 10 caracteres de justification ; EN_ANALYSE et EXPLOITABLE non", () => {
    expect(codeDe(verdict({ de: "EN_ANALYSE", vers: "INCOMPLET", justification: "court" }))).toBe("JUSTIFICATION_INVALIDE");
    expect(codeDe(verdict({ de: "EN_ANALYSE", vers: "A_CORRIGER", justification: undefined }))).toBe("JUSTIFICATION_INVALIDE");
    expect(codeDe(verdict({ de: "RECU", vers: "REJETE", justification: "         x" }))).toBe("JUSTIFICATION_INVALIDE");
    expect(codeDe(verdict({ de: "EXPLOITABLE", vers: "VALIDE", justification: "" }))).toBe("JUSTIFICATION_INVALIDE");
    expect(verdict({ de: "RECU", vers: "EN_ANALYSE", justification: undefined }).ok).toBe(true);
    expect(verdict({ de: "EN_ANALYSE", vers: "EXPLOITABLE", justification: undefined }).ok).toBe(true);
  });

  it("un DWG ne devient jamais EXPLOITABLE ni VALIDE (aucun convertisseur) : DOCUMENT_NON_EXPLOITABLE avec la marche a suivre (DXF)", () => {
    const v = verdict({ de: "EN_ANALYSE", vers: "EXPLOITABLE", format: "DWG" });
    expect(codeDe(v)).toBe("DOCUMENT_NON_EXPLOITABLE");
    if (!v.ok) expect(v.message).toMatch(/DXF/);
    expect(codeDe(verdict({ de: "EXPLOITABLE", vers: "VALIDE", format: "DWG" }))).toBe("DOCUMENT_NON_EXPLOITABLE");
    // Le DWG peut etre examine, mis a corriger, rejete : seulement jamais exploitable.
    expect(verdict({ de: "RECU", vers: "EN_ANALYSE", format: "DWG" }).ok).toBe(true);
    expect(verdict({ de: "EN_ANALYSE", vers: "A_CORRIGER", format: "DWG" }).ok).toBe(true);
    expect(exploitabilite({ format: "DWG", jeuId: null, jeuStatut: null })).toEqual({ possible: false, raison: "DWG_NON_EXPLOITABLE" });
    expect(exploitabilite({ format: "PDF", jeuId: null, jeuStatut: null })).toEqual({ possible: true, raison: null });
  });

  it("une piece liee a un jeu n'est EXPLOITABLE ou VALIDE que si le jeu est AUTORISE", () => {
    for (const s of ["CONTROLE", "RECU", "REJETE", "REMPLACE", "RETIRE", null]) {
      expect(codeDe(verdict({ de: "EN_ANALYSE", vers: "EXPLOITABLE", format: "LANDXML", jeuId: "j", jeuStatut: s })), String(s)).toBe("JEU_NON_AUTORISE");
    }
    expect(verdict({ de: "EN_ANALYSE", vers: "EXPLOITABLE", format: "LANDXML", jeuId: "j", jeuStatut: "AUTORISE" }).ok).toBe(true);
    expect(codeDe(verdict({ de: "EXPLOITABLE", vers: "VALIDE", format: "GEOJSON", jeuId: "j", jeuStatut: "RETIRE" }))).toBe("JEU_NON_AUTORISE");
  });

  it("SEPARATION DES TACHES : le deposant ne valide pas, sans derogation ; une autre personne le peut ; rien n'est exige pour les autres statuts", () => {
    expect(codeDe(verdict({ de: "EXPLOITABLE", vers: "VALIDE", acteurId: "u-deposant" }))).toBe("SEPARATION_DES_TACHES");
    expect(verdict({ de: "EXPLOITABLE", vers: "VALIDE", acteurId: "u-autre" }).ok).toBe(true);
    expect(verdict({ de: "EXPLOITABLE", vers: "REJETE", acteurId: "u-deposant" }).ok).toBe(true);
    expect(verdict({ de: "RECU", vers: "EN_ANALYSE", acteurId: "u-deposant" }).ok).toBe(true);
  });
});

describe("versions", () => {
  it("la version precedente en cours passe REMPLACE tout de suite ; VALIDE, REJETE et REMPLACE (remplacante retiree) sont conserves ; ATTENDU refuse", () => {
    const attendus: Record<StatutDocument, string> = {
      ATTENDU: "DOCUMENT_ATTENDU", RECU: "REMPLACE", EN_ANALYSE: "REMPLACE", INCOMPLET: "REMPLACE", A_CORRIGER: "REMPLACE", EXPLOITABLE: "REMPLACE",
      // Revue D1, M1 : une version REMPLACE n'est la derniere NON RETIREE que si sa remplacante a ete retiree ; la lignee doit pouvoir repartir d'elle.
      VALIDE: "CONSERVE", REJETE: "CONSERVE", REMPLACE: "CONSERVE",
    };
    for (const s of STATUTS_DOCUMENT) {
      const e = effetNouvelleVersion(s);
      expect(e.ok ? e.precedente : e.code, s).toBe(attendus[s]);
    }
  });
});

describe("piece : format par la signature, empreinte, nom, avertissements", () => {
  it("PDF et DWG reconnus par le contenu, jamais par l'extension ; tout le reste refuse (null)", () => {
    expect(detecterFormatPiece(Buffer.from("%PDF-1.7\n1 0 obj"))).toBe("PDF");
    expect(detecterFormatPiece(Buffer.from("AC1032\u0000\u0000\u0000"))).toBe("DWG");
    expect(detecterFormatPiece(Buffer.from("AC1015"))).toBe("DWG");
    for (const c of ["0\nSECTION\n", "{\"type\":\"FeatureCollection\"}", "<kml/>", "MZ\u0090\u0000", "%PDF", "AC20xx", ""]) expect(detecterFormatPiece(Buffer.from(c)), c).toBeNull();
  });

  it("empreinte SHA-256 hexadecimale ; nom de fichier sans chemin ni caractere de controle, 255 caracteres au plus", () => {
    expect(empreinteSha256(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(nomFichierSur("C:\\dossier\\..\\plan\u0007 axes.pdf")).toBe("plan axes.pdf");
    expect(nomFichierSur("../../etc/passwd")).toBe("passwd");
    expect(nomFichierSur("\u0001")).toBe("fichier");
    expect(nomFichierSur("a".repeat(400)).length).toBe(255);
  });

  it("avertissements de depot : DWG (marche a suivre DXF), PDF (reference), jeu en quarantaine", () => {
    expect(avertissementsPiece({ format: "DWG", jeuId: null, jeuStatut: null }).map((a) => a.code)).toEqual(["DWG_NON_EXPLOITABLE"]);
    expect(avertissementsPiece({ format: "PDF", jeuId: null, jeuStatut: null }).map((a) => a.code)).toEqual(["PDF_REFERENCE"]);
    expect(avertissementsPiece({ format: "GEOJSON", jeuId: "j", jeuStatut: "CONTROLE" }).map((a) => a.code)).toEqual(["JEU_NON_AUTORISE"]);
    expect(avertissementsPiece({ format: "GEOJSON", jeuId: "j", jeuStatut: "AUTORISE" })).toEqual([]);
  });
});
