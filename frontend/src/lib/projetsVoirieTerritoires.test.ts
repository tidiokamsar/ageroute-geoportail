import { describe, expect, it } from "vitest";
import {
  cheminDesAncetres, classerErreurTerritoires, construireParametres, detailsParChamp, empriseDepuisSaisie, enveloppeEnv, familleDuType, filtrerTerritoires, largeursDeCategorie,
  libelleDeCode, lireBornes, lireSaisieEmprise, listeBlancheEffective, niveauxEnfantsPossibles, optionsDeChoix, rectangleDepuisCoins, rectangleVersEmprise, resumeParametres,
  resumeValeurConfiguration, saisieDepuisParametres, saisieDepuisValeur, valeurDepuisSaisie, SAISIE_EMPRISE_VIDE, SAISIE_PARAMETRES_VIDE,
  type EntreeConfiguration, type Territoire, type ValeurReferentiel,
} from "./projetsVoirieTerritoires";

/** Donnees SYNTHETIQUES : codes et noms inventes, aucune ville reelle. */

const t = (id: string, chemin: string, over: Partial<Territoire> = {}): Territoire => ({
  id, code: id.toUpperCase(), nom: `Territoire ${id}`, niveau: "COMMUNE", parentId: null, chemin, profondeur: chemin.split("/").filter(Boolean).length - 1,
  regionId: null, regionEffectiveId: null, crsMetriqueEpsg: null, bbox: null, source: null, actif: true, version: 1, creePar: null, updatedAt: null, ...over,
});
const v = (code: string, over: Partial<ValeurReferentiel> = {}): ValeurReferentiel => ({
  id: code, domaine: "TYPE_RESEAU", code, libelle: `Libelle ${code}`, ordre: 10, actif: true, parametres: {}, version: 1, systeme: false, approuvePar: null, approuveLe: null, ...over,
});
const erreur = (status: number, data: Record<string, unknown> = {}) => ({ response: { status, data, headers: {} } });

describe("niveaux et chemin", () => {
  it("un enfant est d'un niveau strictement inferieur (un niveau peut etre saute) ; sans parent : la nation", () => {
    expect(niveauxEnfantsPossibles(null)).toEqual(["NATION"]);
    expect(niveauxEnfantsPossibles("REGION")).toEqual(["PREFECTURE", "COMMUNE", "QUARTIER", "SECTEUR", "ZONE"]);
    expect(niveauxEnfantsPossibles("ZONE")).toEqual([]);
  });
  it("chemin lisible des ancetres connus ; un ancetre hors perimetre est omis et le chemin dit partiel", () => {
    const parId = new Map([["n", t("n", "/n/", { nom: "Nation synthetique" })], ["r", t("r", "/n/r/", { nom: "Region A" })]]);
    expect(cheminDesAncetres(t("c", "/n/r/c/"), parId)).toEqual({ noms: ["Nation synthetique", "Region A"], complet: true });
    expect(cheminDesAncetres(t("c", "/x/r/c/"), parId)).toEqual({ noms: ["Region A"], complet: false });
  });
  it("filtre : texte sans accents ni casse, niveau, actifs seulement ; l'ordre de l'arbre est garde", () => {
    const l = [t("a", "/a/", { nom: "Préfecture Éloignée", niveau: "PREFECTURE" }), t("b", "/b/", { nom: "Commune B", actif: false }), t("c", "/c/", { code: "ZONE-ELO" })];
    expect(filtrerTerritoires(l, { q: "eloig" }).map((x) => x.id)).toEqual(["a"]);
    expect(filtrerTerritoires(l, { q: "elo" }).map((x) => x.id)).toEqual(["a", "c"]);
    expect(filtrerTerritoires(l, { niveau: "COMMUNE" }).map((x) => x.id)).toEqual(["b", "c"]);
    expect(filtrerTerritoires(l, { actifsSeulement: true }).map((x) => x.id)).toEqual(["a", "c"]);
  });
});

