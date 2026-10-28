import { describe, expect, it } from "vitest";
import {
  JUSTIFICATION_MIN, LIBELLE_NB_OBJETS, LIBELLE_TRACE_FUSIONNE, MESSAGE_CODE, STYLE_CONFLIT, STYLE_RESEAU, TYPES_RESEAU,
  arrondirBbox, classeIncertaine, classerErreur, confidentialiteParDefaut, contientBbox, controlerFichier, elargirBbox, erreurLargeurs,
  formaterDate, formaterLongueur, formaterNombre, formaterPourcent, libelleVerification, lireBbox, lireSaisieNombre, natureParDefaut, peutEcrireProjets, styleJeu, versNombre,
} from "./projetsVoirie";

/** Pures : aucun reseau, aucun DOM. Les couleurs et les motifs sont ceux du contrat (section 6) et du cahier des charges v2. */

describe("couleurs du contrat, et un motif propre a chaque type de reseau", () => {
  it("couleurs par secteur", () => {
    expect(STYLE_RESEAU.TELECOM.couleur).toBe("#ff7900");
    expect(STYLE_RESEAU.EAU_POTABLE.couleur).toBe("#1e66f5");
    expect(STYLE_RESEAU.ELECTRICITE.couleur).toBe("#d32f2f");
    expect(STYLE_RESEAU.ASSAINISSEMENT.couleur).toBe("#2e7d32");
    expect(STYLE_RESEAU.GAZ_HYDROCARBURES.couleur).toBe("#f9a825");
    expect(STYLE_RESEAU.AUTRE.couleur).toBe("#6b7f99");
    expect(styleJeu("AXES_TRAVAUX", null).couleur).toBe("#0b2545");
  });
  it("les six types ont des motifs et des noms de motif tous differents (la couleur ne porte pas seule l'information)", () => {
    const motifs = TYPES_RESEAU.map((t) => STYLE_RESEAU[t].motif);
    expect(new Set(motifs).size).toBe(6);
    expect(new Set(TYPES_RESEAU.map((t) => STYLE_RESEAU[t].nomMotif)).size).toBe(6);
  });
  it("conflits : rouge, orange fonce, violet, noir ; chacun avec son propre motif", () => {
    expect(STYLE_CONFLIT.chaussee.couleur).toBe("#d32f2f");
    expect(STYLE_CONFLIT.hors.couleur).toBe("#7b1fa2");
    expect(STYLE_CONFLIT.croisements.couleur).toBe("#000000");
    expect(new Set(Object.values(STYLE_CONFLIT).map((s) => s.nomMotif)).size).toBe(4);
  });
});

describe("valeurs par defaut du cahier des charges v2", () => {
  it("confidentialite : reseau tiers => confidentiel concessionnaire ; axes et limites => restreint au projet", () => {
    expect(confidentialiteParDefaut("RESEAU_TIERS")).toBe("CONFIDENTIEL_CONCESSIONNAIRE");
    expect(confidentialiteParDefaut("AXES_TRAVAUX")).toBe("RESTREINT_PROJET");
    expect(confidentialiteParDefaut("LIMITES_ROUTE")).toBe("RESTREINT_PROJET");
  });
  it("nature des objets : INCONNUE pour un reseau tiers", () => {
    expect(natureParDefaut("RESEAU_TIERS")).toBe("INCONNUE");
    expect(natureParDefaut("AXES_TRAVAUX")).toBe("AXE");
  });
  it("classe D, E ou inconnue : proximite a verifier", () => {
    for (const c of ["D", "E", "INCONNUE"] as const) expect(classeIncertaine(c)).toBe(true);
    for (const c of ["A", "B", "C"] as const) expect(classeIncertaine(c)).toBe(false);
  });
  it("libelles imposes : jamais « cables »", () => {
    expect(LIBELLE_TRACE_FUSIONNE).toBe("Longueur du tracé fusionné (circuits superposés comptés une fois)");
    expect(LIBELLE_NB_OBJETS).toBe("Circuits ou objets du fichier");
    expect(JUSTIFICATION_MIN).toBe(10);
    expect(`${LIBELLE_NB_OBJETS} ${LIBELLE_TRACE_FUSIONNE}`.toLowerCase()).not.toContain("câble");
  });
  it("une ligne de resultat est « a verifier », avec la version de la regle", () => {
    expect(libelleVerification({ statut: "A_VERIFIER", versionRegle: "1.0" })).toBe("À vérifier (règle v1.0)");
    expect(libelleVerification({ statut: "A_VERIFIER", versionRegle: null })).toBe("À vérifier");
  });
  it("ecriture : ADMIN et GESTIONNAIRE seulement", () => {
    expect(peutEcrireProjets("ADMIN")).toBe(true);
    expect(peutEcrireProjets("GESTIONNAIRE")).toBe(true);
    expect(peutEcrireProjets("LECTEUR")).toBe(false);
    expect(peutEcrireProjets("INSPECTEUR")).toBe(false);
    expect(peutEcrireProjets(undefined)).toBe(false);
  });
});

