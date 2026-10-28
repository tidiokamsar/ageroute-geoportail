import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StatutLotImport } from "@prisma/client";
import {
  STATUTS_LOT, calculerActions, calculerEtapes, classerColonnes, decoderCurseur, detailsSobres, encoderCurseur,
  formaterLignePourApercu, lireRapport, tronquerIdentifiant, tronquerMotif, type EntreeVue,
} from "./lots.vue.noyau";

/**
 * La vue d'un lot : le serveur DIT ou en est le lot, le client l'affiche. La regle qui gouverne :
 * ne jamais laisser croire a un import. Pur : ni base, ni horloge.
 */
const c = (o: Partial<EntreeVue["compteurs"]> = {}) => ({ lues: 0, validees: 0, rejetees: 0, enConflit: 0, ignorees: 0, importees: 0, ...o });
const vue = (statut: EntreeVue["statut"], compteurs = c(), motifRejetLot: string | null = null): EntreeVue => ({ statut, compteurs, motifRejetLot });

describe("coherence avec la base", () => {
  it("les cinq statuts sont ceux de l'enum Prisma, dans le meme ordre", () => {
    expect([...STATUTS_LOT]).toEqual(Object.values(StatutLotImport));
  });
  it("est pur : il n'importe que le noyau du pivot et celui de la reception", () => {
    const source = readFileSync(join(__dirname, "lots.vue.noyau.ts"), "utf8");
    expect([...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1])).toEqual(["./pivot.noyau", "./reception.noyau"]);
  });
});