describe("emprise", () => {
  const carre = { type: "Polygon", coordinates: [[[-10, 9], [-9.9, 9], [-9.9, 9.1], [-10, 9.1], [-10, 9]]] };
  it("lit un Polygon, un Feature qui en porte un, un MultiPolygon ; rend la boite englobante", () => {
    const r = lireSaisieEmprise(JSON.stringify(carre));
    expect(r).toMatchObject({ ok: true, bbox: [-10, 9, -9.9, 9.1], sommets: 5 });
    expect(lireSaisieEmprise(JSON.stringify({ type: "Feature", geometry: carre }))).toMatchObject({ ok: true });
    expect(lireSaisieEmprise(JSON.stringify({ type: "MultiPolygon", coordinates: [carre.coordinates] }))).toMatchObject({ ok: true, emprise: { type: "MultiPolygon" } });
    expect(lireSaisieEmprise("  ")).toBeNull();
  });
  it("refuse : JSON illisible, ligne, anneau ouvert, hors WGS 84, degenere", () => {
    expect(lireSaisieEmprise("{")).toMatchObject({ ok: false, message: expect.stringMatching(/JSON lisible/) });
    expect(lireSaisieEmprise(JSON.stringify({ type: "LineString", coordinates: [[0, 0], [1, 1]] }))).toMatchObject({ ok: false, message: expect.stringMatching(/Polygon ou MultiPolygon/) });
    expect(lireSaisieEmprise(JSON.stringify({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }))).toMatchObject({ ok: false, message: expect.stringMatching(/pas fermé/) });
    expect(lireSaisieEmprise(JSON.stringify({ type: "Polygon", coordinates: [[[0, 0], [200, 0], [1, 1], [0, 0]]] }))).toMatchObject({ ok: false, message: expect.stringMatching(/bornes WGS 84/) });
    expect(lireSaisieEmprise(JSON.stringify({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] }))).toMatchObject({ ok: false, message: expect.stringMatching(/dégénérée/) });
  });
  it("rectangle : bornes coherentes, coins quelconques, saisie a la francaise", () => {
    expect(rectangleVersEmprise([-10, 9, -9, 10])).toEqual({ type: "Polygon", coordinates: [[[-10, 9], [-9, 9], [-9, 10], [-10, 10], [-10, 9]]] });
    expect(rectangleVersEmprise([-9, 9, -10, 10])).toBeNull();
    expect(rectangleDepuisCoins({ lat: 10, lng: -9 }, { lat: 9, lng: -10 })).toEqual([-10, 9, -9, 10]);
    expect(lireBornes({ ouest: "-10,5", sud: "9", est: "-10", nord: "9,5" })).toEqual({ bbox: [-10.5, 9, -10, 9.5], message: null });
    expect(lireBornes({ ouest: "", sud: "9", est: "-10", nord: "9,5" }).message).toMatch(/quatre bornes/);
    expect(lireBornes({ ouest: "-9", sud: "9", est: "-10", nord: "9,5" }).message).toMatch(/incohérentes/);
  });
  it("saisie du formulaire : conserver (champ absent), aucune (null), bornes, GeoJSON, dessin manquant", () => {
    expect(empriseDepuisSaisie({ ...SAISIE_EMPRISE_VIDE, mode: "conserver" }).valeur).toBeUndefined();
    expect(empriseDepuisSaisie(SAISIE_EMPRISE_VIDE).valeur).toBeNull();
    expect(empriseDepuisSaisie({ ...SAISIE_EMPRISE_VIDE, mode: "bornes", ouest: "-10", sud: "9", est: "-9", nord: "10" }).bbox).toEqual([-10, 9, -9, 10]);
    expect(empriseDepuisSaisie({ ...SAISIE_EMPRISE_VIDE, mode: "geojson", texte: "" }).erreur).toMatch(/Collez/);
    expect(empriseDepuisSaisie({ ...SAISIE_EMPRISE_VIDE, mode: "carte" }).erreur).toMatch(/Dessinez/);
    expect(empriseDepuisSaisie({ ...SAISIE_EMPRISE_VIDE, mode: "carte", dessin: [-10, 9, -9, 10] }).valeur).toMatchObject({ type: "Polygon" });
  });
});

