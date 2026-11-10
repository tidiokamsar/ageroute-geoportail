import { describe, expect, it } from "vitest";
import { DOMAINES, FAMILLES_RESEAU, estDomaine, familleEffective, fusionnerParametres, prochaineVersion, validerParametres } from "./referentiels.noyau";

describe("domaines", () => {
  it("les cinq domaines du contrat, et rien d'autre", () => {
    expect(DOMAINES).toEqual(["TYPE_RESEAU", "CATEGORIE_PROJET", "TYPE_DOCUMENT", "METHODE_ACQUISITION", "STATUT_QUALITE"]);
    expect(estDomaine("TYPE_RESEAU")).toBe(true);
    expect(estDomaine("VILLE")).toBe(false);
    expect(estDomaine(42)).toBe(false);
  });
});

describe("parametres par domaine (schemas stricts)", () => {
  it("TYPE_RESEAU : famille de l'enumeration obligatoire, couleur #rrggbb facultative, rien d'autre", () => {
    expect(validerParametres("TYPE_RESEAU", { famille: "TELECOM", couleur: "#ff7900" })).toEqual({ ok: true, parametres: { famille: "TELECOM", couleur: "#ff7900" } });
    expect(validerParametres("TYPE_RESEAU", { famille: "TELECOM" }).ok).toBe(true);
    expect(validerParametres("TYPE_RESEAU", { famille: "FIBRE" })).toMatchObject({ ok: false, erreurs: { famille: expect.any(Array) } });
    expect(validerParametres("TYPE_RESEAU", {})).toMatchObject({ ok: false });
    expect(validerParametres("TYPE_RESEAU", { famille: "TELECOM", couleur: "orange" })).toMatchObject({ ok: false, erreurs: { couleur: expect.any(Array) } });
    expect(validerParametres("TYPE_RESEAU", { famille: "TELECOM", ville: "x" })).toMatchObject({ ok: false });
    for (const f of FAMILLES_RESEAU) expect(validerParametres("TYPE_RESEAU", { famille: f }).ok).toBe(true);
  });

  it("CATEGORIE_PROJET : 0 < chaussee <= emprise <= 200", () => {
    expect(validerParametres("CATEGORIE_PROJET", { largeurEmpriseM: 15, largeurChausseeM: 7 }).ok).toBe(true);
    expect(validerParametres("CATEGORIE_PROJET", { largeurEmpriseM: 7, largeurChausseeM: 15 })).toMatchObject({ ok: false, erreurs: { largeurChausseeM: expect.any(Array) } });
    expect(validerParametres("CATEGORIE_PROJET", { largeurEmpriseM: 201, largeurChausseeM: 7 }).ok).toBe(false);
    expect(validerParametres("CATEGORIE_PROJET", { largeurEmpriseM: 15, largeurChausseeM: 0 }).ok).toBe(false);
    expect(validerParametres("CATEGORIE_PROJET", { largeurEmpriseM: 15 }).ok).toBe(false);
  });

  it("TYPE_DOCUMENT : obligatoire et liste de codes de fonctions en majuscules (20 au plus)", () => {
    expect(validerParametres("TYPE_DOCUMENT", { obligatoire: true, fonctionsDebloquees: ["ANALYSE_2D", "CONFLITS"] }).ok).toBe(true);
    expect(validerParametres("TYPE_DOCUMENT", { obligatoire: false, fonctionsDebloquees: [] }).ok).toBe(true);
    expect(validerParametres("TYPE_DOCUMENT", { obligatoire: "oui", fonctionsDebloquees: [] }).ok).toBe(false);
    expect(validerParametres("TYPE_DOCUMENT", { obligatoire: true, fonctionsDebloquees: ["analyse"] }).ok).toBe(false);
    expect(validerParametres("TYPE_DOCUMENT", { obligatoire: true, fonctionsDebloquees: Array.from({ length: 21 }, (_, i) => `F${i}`) }).ok).toBe(false);
    expect(validerParametres("TYPE_DOCUMENT", { obligatoire: true }).ok).toBe(false);
  });

  it("METHODE_ACQUISITION : precision typique facultative, positive, ou nulle (jamais inventee)", () => {
    expect(validerParametres("METHODE_ACQUISITION", {}).ok).toBe(true);
    expect(validerParametres("METHODE_ACQUISITION", { precisionTypiqueM: null }).ok).toBe(true);
    expect(validerParametres("METHODE_ACQUISITION", { precisionTypiqueM: 0.5 }).ok).toBe(true);
    expect(validerParametres("METHODE_ACQUISITION", { precisionTypiqueM: 0 }).ok).toBe(false);
    expect(validerParametres("METHODE_ACQUISITION", { precisionTypiqueM: -1 }).ok).toBe(false);
  });

  it("STATUT_QUALITE : description facultative bornee, cle inconnue refusee", () => {
    expect(validerParametres("STATUT_QUALITE", {}).ok).toBe(true);
    expect(validerParametres("STATUT_QUALITE", undefined).ok).toBe(true);
    expect(validerParametres("STATUT_QUALITE", { description: "x".repeat(501) }).ok).toBe(false);
    expect(validerParametres("STATUT_QUALITE", { seuil: 3 }).ok).toBe(false);
  });
});