describe("etapes", () => {
  const etats = (e: EntreeVue) => calculerEtapes(e).map((x) => x.etat);

  it("toujours quatre etapes, dans l'ordre, avec raison et titre", () => {
    for (const s of STATUTS_LOT) {
      const et = calculerEtapes(vue(s, c({ lues: 2, validees: 2 })));
      expect(et.map((x) => x.id)).toEqual(["reception", "controle_schema", "echantillon", "import_autorise"]);
      expect(et.every((x) => x.titre && x.raison)).toBe(true);
    }
  });

  it("VALIDE_SCHEMA sans rejet : controle TERMINEE", () => {
    expect(etats(vue("VALIDE_SCHEMA", c({ lues: 10, validees: 10 })))).toEqual(["TERMINEE", "TERMINEE", "NON_DISPONIBLE", "NON_DISPONIBLE"]);
  });

  it("VALIDE_SCHEMA avec une seule ligne validee sur 1000 : TERMINEE_AVEC_RESERVES, et la raison le chiffre", () => {
    const e = calculerEtapes(vue("VALIDE_SCHEMA", c({ lues: 1000, validees: 1, rejetees: 998, ignorees: 1 })));
    expect(e[1].etat).toBe("TERMINEE_AVEC_RESERVES");
    expect(e[1].raison).toBe("1 ligne validee sur 1000 ; 998 lignes rejetees, 1 ligne ignoree. Consultez les erreurs avant toute suite.");
  });

  it("des doublons internes seuls (ignorees) suffisent aux reserves", () => {
    expect(etats(vue("VALIDE_SCHEMA", c({ lues: 3, validees: 2, ignorees: 1 })))[1]).toBe("TERMINEE_AVEC_RESERVES");
  });

  it("echantillon et import_autorise sont NON_DISPONIBLES avec les raisons exactes", () => {
    const e = calculerEtapes(vue("VALIDE_SCHEMA", c({ lues: 1, validees: 1 })));
    expect(e[2].raison).toBe("Aucun circuit de validation d'echantillon n'existe encore : decision DSI requise");
    expect(e[3].raison).toBe("L'ecriture dans le referentiel n'est pas implementee : rien n'a ete cree");
  });

  it("REJETE : controle ECHEC avec le motif du lot, les deux suivantes NON_COMMENCEES", () => {
    const e = calculerEtapes(vue("REJETE", c({ lues: 2, rejetees: 2 }), "aucune ligne conforme au contrat"));
    expect(e.map((x) => x.etat)).toEqual(["TERMINEE", "ECHEC", "NON_COMMENCEE", "NON_COMMENCEE"]);
    expect(e[1].raison).toBe("aucune ligne conforme au contrat");
    expect(calculerEtapes(vue("REJETE"))[1].raison).toMatch(/rejete/);
  });

  it.each(["RECU", "IMPORTE_TEST", "IMPORTE"] as const)("%s (jamais produit) : etat coherent, raison explicite, JAMAIS une etape d'import terminee", (s) => {
    const e = calculerEtapes(vue(s, c({ lues: 5, validees: 5, importees: s === "RECU" ? 0 : 5 })));
    expect(e.every((x) => x.etat !== "ECHEC")).toBe(true);
    expect(e[3].etat).toBe("NON_DISPONIBLE");
    expect(e[3].raison).not.toMatch(/termine/i);
    expect(e.slice(1).some((x) => /non produit par l'application actuelle/.test(x.raison))).toBe(true);
    if (s !== "RECU") expect(e[3].raison).toMatch(/Ne pas lire ce statut comme un import effectif/);
    // Aucune etape ne devient TERMINEE au-dela du controle.
    expect(e[2].etat).not.toBe("TERMINEE");
    expect(e[3].etat).not.toBe("TERMINEE");
  });

  it("RECU : le controle n'est pas commence", () => {
    expect(calculerEtapes(vue("RECU"))[1].etat).toBe("NON_COMMENCEE");
  });
});

describe("actions permises", () => {
  const codes = (a: ReturnType<typeof calculerActions>) => Object.fromEntries(a.map((x) => [x.code, x.permise]));

  it("TELECHARGER_ERREURS selon les lignes rejetees ou ignorees, VOIR_APERCU selon les lignes lues, avec raison sinon", () => {
    expect(codes(calculerActions(vue("VALIDE_SCHEMA", c({ lues: 4, validees: 2, rejetees: 1, ignorees: 1 })), "ADMIN"))).toEqual({ TELECHARGER_ERREURS: true, VOIR_APERCU: true });
    const propre = calculerActions(vue("VALIDE_SCHEMA", c({ lues: 4, validees: 4 })), "GESTIONNAIRE");
    expect(propre[0]).toMatchObject({ permise: false });
    expect(propre[0].raison).toMatch(/rien a telecharger/);
    expect(propre[1]).toEqual({ code: "VOIR_APERCU", permise: true, raison: null });
    const vide = calculerActions(vue("REJETE"), "ADMIN");
    expect(vide.every((a) => !a.permise && a.raison)).toBe(true);
  });

  it("un enConflit seul ne rend pas le telechargement possible (l'export ne contient que rejetees et ignorees)", () => {
    expect(calculerActions(vue("VALIDE_SCHEMA", c({ lues: 1, enConflit: 1 })), "ADMIN")[0].permise).toBe(false);
  });

  it("aucune action d'approbation ni d'import n'existe, quel que soit le statut", () => {
    for (const s of STATUTS_LOT) {
      expect(calculerActions(vue(s, c({ lues: 3, validees: 3 })), "ADMIN").map((a) => a.code).sort()).toEqual(["TELECHARGER_ERREURS", "VOIR_APERCU"]);
    }
  });

  it("un role qui ne consulte pas n'a aucune action", () => {
    expect(calculerActions(vue("VALIDE_SCHEMA", c({ lues: 4, rejetees: 1, validees: 3 })), "LECTEUR").every((a) => !a.permise && a.raison)).toBe(true);
  });
});

describe("colonnes", () => {
  it("separe reconnues (ordre du pivot) et inconnues (ordre alphabetique), sans le marqueur interne", () => {
    expect(classerColonnes(["zone", "type_objet", "_ligne_brute", "systeme_source", "alpha", "geometrie"])).toEqual({
      reconnues: ["systeme_source", "type_objet", "geometrie"], inconnues: ["alpha", "zone"], inconnuesTronquees: false,
    });
  });
  it("null quand rien n'est calculable", () => {
    expect(classerColonnes([])).toBeNull();
    expect(classerColonnes(["_ligne_brute"])).toBeNull();
  });
  it("plafonne les colonnes inconnues et le dit", () => {
    const r = classerColonnes(Array.from({ length: 500 }, (_, i) => `c${String(i).padStart(3, "0")}`))!;
    expect(r.inconnues).toHaveLength(200);
    expect(r.inconnuesTronquees).toBe(true);
  });
});

describe("apercu", () => {
  it("tronque chaque valeur a 200 caracteres, plafonne a 40 colonnes, convertit en texte", () => {
    const charge = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`c${i}`, i === 0 ? "y".repeat(500) : i === 1 ? { a: 1 } : i === 2 ? null : 7]));
    const r = formaterLignePourApercu(charge);
    expect(Object.keys(r.charge)).toHaveLength(40);
    expect(r.charge.c0).toHaveLength(200);
    expect(r.charge.c1).toBe('{"a":1}');
    expect(r.charge.c2).toBe("");
    expect(r.charge.c3).toBe("7");
    expect(r.tronque).toBe(true);
  });
  it("ne signale aucune troncature quand rien n'est coupe, et rend <script> tel quel", () => {
    const r = formaterLignePourApercu({ note: "<script>alert(1)</script>" });
    expect(r).toEqual({ charge: { note: "<script>alert(1)</script>" }, tronque: false });
  });
  it("une charge qui n'est pas un objet ne fait pas tomber l'apercu", () => {
    expect(formaterLignePourApercu(null).charge).toEqual({ valeur: "null" });
    expect(formaterLignePourApercu([1, 2]).charge).toEqual({ valeur: "[1,2]" });
  });
  it("garde une colonne nommee __proto__", () => {
    expect(Object.keys(formaterLignePourApercu(JSON.parse('{"__proto__":"x"}')).charge)).toEqual(["__proto__"]);
  });
  it("tronque motifs et identifiants", () => {
    expect(tronquerMotif("m".repeat(900))).toEqual({ motif: "m".repeat(500), coupe: true });
    expect(tronquerMotif(null)).toEqual({ motif: null, coupe: false });
    expect(tronquerIdentifiant("i".repeat(300)).id).toHaveLength(200);
  });
});