describe("referentiels", () => {
  const types = [v("FIBRE", { parametres: { famille: "TELECOM" } }), v("ANCIEN", { actif: false, parametres: { famille: "AUTRE" } })];
  it("une valeur desactivee reste lisible sur l'objet qui la porte, mais n'est pas proposee ; un code inconnu reste affiche tel quel", () => {
    expect(libelleDeCode("ANCIEN", types)).toBe("Libelle ANCIEN (valeur désactivée)");
    expect(libelleDeCode("FIBRE", types)).toBe("Libelle FIBRE");
    expect(libelleDeCode("XYZ", types)).toBe("XYZ");
    expect(libelleDeCode(null, types)).toBe("Non renseigné");
    expect(optionsDeChoix(types).map((o) => o.code)).toEqual(["FIBRE"]);
    expect(optionsDeChoix(types, "ANCIEN")).toEqual([{ code: "FIBRE", libelle: "Libelle FIBRE", desactivee: false }, { code: "ANCIEN", libelle: "Libelle ANCIEN (valeur désactivée)", desactivee: true }]);
  });
  it("famille d'un type, largeurs d'une categorie", () => {
    expect(familleDuType(types[0])).toBe("TELECOM");
    expect(familleDuType(v("X", { parametres: { famille: "INVENTEE" } }))).toBeNull();
    expect(largeursDeCategorie(v("C", { parametres: { largeurEmpriseM: 20, largeurChausseeM: "8" } }))).toEqual({ largeurEmpriseM: 20, largeurChausseeM: 8 });
    expect(largeursDeCategorie(v("C"))).toBeNull();
  });
  it("parametres selon le schema du domaine ; un facultatif vide n'est pas envoye", () => {
    expect(construireParametres("TYPE_RESEAU", { ...SAISIE_PARAMETRES_VIDE, famille: "EAU_POTABLE" })).toEqual({ parametres: { famille: "EAU_POTABLE" }, erreurs: [] });
    expect(construireParametres("TYPE_RESEAU", { ...SAISIE_PARAMETRES_VIDE, famille: "EAU_POTABLE", couleur: "bleu" }).erreurs[0]).toMatch(/#rrggbb/);
    expect(construireParametres("TYPE_RESEAU", SAISIE_PARAMETRES_VIDE).erreurs[0]).toMatch(/famille technique/);
    expect(construireParametres("CATEGORIE_PROJET", { ...SAISIE_PARAMETRES_VIDE, largeurEmpriseM: "20", largeurChausseeM: "8,5" }).parametres).toEqual({ largeurEmpriseM: 20, largeurChausseeM: 8.5 });
    expect(construireParametres("CATEGORIE_PROJET", { ...SAISIE_PARAMETRES_VIDE, largeurEmpriseM: "6", largeurChausseeM: "8" }).erreurs[0]).toMatch(/plus large/);
    expect(construireParametres("TYPE_DOCUMENT", { ...SAISIE_PARAMETRES_VIDE, obligatoire: true, fonctionsDebloquees: ["CONFLITS"] }).parametres).toEqual({ obligatoire: true, fonctionsDebloquees: ["CONFLITS"] });
    expect(construireParametres("METHODE_ACQUISITION", SAISIE_PARAMETRES_VIDE).parametres).toEqual({});
    expect(construireParametres("METHODE_ACQUISITION", { ...SAISIE_PARAMETRES_VIDE, precisionTypiqueM: "0" }).erreurs[0]).toMatch(/strictement positif/);
    expect(construireParametres("STATUT_QUALITE", { ...SAISIE_PARAMETRES_VIDE, description: " Vu " }).parametres).toEqual({ description: "Vu" });
    expect(construireParametres("FUTUR", { ...SAISIE_PARAMETRES_VIDE, json: "[1]" }).erreurs[0]).toMatch(/objet JSON/);
  });
  it("aller-retour saisie / parametres, resume lisible", () => {
    expect(saisieDepuisParametres("CATEGORIE_PROJET", { largeurEmpriseM: 15.5, largeurChausseeM: 7 })).toMatchObject({ largeurEmpriseM: "15,5", largeurChausseeM: "7" });
    expect(resumeParametres("TYPE_RESEAU", { famille: "TELECOM", couleur: "#ff7900" }, (f) => `famille ${f}`)).toBe("Famille : famille TELECOM, couleur #ff7900");
    expect(resumeParametres("TYPE_DOCUMENT", { obligatoire: true, fonctionsDebloquees: ["ANALYSE_2D"] }, String)).toBe("Obligatoire ; débloque : Analyse 2D");
    expect(resumeParametres("METHODE_ACQUISITION", { precisionTypiqueM: null }, String)).toBe("Précision typique non renseignée");
  });
});

describe("configuration nationale", () => {
  it("saisie et valeur de l'emprise nationale, des bandes, de la liste blanche, des protections", () => {
    const s = saisieDepuisValeur("EMPRISE_PLAUSIBILITE", { nom: "Zone test", bbox: [-15.2, 7.1, -7.5, 12.8] });
    expect(s).toMatchObject({ nom: "Zone test", ouest: "-15,2", nord: "12,8" });
    expect(valeurDepuisSaisie("EMPRISE_PLAUSIBILITE", s)).toEqual({ valeur: { nom: "Zone test", bbox: [-15.2, 7.1, -7.5, 12.8] }, erreurs: [] });
    const b = saisieDepuisValeur("CRS_METRIQUE_BANDES", { bandes: [{ jusquaLongitude: -12, epsg: 32628 }], epsgDefaut: 32629 });
    expect(b.bandes).toBe("-12 ; 32628");
    expect(valeurDepuisSaisie("CRS_METRIQUE_BANDES", b).valeur).toEqual({ bandes: [{ jusquaLongitude: -12, epsg: 32628 }], epsgDefaut: 32629 });
    expect(valeurDepuisSaisie("CRS_METRIQUE_BANDES", { ...b, bandes: "-12 ; 4326" }).erreurs.join(" ")).toMatch(/4326/);
    expect(valeurDepuisSaisie("CRS_METRIQUE_BANDES", { ...b, bandes: "-8 ; 32629\n-12 ; 32628" }).erreurs.join(" ")).toMatch(/croissante/);
    expect(valeurDepuisSaisie("CRS_IMPORT_LISTE_BLANCHE", { ...b, epsg: "4326, 32628 32628" }).valeur).toEqual({ epsg: [4326, 32628] });
    expect(valeurDepuisSaisie("CRS_IMPORT_LISTE_BLANCHE", { ...b, epsg: "32628" }).erreurs.join(" ")).toMatch(/4326/);
    expect(valeurDepuisSaisie("PROTECTIONS", { ...b, protections: { conflitsMax: "500", delaiCarteMs: "" } }).valeur).toEqual({ conflitsMax: 500 });
    expect(valeurDepuisSaisie("PROTECTIONS", { ...b, protections: { conflitsMax: "1,5" } }).erreurs[0]).toMatch(/entier/);
  });
  it("source : une variable d'environnement l'emporte, y compris pour une seule sous-cle", () => {
    const e = (source: EntreeConfiguration["source"]) => ({ source }) as Pick<EntreeConfiguration, "source">;
    expect(enveloppeEnv(e("ENV"))).toBe(true);
    expect(enveloppeEnv(e("BASE"))).toBe(false);
    expect(enveloppeEnv(e({ conflitsMax: "BASE", delaiCarteMs: "ENV" }))).toBe(true);
  });
  it("valeurs lisibles et liste blanche effective", () => {
    expect(resumeValeurConfiguration("CRS_METRIQUE_BANDES", { bandes: [{ jusquaLongitude: -12, epsg: 32628 }], epsgDefaut: 32629 })).toBe("longitude < -12 : EPSG:32628 ; sinon EPSG:32629");
    expect(resumeValeurConfiguration("CRS_IMPORT_LISTE_BLANCHE", { epsg: [4326] })).toBe("EPSG:4326");
    expect(resumeValeurConfiguration("X", null)).toBe("Valeur illisible");
    expect(listeBlancheEffective([{ cle: "CRS_IMPORT_LISTE_BLANCHE", valeur: { epsg: [4326, 32628] } } as EntreeConfiguration])).toEqual([4326, 32628]);
    expect(listeBlancheEffective(undefined)).toBeNull();
  });
});

describe("erreurs typees du lot T1", () => {
  it.each([
    [400, "TERRITOIRE_REQUIS", "validation", /territoire du projet est obligatoire/],
    [404, "TERRITOIRE_INTROUVABLE", "introuvable", /pas dans votre périmètre/],
    [400, "TERRITOIRE_REGION_INCOHERENTE", "validation", /même région/],
    [409, "NATION_DEJA_DEFINIE", "conflit", /une nation existe déjà/i],
    [422, "EMPRISE_INVALIDE", "validation", /PostGIS|polygone/],
    [409, "CODE_DEJA_UTILISE", "conflit", /déjà utilisé/],
    [404, "VALEUR_INTROUVABLE", "introuvable", /introuvable/],
    [403, "HORS_PERIMETRE", "droit", /périmètre/],
  ])("%s %s", (status, code, genre, motif) => {
    const e = classerErreurTerritoires(erreur(status, { error: "texte brut du serveur", code }));
    expect(e).toMatchObject({ status, code, genre });
    expect(e.message).toMatch(motif);
    expect(e.message).not.toMatch(/texte brut/);
  });
  it("409 TERRITOIRE_UTILISE : le nombre d'enfants et de projets du corps est dit, avec la marche a suivre (desactiver)", () => {
    const e = classerErreurTerritoires(erreur(409, { code: "TERRITOIRE_UTILISE", enfants: 2, projets: 1 }));
    expect(e.message).toMatch(/2 territoire\(s\) enfant\(s\) et 1 projet\(s\)/);
    expect(e.message).toMatch(/désactivez-le/);
  });
  it("409 VALEUR_UTILISEE : les usages du corps sont dits ; desactiver plutot", () => {
    expect(classerErreurTerritoires(erreur(409, { code: "VALEUR_UTILISEE", usages: { jeux: 3, concessionnaires: 0 } })).message).toMatch(/portée par 3 jeux.*Désactivez-la/);
  });
  it("400 PARAMETRES_INVALIDES : le detail par champ du serveur est repris (deux formes lues)", () => {
    const a = erreur(400, { code: "PARAMETRES_INVALIDES", details: { details: { largeurChausseeM: ["trop large"] } } });
    expect(classerErreurTerritoires(a).message).toMatch(/largeurChausseeM : trop large/);
    expect(detailsParChamp(erreur(400, { details: { code: ["motif"] } }))).toEqual({ code: ["motif"] });
  });
  it("422 CRS_NON_DISPONIBLE : les codes concernes ; 503 et hors ligne : messages generiques", () => {
    expect(classerErreurTerritoires(erreur(422, { code: "CRS_NON_DISPONIBLE", epsg: [99999] })).message).toMatch(/EPSG:99999/);
    expect(classerErreurTerritoires(erreur(503, {})).genre).toBe("serveur");
    expect(classerErreurTerritoires(new Error("Network Error")).genre).toBe("reseau");
  });
});