describe("repli de type de reseau sur la famille", () => {
  const valeurs = [
    { code: "FIBRE_OPTIQUE", parametres: { famille: "TELECOM" } },
    { code: "ANCIEN", parametres: { famille: "EAU_POTABLE" }, deletedAt: new Date() },
    { code: "CASSE", parametres: { famille: "NIMPORTE" } },
  ];

  it("un code connu donne la famille du referentiel", () => {
    expect(familleEffective("FIBRE_OPTIQUE", "AUTRE", valeurs)).toEqual({ famille: "TELECOM", source: "REFERENTIEL", codeInconnu: false });
  });

  it("sans code, la famille declaree (repli) ; nulle si rien n'est declare", () => {
    expect(familleEffective(null, "ELECTRICITE", valeurs)).toEqual({ famille: "ELECTRICITE", source: "FAMILLE_DECLAREE", codeInconnu: false });
    expect(familleEffective(undefined, null, valeurs).famille).toBeNull();
  });

  it("un code inconnu, retire ou a la famille illisible garde la famille declaree et le signale", () => {
    expect(familleEffective("INCONNU", "AUTRE", valeurs)).toEqual({ famille: "AUTRE", source: "FAMILLE_DECLAREE", codeInconnu: true });
    expect(familleEffective("ANCIEN", "AUTRE", valeurs).codeInconnu).toBe(true);
    expect(familleEffective("CASSE", "GAZ_HYDROCARBURES", valeurs)).toMatchObject({ famille: "GAZ_HYDROCARBURES", codeInconnu: true });
  });

  it("version suivante", () => { expect(prochaineVersion(1)).toBe(2); });
});

describe("revue D1, m12 : roleJeu d'un type de document conserve a la modification", () => {
  const avant = { obligatoire: true, fonctionsDebloquees: ["ANALYSE_2D"], roleJeu: "AXES_TRAVAUX" };
  it("des parametres sans roleJeu gardent celui d'avant, avec un avertissement ; null le retire explicitement ; une valeur le remplace", () => {
    expect(fusionnerParametres("TYPE_DOCUMENT", avant, { obligatoire: false, fonctionsDebloquees: [] }))
      .toEqual({ parametres: { obligatoire: false, fonctionsDebloquees: [], roleJeu: "AXES_TRAVAUX" }, avertissements: [expect.objectContaining({ code: "ROLE_JEU_CONSERVE" })] });
    expect(fusionnerParametres("TYPE_DOCUMENT", avant, { obligatoire: false, fonctionsDebloquees: [], roleJeu: null })).toEqual({ parametres: { obligatoire: false, fonctionsDebloquees: [] }, avertissements: [] });
    expect(fusionnerParametres("TYPE_DOCUMENT", avant, { obligatoire: true, fonctionsDebloquees: [], roleJeu: "RESEAU_TIERS" }).parametres.roleJeu).toBe("RESEAU_TIERS");
  });
  it("les autres domaines gardent le remplacement integral (comportement du lot T1) ; roleJeu null est valide pour TYPE_DOCUMENT", () => {
    expect(fusionnerParametres("TYPE_RESEAU", { famille: "TELECOM", couleur: "#000000" }, { famille: "TELECOM" })).toEqual({ parametres: { famille: "TELECOM" }, avertissements: [] });
    expect(validerParametres("TYPE_DOCUMENT", { obligatoire: true, fonctionsDebloquees: [], roleJeu: null }).ok).toBe(true);
  });
});
