import { describe, expect, it } from "vitest";
import {
  FILTRES_INDISPONIBLES, LIMITE_LIGNES_EXPORT, MENTION_CONSULTATIVE, neutraliserFormule, nomFichier, partitionnerFiltres, rendreCsv, rendreJson,
  resumeFiltres, retirerColonnesFinancieres, verifierPlafond, type EnteteExport, type JeuDonnees,
} from "./export.noyau";

const entete = (o: Partial<EnteteExport> = {}): EnteteExport => ({
  titre: "Etat du reseau par region", type: "reseau_regions", format: "csv", exportId: "id-1", genereLe: "2026-10-29T10:00:00.000Z",
  auteur: { id: "u1", email: "gest@ageroute.gov.gn", role: "GESTIONNAIRE" },
  filtresDemandes: {}, filtresAppliques: { regionId: 3 }, filtresNonAppliques: [{ filtre: "depuis", raison: "instantane courant" }],
  perimetre: { libelle: "Region Kindia", national: false, regionIds: [3] },
  unites: { km_bon: "km" }, sources: [{ code: "troncons", libelle: "Registre des troncons", dateReference: "2026-10-28" }],
  definitions: [{ code: "reseau_degrade_pct", libelle: "Reseau degrade", definition: "def", formule: "a / b", unite: "%", statutDefinition: "PROVISOIRE", origine: "dictionnaire" }],
  avertissements: ["Donnees partielles"], mention: MENTION_CONSULTATIVE, nbLignes: 1, limiteLignes: LIMITE_LIGNES_EXPORT,
  droitFinancier: false, colonnesFinancieresRetirees: [], ...o,
});
const jeu: JeuDonnees = {
  colonnes: [{ cle: "region", libelle: "Region", unite: null }, { cle: "km_bon", libelle: "km", unite: "km" }, { cle: "cout", libelle: "cout", unite: "GNF", financier: true }],
  lignes: [{ region: "Kindia", km_bon: 12.5, cout: "1000" }],
};

describe("filtres : appliques, non appliques, indisponibles", () => {
  it("un filtre non pris en charge est DIT avec sa raison, jamais retire en silence", () => {
    const r = partitionnerFiltres("reseau_regions", { regionId: 3, depuis: "2026-01-01", etat: ["BON"] });
    expect(r.appliques).toEqual({ regionId: 3 });
    expect(r.nonAppliques.map((x) => x.filtre)).toEqual(expect.arrayContaining(["depuis", "etat"]));
    expect(r.nonAppliques.find((x) => x.filtre === "depuis")?.raison).toMatch(/instantane/);
  });
  it("les filtres sans donnee structuree sont toujours listes (prefecture, axe, bailleur, gravite, type d'intervention)", () => {
    const r = partitionnerFiltres("synthese", {});
    for (const f of FILTRES_INDISPONIBLES) expect(r.nonAppliques.some((x) => x.filtre === f.filtre && /indisponible/.test(x.raison))).toBe(true);
  });
  it("les scenarios acceptent l'etat, pas la periode", () => {
    const r = partitionnerFiltres("scenario", { etat: ["CRITIQUE"], depuis: "2026-01-01" });
    expect(r.appliques).toEqual({ etat: ["CRITIQUE"] });
    expect(r.nonAppliques.some((x) => x.filtre === "depuis")).toBe(true);
  });
  it("resume lisible, et « aucun filtre » dit en toutes lettres", () => {
    expect(resumeFiltres({ regionId: 3, classe: ["RN", "RR"] })).toBe("regionId=3; classe=RN,RR");
    expect(resumeFiltres({})).toMatch(/aucun filtre/);
  });
});

describe("droit financier", () => {
  it("retire la colonne financiere de l'en-tete ET des lignes, et la nomme", () => {
    const r = retirerColonnesFinancieres(jeu, false);
    expect(r.retirees).toEqual(["cout"]);
    expect(r.jeu.colonnes.map((c) => c.cle)).toEqual(["region", "km_bon"]);
    expect(r.jeu.lignes[0]).toEqual({ region: "Kindia", km_bon: 12.5 });
  });
  it("avec le droit, le jeu est rendu tel quel", () => {
    expect(retirerColonnesFinancieres(jeu, true)).toEqual({ jeu, retirees: [] });
  });
});