describe("curseur", () => {
  const p = { importeLe: new Date("2026-10-25T12:34:56.789Z"), id: "7f1e2c3a-0000-4000-8000-123456789abc" };
  it("aller-retour exact, et opaque", () => {
    const cur = encoderCurseur(p);
    expect(cur).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cur).not.toContain("2026");
    expect(decoderCurseur(cur)).toEqual(p);
  });
  it.each([
    "", "!!", "a".repeat(300), Buffer.from("pas du json").toString("base64url"), Buffer.from("[]").toString("base64url"),
    Buffer.from(JSON.stringify({ t: "2026-10-25", i: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ t: "2026-13-45T99:00:00.000Z", i: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ t: "2026-10-25T12:34:56.789Z", i: "" })).toString("base64url"),
    Buffer.from(JSON.stringify({ t: "2026-10-25T12:34:56.789Z", i: "a b" })).toString("base64url"),
    Buffer.from(JSON.stringify({ t: 5, i: "x" })).toString("base64url"),
  ])("refuse le curseur %j", (cur) => { expect(decoderCurseur(cur)).toBeNull(); });
});

describe("historique sobre et rapport", () => {
  it("resume un CREATE sans rien d'autre que reference, statut et lignes lues", () => {
    const apres = { reference: "IMP-2026-00001", statut: "VALIDE_SCHEMA", empreinteFichier: "a".repeat(64), autorisationRef: "SECRET-REF", compteurs: { lues: 12 } };
    const d = detailsSobres("CREATE", apres);
    expect(d).toBe("Lot IMP-2026-00001 enregistre : statut VALIDE_SCHEMA, 12 lignes lues.");
    expect(d).not.toMatch(/aaaa|SECRET/);
  });
  it("une forme inconnue ou une autre action donne null, pas un dump", () => {
    expect(detailsSobres("UPDATE", { reference: "x", statut: "y" })).toBeNull();
    expect(detailsSobres("CREATE", { n: 1 })).toBeNull();
    expect(detailsSobres("CREATE", null)).toBeNull();
    expect(detailsSobres("CREATE", { reference: "x\ny", statut: "S" })).toBe("Lot ? enregistre : statut S.");
  });
  it("lireRapport ne fait pas confiance au jsonb", () => {
    expect(lireRapport(null)).toEqual({ motifRejetLot: null, premiersRejets: [], avertissements: [] });
    expect(lireRapport("texte")).toEqual({ motifRejetLot: null, premiersRejets: [], avertissements: [] });
    expect(lireRapport({ motifRejetLot: 5, premiersRejets: [null, { numeroLigne: "3" }, { numeroLigne: 3, statut: "REJETEE", motif: "m" }], avertissements: ["a", 1] }))
      .toEqual({ motifRejetLot: null, premiersRejets: [{ numeroLigne: 3, statut: "REJETEE", motif: "m" }], avertissements: ["a"] });
  });
});
