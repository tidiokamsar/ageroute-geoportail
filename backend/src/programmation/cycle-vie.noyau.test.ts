/**
 * Le cycle de vie des interventions, et le garde-fou de la frontiere DigitalRoad.
 *
 * CE QUE CES TESTS DEFENDENT : qu'il n'existe AUCUN chemin, dans le noyau ni dans le reste du
 * code, qui pose un statut post-TRANSMIS sans un fait externe identifie. Le paragraphe 7.7 le
 * dit en une phrase -- « jamais saisis dans le Geoportail » -- et c'est la phrase que la
 * programmation, le jour ou elle existera, ne doit pas pouvoir contourner par commodite.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EXPLICATIONS, ORIGINE_REQUISE, STATUTS_INTERVENTION, STATUTS_RECUS, TRANSITIONS,
  saisissableDansLeGeoportail, transiter, type StatutIntervention,
} from "./cycle-vie.noyau";

describe("Le noyau ne depend de rien", () => {
  it("n'a aucun import : la regle doit tourner avant que la table n'existe", () => {
    const source = readFileSync(join(__dirname, "cycle-vie.noyau.ts"), "utf8");
    expect([...source.matchAll(/^import .*?from\s+["']/gm)]).toHaveLength(0);
  });
});

describe("Le chemin nominal passe, avec les pieces exigees", () => {
  it("de BROUILLON a EVALUE, chaque etape avec son origine et sa piece", () => {
    const etapes: [StatutIntervention, StatutIntervention, Parameters<typeof transiter>[2]][] = [
      ["BROUILLON", "PROPOSE", { origine: "GEOPORTAIL" }],
      ["PROPOSE", "ARBITRE", { origine: "GEOPORTAIL" }],
      ["ARBITRE", "APPROUVE", { origine: "GEOPORTAIL" }],
      ["APPROUVE", "TRANSMIS", { origine: "DIGITALROAD", messageDigitalRoadId: "DR-ACK-42", versionFigee: "a".repeat(64) }],
      ["TRANSMIS", "EN_EXECUTION", { origine: "DIGITALROAD", messageDigitalRoadId: "DR-START-7" }],
      ["EN_EXECUTION", "ACHEVE", { origine: "DIGITALROAD", messageDigitalRoadId: "DR-END-9" }],
      ["ACHEVE", "EVALUE", { origine: "INSPECTION_POST_TRAVAUX", inspectionId: "insp-2026-0101" }],
    ];
    for (const [de, vers, demande] of etapes) {
      const v = transiter(de, vers, demande);
      expect(v.ok, `${de} -> ${vers}`).toBe(true);
      if (v.ok) expect(v.recule).toBe(false);
    }
  });
});

describe("La frontiere : aucun statut recu ne se saisit dans le Geoportail", () => {
  it.each(STATUTS_RECUS)("%s est refuse avec l'origine GEOPORTAIL, et le motif le dit", (vers) => {
    const de = STATUTS_INTERVENTION[STATUTS_INTERVENTION.indexOf(vers) - 1];
    const v = transiter(de, vers, { origine: "GEOPORTAIL", messageDigitalRoadId: "DR-1", inspectionId: "i-1", versionFigee: "x".repeat(64) });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("ORIGINE_INTERDITE");
      expect(v.motif).toMatch(/ne se saisit pas dans le Geoportail/);
    }
  });

  it("l'origine est controlee AVANT les pieces : un utilisateur ne lit jamais « message requis »", () => {
    const v = transiter("TRANSMIS", "EN_EXECUTION", { origine: "GEOPORTAIL" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("ORIGINE_INTERDITE");
  });

  it("un statut DigitalRoad sans message identifie est refuse : un fait recu cite sa source", () => {
    for (const [de, vers] of [["TRANSMIS", "EN_EXECUTION"], ["EN_EXECUTION", "ACHEVE"]] as const) {
      const v = transiter(de, vers, { origine: "DIGITALROAD", messageDigitalRoadId: "   " });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("MESSAGE_DIGITALROAD_REQUIS");
    }
  });

  it("DigitalRoad ne peut pas poser un statut qui appartient au Geoportail, ni l'evaluation", () => {
    expect(transiter("ARBITRE", "APPROUVE", { origine: "DIGITALROAD", messageDigitalRoadId: "DR-1" }).ok).toBe(false);
    const ev = transiter("ACHEVE", "EVALUE", { origine: "DIGITALROAD", messageDigitalRoadId: "DR-1" });
    expect(ev.ok).toBe(false);
    if (!ev.ok) expect(ev.code).toBe("ORIGINE_INTERDITE");
  });

  it("EVALUE exige une inspection post-travaux identifiee : c'est un constat, pas un clic", () => {
    const v = transiter("ACHEVE", "EVALUE", { origine: "INSPECTION_POST_TRAVAUX", inspectionId: "" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("INSPECTION_REQUISE");
  });

  it("saisissableDansLeGeoportail dit non pour les quatre statuts recus, oui pour les quatre autres", () => {
    expect(STATUTS_RECUS.every((s) => !saisissableDansLeGeoportail(s))).toBe(true);
    expect(["BROUILLON", "PROPOSE", "ARBITRE", "APPROUVE"].every(saisissableDansLeGeoportail)).toBe(true);
    expect(saisissableDansLeGeoportail("N_IMPORTE_QUOI")).toBe(false);
  });
});

describe("La version figee et les retours en arriere", () => {
  it("entrer en TRANSMIS sans empreinte de la version transmise est refuse", () => {
    const v = transiter("APPROUVE", "TRANSMIS", { origine: "DIGITALROAD", messageDigitalRoadId: "DR-ACK" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("VERSION_FIGEE_REQUISE");
  });

  it("un recul avant transmission passe s'il est motive, et est signale comme recul", () => {
    const sans = transiter("APPROUVE", "ARBITRE", { origine: "GEOPORTAIL" });
    expect(sans.ok).toBe(false);
    if (!sans.ok) expect(sans.code).toBe("RETOUR_NON_MOTIVE");
    const avec = transiter("APPROUVE", "ARBITRE", { origine: "GEOPORTAIL", motif: "enveloppe FER revisee" });
    expect(avec.ok).toBe(true);
    if (avec.ok) expect(avec.recule).toBe(true);
  });

  it("rien ne recule apres la transmission : un fait externe ne se defait pas", () => {
    for (const de of STATUTS_RECUS) {
      for (const vers of STATUTS_INTERVENTION) {
        if (STATUTS_INTERVENTION.indexOf(vers) < STATUTS_INTERVENTION.indexOf(de)) {
          const v = transiter(de, vers, { origine: "DIGITALROAD", messageDigitalRoadId: "DR", motif: "x", versionFigee: "y" });
          expect(v.ok, `${de} -> ${vers}`).toBe(false);
          if (!v.ok) expect(v.code).toBe("TRANSITION_INEXISTANTE");
        }
      }
    }
  });
});

describe("Exhaustivite : la table des transitions est la seule verite", () => {
  it("toute paire absente de TRANSITIONS est refusee TRANSITION_INEXISTANTE, quelles que soient les pieces", () => {
    const toutesPieces = { origine: "DIGITALROAD" as const, messageDigitalRoadId: "DR", inspectionId: "i", versionFigee: "v", motif: "m" };
    let paires = 0;
    for (const de of STATUTS_INTERVENTION) {
      for (const vers of STATUTS_INTERVENTION) {
        if (TRANSITIONS[de].includes(vers)) continue;
        paires += 1;
        for (const origine of ["GEOPORTAIL", "DIGITALROAD", "INSPECTION_POST_TRAVAUX"] as const) {
          const v = transiter(de, vers, { ...toutesPieces, origine });
          expect(v.ok, `${de} -> ${vers} (${origine})`).toBe(false);
          if (!v.ok) expect(v.code).toBe("TRANSITION_INEXISTANTE");
        }
      }
    }
    // 64 paires moins les 10 transitions permises.
    expect(paires).toBe(54);
  });

  it("un statut inconnu est refuse avant tout", () => {
    const v = transiter("APPROUVE", "PAYE", { origine: "DIGITALROAD", messageDigitalRoadId: "DR" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("STATUT_INCONNU");
  });

  it("chaque statut d'arrivee a une origine requise, et chaque code de refus une explication", () => {
    for (const s of STATUTS_INTERVENTION) expect(ORIGINE_REQUISE[s]).toBeDefined();
    for (const code of ["STATUT_INCONNU", "TRANSITION_INEXISTANTE", "ORIGINE_INTERDITE", "MESSAGE_DIGITALROAD_REQUIS", "INSPECTION_REQUISE", "VERSION_FIGEE_REQUISE", "RETOUR_NON_MOTIVE"] as const) {
      expect(EXPLICATIONS[code].length).toBeGreaterThan(10);
    }
  });
});

describe("Garde-fou sur tout le code : aucun chemin ne pose un statut recu a la main", () => {
  /** Tous les .ts du backend hors tests, hors ce noyau, hors node_modules. */
  function sources(dir: string, acc: string[] = []): string[] {
    for (const nom of readdirSync(dir)) {
      const p = join(dir, nom);
      if (nom === "node_modules" || nom === "dist") continue;
      if (statSync(p).isDirectory()) sources(p, acc);
      else if (/\.ts$/.test(nom) && !/\.test\.ts$/.test(nom) && !/cycle-vie\.noyau\.ts$/.test(nom)) acc.push(p);
    }
    return acc;
  }

  it("aucun fichier n'affecte EN_EXECUTION, ACHEVE ou EVALUE a un champ statut en dehors du noyau", () => {
    // Les deux premiers n'existent dans aucune autre enumeration du depot ; TRANSMIS et
    // ACHEVE pourraient un jour servir ailleurs (missions, OT), donc on cible les deux qui sont
    // propres aux interventions et sans ambiguite, plus le motif « statut: "TRANSMIS" ».
    const motif = /statut\s*[:=]\s*["'](EN_EXECUTION|EVALUE|TRANSMIS)["']/;
    const fautifs = sources(join(__dirname, "..")).filter((f) => {
      const txt = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      return motif.test(txt);
    });
    expect(fautifs, "un statut recu est pose a la main dans : " + fautifs.join(", ")).toEqual([]);
  });
});