describe("formats", () => {
  it("nombres a la francaise avec espaces ordinaires", () => {
    expect(formaterNombre(1234567.8)).toBe("1 234 567,8");
    expect(formaterNombre(Number.NaN)).toBe("n/d");
  });
  it("longueur : metres sous 1 km, kilometres au-dela", () => {
    expect(formaterLongueur(850)).toBe("850 m");
    expect(formaterLongueur(1500)).toBe("1,5 km");
    expect(formaterLongueur(null)).toBe("n/d");
  });
  it("pourcentage et date", () => {
    expect(formaterPourcent(0.256)).toBe("25,6 %");
    expect(formaterDate("2026-10-24")).toBe("24/10/2026");
    expect(formaterDate(null)).toBe("Non renseignée");
    expect(formaterDate("pas une date")).toBe("Non renseignée");
  });
  it("un Decimal Prisma arrive en chaine", () => {
    expect(versNombre("15.00")).toBe(15);
    expect(versNombre("7,5")).toBe(7.5);
    expect(versNombre("")).toBeNull();
    expect(versNombre("abc")).toBeNull();
    expect(versNombre(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("emprises", () => {
  it("lit un tableau ou un objet, refuse l'incoherent", () => {
    expect(lireBbox([-10.1, 9.1, -10.0, 9.2])).toEqual([-10.1, 9.1, -10, 9.2]);
    expect(lireBbox({ ouest: -10.1, sud: 9.1, est: -10, nord: 9.2 })).toEqual([-10.1, 9.1, -10, 9.2]);
    expect(lireBbox({ ouest: -10, sud: 9.1, est: -10.1, nord: 9.2 })).toBeNull();
    expect(lireBbox([1, 2, 3])).toBeNull();
    expect(lireBbox(null)).toBeNull();
    expect(lireBbox(["a", 1, 2, 3])).toBeNull();
  });
  it("arrondi, elargissement et inclusion", () => {
    expect(arrondirBbox([-10.123456, 9.123456, -10.0, 9.2])).toEqual([-10.1235, 9.1235, -10, 9.2]);
    const grande = elargirBbox([-10.1, 9.1, -10.0, 9.2], 0.1);
    expect(contientBbox(grande, [-10.1, 9.1, -10.0, 9.2])).toBe(true);
    expect(contientBbox([-10.1, 9.1, -10.0, 9.2], grande)).toBe(false);
  });
});

describe("controle local du fichier (le serveur reste l'autorite)", () => {
  it("accepte KML et GeoJSON", () => {
    expect(controlerFichier({ name: "a.KML", size: 10 })).toEqual({ ok: true, message: null, format: "KML" });
    expect(controlerFichier({ name: "a.geojson", size: 10 }).format).toBe("GEOJSON");
    expect(controlerFichier({ name: "a.json", size: 10 }).format).toBe("GEOJSON");
  });
  it.each(["a.kmz", "a.zip", "a.shp", "a.pdf", "a.html", "a.dxf"])("%s : « format prevu au lot suivant », jamais ouvert", (nom) => {
    const v = controlerFichier({ name: nom, size: 10 });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/format prévu au lot suivant/i);
  });
  it("refuse un fichier vide, trop gros ou d'extension inconnue", () => {
    expect(controlerFichier({ name: "a.kml", size: 0 }).message).toMatch(/vide/);
    expect(controlerFichier({ name: "a.kml", size: 26 * 1024 * 1024 }).message).toMatch(/25 Mo/);
    expect(controlerFichier({ name: "a.txt", size: 10 }).message).toMatch(/Extension non reconnue/);
    expect(controlerFichier(null).ok).toBe(false);
  });
});

describe("largeurs", () => {
  it("l'emprise contient la chaussee ; positives ; plausibles", () => {
    expect(erreurLargeurs(15, 7)).toBeNull();
    expect(erreurLargeurs(7, 7)).toBeNull();
    expect(erreurLargeurs(5, 7)).toMatch(/au moins égale/);
    expect(erreurLargeurs(0, 0)).toMatch(/supérieures à zéro/);
    expect(erreurLargeurs(600, 7)).toMatch(/n'est pas admise/);
    expect(erreurLargeurs(null, 7)).toMatch(/deux largeurs/);
  });
  it("saisie decimale avec virgule", () => {
    expect(lireSaisieNombre("7,5")).toBe(7.5);
    expect(lireSaisieNombre("  ")).toBeNull();
  });
});

describe("classement des erreurs {error, code}", () => {
  const rep = (status: number, data: unknown) => ({ response: { status, data } });
  it("aucune reponse HTTP : reseau, jamais un refus", () => {
    const e = classerErreur(new Error("Network Error"));
    expect(e.genre).toBe("reseau");
    expect(e.message).toMatch(/besoin du réseau/);
  });
  it("409 JEU_DEJA_CHARGE : conflit, avec le jeu existant", () => {
    const e = classerErreur(rep(409, { error: "x", code: "JEU_DEJA_CHARGE", jeuId: "j9" }));
    expect(e).toMatchObject({ genre: "conflit", code: "JEU_DEJA_CHARGE", jeuId: "j9" });
    expect(e.message).toMatch(/déjà chargé/);
  });
  it("FORMAT_NON_SUPPORTE, CONTENU_NON_RECONNU, HORS_GUINEE, CRS_NON_SUPPORTE, GEOMETRIE_INVALIDE : messages en clair, texte du serveur ignore", () => {
    for (const code of ["FORMAT_NON_SUPPORTE", "CONTENU_NON_RECONNU", "HORS_GUINEE", "CRS_NON_SUPPORTE", "GEOMETRIE_INVALIDE"]) {
      const e = classerErreur(rep(400, { error: "message brut du serveur", code }));
      expect(e.genre).toBe("validation");
      expect(e.message).toBe(MESSAGE_CODE[code]);
      expect(e.message).not.toContain("message brut");
    }
    expect(MESSAGE_CODE.FORMAT_NON_SUPPORTE).toMatch(/prévu au lot suivant/);
    expect(MESSAGE_CODE.HORS_GUINEE).toMatch(/Guinée/);
    expect(MESSAGE_CODE.CRS_NON_SUPPORTE).toMatch(/WGS 84/);
  });
  it("403 : permission ; 404 : introuvable ; 413 : trop gros ; 5xx : serveur", () => {
    expect(classerErreur(rep(403, { error: "non autorise" })).genre).toBe("permission");
    expect(classerErreur(rep(401, {})).genre).toBe("permission");
    expect(classerErreur(rep(404, { error: "Projet introuvable" }))).toMatchObject({ genre: "introuvable", message: "Projet introuvable" });
    expect(classerErreur(rep(413, {})).genre).toBe("trop-gros");
    expect(classerErreur(rep(502, {})).genre).toBe("serveur");
  });
  it("erreurs par champ d'un ZodError", () => {
    const e = classerErreur(rep(400, { error: "Validation", details: { fieldErrors: { code: ["trop court"], nom: ["requis"] } } }));
    expect(e.champs).toEqual({ code: ["trop court"], nom: ["requis"] });
  });
  it("ne leve jamais, quoi qu'on lui donne", () => {
    for (const v of [undefined, null, 3, "x", {}, { response: null }, { response: { status: "x" } }]) expect(() => classerErreur(v)).not.toThrow();
  });
});