describe("plafond", () => {
  it("accepte jusqu'a la limite, refuse au-dela avec un 413 clair", () => {
    expect(verifierPlafond(LIMITE_LIGNES_EXPORT).ok).toBe(true);
    const v = verifierPlafond(LIMITE_LIGNES_EXPORT + 1);
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.statut).toBe(413); expect(v.message).toMatch(/Restreignez/); }
  });
});

describe("rendu CSV", () => {
  it("porte date, auteur, perimetre, filtres appliques et non appliques, unites, sources, definitions, avertissements, mention", () => {
    const csv = rendreCsv(entete(), jeu);
    expect(csv.startsWith("﻿")).toBe(true);
    for (const attendu of [
      "# genere_le;2026-10-29T10:00:00.000Z", "# auteur;gest@ageroute.gov.gn (GESTIONNAIRE)", "# perimetre;Region Kindia",
      "# filtres_appliques;regionId=3", "# filtre_non_applique;depuis : instantane courant", "# unites;km_bon=km",
      "# source;Registre des troncons [troncons] reference : 2026-10-28", "# definition reseau_degrade_pct;", "PROVISOIRE",
      "# avertissement;Donnees partielles", "# nb_lignes;1", "# mention;Consultatif, non engageant",
    ]) expect(csv).toContain(attendu);
    expect(csv).toContain("\n\nregion;km_bon;cout\nKindia;12.5;1000\n");
  });
  it("MUTATION DE CONTROLE : sans mention consultative, le fichier n'est pas conforme (le test la cherche)", () => {
    const csv = rendreCsv(entete({ mention: "" }), jeu);
    expect(csv).not.toContain("Consultatif, non engageant");
  });
  it("une valeur absente reste VIDE, jamais un zero", () => {
    const csv = rendreCsv(entete(), { colonnes: [{ cle: "a", libelle: "a", unite: null }, { cle: "b", libelle: "b", unite: null }], lignes: [{ a: null, b: 0 }] });
    expect(csv).toContain("\n;0\n");
  });
  it("echappe point-virgule, guillemets et retours a la ligne", () => {
    const csv = rendreCsv(entete(), { colonnes: [{ cle: "a", libelle: "a", unite: null }], lignes: [{ a: 'x;"y"\nz' }] });
    expect(csv).toContain('"x;""y""\nz"');
  });
  it.each(["=SUM(A1)", "+1", "-2+3", "@cmd", "\tx", "\rx"])("neutralise la formule %j", (s) => {
    expect(neutraliserFormule(s)).toBe(`'${s}`);
  });
  it("ne touche ni un texte ordinaire ni un nombre negatif", () => {
    expect(neutraliserFormule("Kindia")).toBe("Kindia");
    const csv = rendreCsv(entete(), { colonnes: [{ cle: "a", libelle: "a", unite: null }], lignes: [{ a: -5 }] });
    expect(csv).toContain("\n-5\n");
  });
});

describe("rendu JSON", () => {
  it("porte les metadonnees completes, les colonnes et les lignes", () => {
    const j = JSON.parse(rendreJson(entete({ format: "json" }), jeu));
    expect(j.metadonnees.genereLe).toBe("2026-10-29T10:00:00.000Z");
    expect(j.metadonnees.mention).toBe(MENTION_CONSULTATIVE);
    expect(j.metadonnees.filtresNonAppliques[0].filtre).toBe("depuis");
    expect(j.colonnes[1]).toEqual({ cle: "km_bon", libelle: "km", unite: "km" });
    expect(j.lignes[0].km_bon).toBe(12.5);
  });
});

describe("nom de fichier", () => {
  it("horodate et assaini", () => {
    expect(nomFichier("reseau_regions", "csv", new Date("2026-10-29T10:05:09.123Z"))).toBe("aide-decision-reseau_regions-20261029-100509.csv");
    expect(nomFichier("sel/../x", "json", new Date("2026-10-29T10:05:09Z"))).not.toContain("/");
  });
});
