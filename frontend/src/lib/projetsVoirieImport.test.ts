import { describe, expect, it } from "vitest";
import {
  LECTURE_VIDE, SAISIE_VIDE, TOUTES_LES_COUCHES, champsLecture, construireDonneesDepot, epsgDeCode, erreurCrs, erreurFormat, exemplesColonne, libelleAvertissement,
  lireApercu, lireDeltaDetail, lireInventaire, lireIssueRetourArriere, lireIssueRevue, lireOptionsImport, modeCrs, raisonAutorisationBloquee, texteAttribut,
  type Lecture,
} from "./projetsVoirieImport";
import { etapeDeCorrection } from "./projetsVoirieImportErreurs";
import {
  CRS_UTM29, DELTA_AUTORISE_AVEC_RETOUR, OPTIONS, apercu, deltaDetail, inventaireCsv, inventaireGeojson, inventaireKml, inventaireKmlUneCouche, inventaireKmz,
} from "../components/projets-voirie/assistant/assistantImport.testutil";

/**
 * Lecteurs de reponse et logique pure de l'assistant d'import. Chaque forme vient du contrat A1 et du code reel du backend ; une reponse inattendue
 * LEVE, elle n'est jamais rendue comme un vide.
 */

const options = lireOptionsImport(OPTIONS);
const lecture = (over: Partial<Lecture> = {}): Lecture => ({ ...LECTURE_VIDE, ...over });

describe("options de l'API (etape 0)", () => {
  it("lit formats, limites, CRS autorises (cle reelle `sourcesAutorises`), champs cibles, options CSV, conservation", () => {
    expect(options.formats.map((f) => f.format)).toEqual(["KML", "KMZ", "GEOJSON", "GPX", "CSV"]);
    expect(options.formats.find((f) => f.format === "CSV")).toMatchObject({ extensions: [".csv", ".tsv", ".txt"], choixCrs: "obligatoire" });
    expect(options.limites).toMatchObject({ tailleMaxOctets: 25 * 1024 * 1024, echantillonMax: 20, archiveEntreesMax: 100, csvLignesMax: 500000 });
    expect(options.crs.sources.map((s) => s.epsg)).toEqual([4326, 32628, 32629]);
    expect(options.crs.sources[2]).toMatchObject({ nom: "WGS 84 / UTM zone 29N", unite: "metre", disponible: true });
    expect(options.crs.cible).toEqual({ epsg: 4326, nom: "WGS 84", unite: "degre" });
    expect(options.crs.zoneAttendue?.bbox).toEqual([-15.2, 7.1, -7.5, 12.8]);
    expect(options.champsCibles).toHaveLength(5);
    expect(options.csv.delimiteurs).toContain("\t");
    expect(options.conservationOriginal).toBe("EMPREINTE_SEULE");
  });
  it("accepte aussi `sourcesAutorisees` (orthographe du contrat) et marque un CRS indisponible", () => {
    const brut = { ...OPTIONS, crs: { ...OPTIONS.crs, sourcesAutorises: undefined, sourcesAutorisees: [{ epsg: 4326, nom: null, unite: null, disponible: false }] } };
    expect(lireOptionsImport(brut).crs.sources).toEqual([{ epsg: 4326, nom: null, unite: null, disponible: false }]);
  });
  it("une reponse sans format, sans CRS source ou illisible LEVE", () => {
    expect(() => lireOptionsImport({})).toThrow(/Réponse inattendue/);
    expect(() => lireOptionsImport({ ...OPTIONS, formats: [] })).toThrow();
    expect(() => lireOptionsImport({ ...OPTIONS, crs: { ...OPTIONS.crs, sourcesAutorises: [] } })).toThrow();
    expect(() => lireOptionsImport("x")).toThrow();
  });
});

describe("inventaire", () => {
  it("KML a deux couches : couches, avertissement, suggestion de mapping", () => {
    const inv = lireInventaire(inventaireKml());
    expect(inv.format).toBe("KML");
    expect(inv.couches).toEqual([
      { id: "c0", nom: "Fibre / Principal", nbObjets: 3, parTypeGeom: { LIGNE: 3, POINT: 0, POLYGONE: 0 } },
      { id: "c1", nom: "Fibre / Chambres", nbObjets: 2, parTypeGeom: { LIGNE: 0, POINT: 2, POLYGONE: 0 } },
    ]);
    expect(inv.avertissements[0]).toMatchObject({ code: "COUCHES_MULTIPLES", nb: 2 });
    expect(inv.suggestionsMapping).toEqual({ nom: "Name" });
    expect(inv.fichier.sha256).toHaveLength(64);
  });
  it("CSV : delimiteur, encodage, separateur decimal, colonnes avec 3 exemples au plus", () => {
    const inv = lireInventaire(inventaireCsv());
    expect(inv.csv).toMatchObject({ delimiteur: ";", delimiteurDetecte: true, encodage: "utf-8", separateurDecimal: ",", nbLignes: 13 });
    expect(inv.csv?.colonnes[0]).toEqual({ nom: "axe", exemples: ["A", "B", "C"] });
    expect(inv.crs.choixObligatoire).toBe(true);
    const long = inventaireCsv({ csv: { ...(inventaireCsv().csv as object), colonnes: [{ nom: "a", exemples: ["1", "2", "3", "4", "5"] }] } });
    expect(lireInventaire(long).csv?.colonnes[0].exemples).toHaveLength(3);
  });
  it("KMZ a plusieurs KML : entrees et choix requis", () => {
    const inv = lireInventaire(inventaireKmz());
    expect(inv.archive).toMatchObject({ choixRequis: true, kmlPrincipal: null, entreesKml: ["a/premier.kml", "b/second.kml"] });
    expect(inv.archive?.entrees).toHaveLength(3);
    expect(inv.couches).toEqual([]);
  });
  it("une reponse sans format ou sans empreinte LEVE", () => {
    expect(() => lireInventaire({})).toThrow(/Réponse inattendue/);
    expect(() => lireInventaire({ ...inventaireKml(), fichier: { nom: "a" } })).toThrow();
  });
});

describe("apercu", () => {
  it("lit CRS enrichi, statistiques, validation geometrique (problemes et elements ecartes), echantillon, mapping", () => {
    const a = lireApercu(apercu({ resume: { ...apercu().resume, crs: CRS_UTM29 } }));
    expect(a.resume.crs).toMatchObject({ epsgSource: 32629, uniteSource: "metre", uniteCible: "degre", versionProj: "7.2.1", origine: "choisi_par_utilisateur" });
    expect(a.resume.crs?.plausibilite).toMatchObject({ statut: "CONFORME", nbObjets: 3 });
    expect(a.statistiques).toMatchObject({ doublonsInternes: 1, sommets: 7, geometriesAReparer: 1 });
    expect(a.validationGeometrique.problemes[0]).toMatchObject({ ordre: 1, code: "AUTO_INTERSECTION" });
    expect(a.validationGeometrique.elementsEcartes[0]).toMatchObject({ element: 4, code: "COORDONNEES_HORS_ZONE" });
    expect(a.echantillon.objets).toHaveLength(3);
    expect(a.echantillon.objets[2].nom).toBeNull();
    expect(a.avertissements.map((x) => x.code)).toEqual(["TRACES_DOUBLES", "ALTITUDE_IGNOREE"]);
  });
  it("un objet d'echantillon sans geometrie lisible est ecarte, jamais rendu vide", () => {
    const brut = apercu();
    (brut.echantillon.objets as unknown[]).push({ ordre: 9, nom: "x", typeGeom: "LIGNE", attributs: {}, geometrie: { type: "LineString" } });
    expect(lireApercu(brut).echantillon.objets).toHaveLength(3);
  });
  it("propositions du jeu : valeur et colonne", () => {
    const a = lireApercu(apercu({ mapping: { applique: { typeReseau: "Reseau" }, propositionsJeu: { typeReseau: { valeur: "TELECOM", colonne: "Reseau" }, vide: { valeur: {}, colonne: "x" } }, avertissements: [] } }));
    expect(a.mapping.applique).toEqual({ typeReseau: "Reseau" });
    expect(a.mapping.propositionsJeu).toEqual({ typeReseau: { valeur: "TELECOM", colonne: "Reseau" } });
  });
  it("sans validationGeometrique : liste vide (serveur plus ancien) ; sans resume ou echantillon : LEVE", () => {
    const brut = apercu() as Record<string, unknown>;
    delete brut.validationGeometrique;
    expect(lireApercu(brut).validationGeometrique).toEqual({ nbProblemes: 0, problemes: [], tronque: false, elementsEcartes: [] });
    expect(() => lireApercu({})).toThrow(/Réponse inattendue/);
    expect(() => lireApercu({ ...apercu(), echantillon: null })).toThrow();
  });
});

describe("delta detaille, revue, retour arriere", () => {
  it("lit les quatre compteurs, les echantillons (objetId pour les ajoutes), la revue et le retour arriere possible", () => {
    const d = lireDeltaDetail(DELTA_AUTORISE_AVEC_RETOUR());
    expect(d.jeu).toMatchObject({ version: 3, statut: "AUTORISE" });
    expect(d.delta).toEqual({ ajoutes: 1, modifies: 1, retires: 1, identiques: 0 });
    expect(d.echantillons.ajoutes[0]).toEqual({ objetId: "30", nom: "Regard 3" });
    expect(d.echantillons.modifies[0]).toEqual({ cle: "R1", nomAvant: "Regard 1", nomApres: "Regard 1 (deplace)" });
    expect(d.suppressions).toMatchObject({ statut: "ACCEPTEES", nb: 1, revue: { decision: "ACCEPTER", par: { nomComplet: "Sekou Gestionnaire" } } });
    expect(d.retourArriere).toEqual({ possible: true, raison: null, restaureraJeuId: "ancien", restaureraVersion: 2 });
  });
  it("premiere version : pas de comparaison, delta nul", () => {
    const d = lireDeltaDetail(deltaDetail({ comparaison: null, delta: null, cleComparaison: null, suppressions: { statut: "AUCUNE", nb: 0, revue: null } }));
    expect(d.comparaison).toBeNull();
    expect(d.delta).toBeNull();
    expect(d.suppressions.statut).toBe("AUCUNE");
  });
  it("une reponse sans jeu ou au statut de suppressions inconnu LEVE", () => {
    expect(() => lireDeltaDetail({})).toThrow(/Réponse inattendue/);
    expect(() => lireDeltaDetail({ ...deltaDetail(), suppressions: { statut: "BIZARRE", nb: 1 } })).toThrow();
  });
  it("issues de revue et de retour arriere", () => {
    expect(lireIssueRevue({ jeu: {}, suppressions: { statut: "ACCEPTEES", nb: 2, revue: { decision: "ACCEPTER", justification: "ok pour les deux", par: null, le: null } }, evenement: { id: "e1" } }))
      .toMatchObject({ suppressions: { statut: "ACCEPTEES", nb: 2 }, evenementId: "e1" });
    expect(lireIssueRetourArriere({ jeuRestaure: { id: "a", version: 2 }, jeuRetire: { id: "b", version: 3 }, evenement: { id: "e2" } })).toEqual({ restaureId: "a", restaureVersion: 2, retireVersion: 3, evenementId: "e2" });
    expect(() => lireIssueRevue({})).toThrow();
    expect(() => lireIssueRetourArriere({ jeuRestaure: {} })).toThrow();
  });
});

describe("champs envoyes avec le fichier", () => {
  it("rien n'est envoye quand rien n'est choisi", () => {
    expect(champsLecture(LECTURE_VIDE)).toEqual({});
  });
  it("couche, entree KML, CRS, confirmation, empreinte attendue ; « toutes les couches » n'envoie pas de couche", () => {
    expect(champsLecture(lecture({ couche: "c1", entreeKml: "a/premier.kml", epsgSource: "32629", confirmerHorsZone: true }), "f".repeat(64)))
      .toEqual({ couche: "c1", entreeKml: "a/premier.kml", epsgSource: "32629", confirmerHorsZone: "true", sha256Attendu: "f".repeat(64) });
    expect(champsLecture(lecture({ couche: TOUTES_LES_COUCHES }))).toEqual({});
  });
  it("CSV : seules les colonnes du mode choisi partent ; la tabulation part en toutes lettres", () => {
    const csv = { delimiteur: "\t", encodage: "windows-1252", separateurDecimal: ",", mode: "lignes" as const, colonneX: "x", colonneY: "y", colonneWkt: "geom", colonneCle: "axe", colonneOrdre: "ordre" };
    expect(champsLecture(lecture({ csv }))).toEqual({ delimiteur: "tab", encodage: "windows-1252", separateurDecimal: ",", colonneX: "x", colonneY: "y", colonneCle: "axe", colonneOrdre: "ordre" });
    expect(champsLecture(lecture({ csv: { ...csv, mode: "points" } }))).not.toHaveProperty("colonneCle");
    expect(champsLecture(lecture({ csv: { ...csv, mode: "wkt" } }))).toEqual({ delimiteur: "tab", encodage: "windows-1252", separateurDecimal: ",", colonneWkt: "geom" });
  });
  it("mapping en JSON sans les champs vides", () => {
    expect(champsLecture(lecture({ mapping: { nom: "Name", identifiant: "" } }))).toEqual({ mapping: JSON.stringify({ nom: "Name" }) });
  });
});

describe("etape 1 : donnees du depot", () => {
  const fichier = new File(["x"], "a.kml");
  it("fichier, concessionnaire (reseau tiers), dates futures et precisions hors bornes sont refuses", () => {
    expect(construireDonneesDepot(SAISIE_VIDE, options.formats, 1000).erreurs.fichier).toBe("Choisissez un fichier.");
    const e = construireDonneesDepot({ ...SAISIE_VIDE, fichier, precisionH: "-3", dateConstat: "2999-01-01" }, options.formats, 1000).erreurs;
    expect(Object.keys(e).sort()).toEqual(["concessionnaire", "dateConstat", "precisionH"]);
  });
  it("un fichier trop gros pour la limite de l'API est refuse en clair, avec la taille de l'API", () => {
    const gros = { ...SAISIE_VIDE, fichier: new File([new Uint8Array(2000)], "a.kml"), concessionnaireId: "c1" };
    expect(construireDonneesDepot(gros, options.formats, 1000).erreurs.fichier).toMatch(/maximum est de 1000 o/);
  });
  it("un document ou un executable est refuse localement ; un format hors lot est signale mais le serveur decide", () => {
    const pdf = construireDonneesDepot({ ...SAISIE_VIDE, fichier: new File(["x"], "plan.pdf"), concessionnaireId: "c1" }, options.formats, 1000).erreurs.fichier;
    expect(pdf).toMatch(/pas une donnée SIG/);
    const shp = construireDonneesDepot({ ...SAISIE_VIDE, fichier: new File(["x"], "plan.shp"), concessionnaireId: "c1" }, options.formats, 1000);
    expect(shp.donnees).not.toBeNull();
  });
  it("les options de lecture serialisees accompagnent le depot", () => {
    const d = construireDonneesDepot({ ...SAISIE_VIDE, fichier, concessionnaireId: "c1" }, options.formats, 1000, { epsgSource: "32629" }).donnees;
    expect(d?.options).toEqual({ epsgSource: "32629" });
    expect(d).toMatchObject({ role: "RESEAU_TIERS", concessionnaireId: "c1", natureObjet: "INCONNUE", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", classePrecision: "INCONNUE" });
  });
});

describe("regles des etapes", () => {
  it("modeCrs : KML, KMZ, GPX imposes ; GeoJSON facultatif ; CSV obligatoire ; GeoJSON declarant un systeme projete obligatoire et restreint a ce code", () => {
    expect(modeCrs(lireInventaire(inventaireKml()), options.formats)).toEqual({ mode: "impose", epsg: 4326 });
    expect(modeCrs(lireInventaire(inventaireKmz()), options.formats)).toEqual({ mode: "impose", epsg: 4326 });
    expect(modeCrs(lireInventaire(inventaireGeojson(null)), options.formats)).toEqual({ mode: "facultatif" });
    expect(modeCrs(lireInventaire(inventaireGeojson("EPSG:4326")), options.formats)).toEqual({ mode: "facultatif" });
    expect(modeCrs(lireInventaire(inventaireCsv()), options.formats)).toEqual({ mode: "obligatoire", restreintA: null, declare: null });
    expect(modeCrs(lireInventaire(inventaireGeojson("EPSG:32629")), options.formats)).toEqual({ mode: "obligatoire", restreintA: 32629, declare: "EPSG:32629" });
  });
  it("erreurCrs : jamais de valeur par defaut pour un CSV ; un systeme declare ne se remplace pas ; liste blanche", () => {
    const csv = modeCrs(lireInventaire(inventaireCsv()), options.formats);
    expect(erreurCrs(csv, lecture(), options.crs.sources)).toMatch(/jamais deviné, ni rempli par défaut/);
    expect(erreurCrs(csv, lecture({ epsgSource: "32629" }), options.crs.sources)).toBeNull();
    expect(erreurCrs(csv, lecture({ epsgSource: "2154" }), options.crs.sources)).toMatch(/pas dans la liste autorisée/);
    const decl = modeCrs(lireInventaire(inventaireGeojson("EPSG:32629")), options.formats);
    expect(erreurCrs(decl, lecture(), options.crs.sources)).toMatch(/déclare EPSG:32629 : confirmez/);
    expect(erreurCrs(decl, lecture({ epsgSource: "32628" }), options.crs.sources)).toMatch(/ne se remplace pas/);
    expect(erreurCrs(decl, lecture({ epsgSource: "32629" }), options.crs.sources)).toBeNull();
    expect(erreurCrs({ mode: "impose", epsg: 4326 }, lecture(), options.crs.sources)).toBeNull();
    expect(erreurCrs({ mode: "facultatif" }, lecture(), options.crs.sources)).toBeNull();
  });
  it("un CRS indisponible dans la base n'est pas admis", () => {
    const sources = [{ epsg: 32629, nom: null, unite: null, disponible: false }];
    expect(erreurCrs({ mode: "facultatif" }, lecture({ epsgSource: "32629" }), sources)).toMatch(/pas dans la liste autorisée/);
  });
  it("erreurFormat : couche explicite quand il y en a plusieurs ; entree d'archive requise ; CSV : mode et colonnes", () => {
    const kml = lireInventaire(inventaireKml());
    expect(erreurFormat(kml, lecture())).toMatch(/plusieurs couches/);
    expect(erreurFormat(kml, lecture({ couche: "c1" }))).toBeNull();
    expect(erreurFormat(kml, lecture({ couche: TOUTES_LES_COUCHES }))).toBeNull();
    expect(erreurFormat(lireInventaire(inventaireKmlUneCouche()), lecture())).toBeNull();
    expect(erreurFormat(lireInventaire(inventaireKmz()), lecture())).toMatch(/plusieurs fichiers KML/);
    expect(erreurFormat(lireInventaire(inventaireKmz()), lecture({ entreeKml: "a/premier.kml" }))).toBeNull();
    const csv = lireInventaire(inventaireCsv());
    const base = { delimiteur: "", encodage: "", separateurDecimal: "", colonneX: "", colonneY: "", colonneWkt: "", colonneCle: "", colonneOrdre: "" };
    expect(erreurFormat(csv, lecture())).toMatch(/comment lire le tableau/);
    expect(erreurFormat(csv, lecture({ csv: { ...base, mode: "points", colonneX: "x" } }))).toMatch(/colonnes X et Y/);
    expect(erreurFormat(csv, lecture({ csv: { ...base, mode: "points", colonneX: "x", colonneY: "y" } }))).toBeNull();
    expect(erreurFormat(csv, lecture({ csv: { ...base, mode: "lignes", colonneX: "x", colonneY: "y" } }))).toMatch(/clé/);
    expect(erreurFormat(csv, lecture({ csv: { ...base, mode: "wkt" } }))).toMatch(/WKT/);
    expect(erreurFormat(csv, lecture({ csv: { ...base, mode: "wkt", colonneWkt: "geom" } }))).toBeNull();
  });
  it("epsgDeCode", () => {
    expect(epsgDeCode("EPSG:32629")).toBe(32629);
    expect(epsgDeCode("autre")).toBeNull();
    expect(epsgDeCode(null)).toBeNull();
  });
  it("exemples de valeurs : 3 au plus, depuis les colonnes d'un CSV ou les attributs de l'echantillon", () => {
    const csv = lireInventaire(inventaireCsv());
    expect(exemplesColonne("axe", csv, null)).toEqual(["A", "B", "C"]);
    const ap = lireApercu(apercu());
    expect(exemplesColonne("Circuit", lireInventaire(inventaireKml()), ap)).toEqual(["C-2", "C-1"]);
    expect(exemplesColonne("inconnue", lireInventaire(inventaireKml()), ap)).toEqual([]);
  });
  it("texteAttribut tronque les valeurs longues et ne rend que du texte", () => {
    expect(texteAttribut("a".repeat(100), 10)).toBe("aaaaaaaaaa...");
    expect(texteAttribut(null)).toBe("");
    expect(texteAttribut({ a: 1 })).toBe("{\"a\":1}");
    expect(texteAttribut("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
  });
  it("garde de l'autorisation : suppressions a revoir ou refusees bloquent, acceptees ou aucune ne bloquent pas", () => {
    expect(raisonAutorisationBloquee({ statut: "A_REVOIR", nb: 2 })).toMatch(/2 objet\(s\)/);
    expect(raisonAutorisationBloquee({ statut: "REFUSEES", nb: 2 })).toMatch(/ne peut plus être autorisée/);
    expect(raisonAutorisationBloquee({ statut: "ACCEPTEES", nb: 2 })).toBeNull();
    expect(raisonAutorisationBloquee({ statut: "AUCUNE", nb: 0 })).toBeNull();
    expect(raisonAutorisationBloquee(null)).toBeNull();
  });
  it("libelle des avertissements : libelle accentue connu, sinon texte du serveur", () => {
    expect(libelleAvertissement({ code: "COUCHES_MULTIPLES", message: "brut", nb: 2 })).toMatch(/plusieurs couches/);
    expect(libelleAvertissement({ code: "INCONNU", message: "texte du serveur", nb: null })).toBe("texte du serveur");
  });
  it("etape ou se corrige chaque erreur typee", () => {
    expect(etapeDeCorrection("SEPARATEUR_DECIMAL_AMBIGU")).toBe("format");
    expect(etapeDeCorrection("ENCODAGE_AMBIGU")).toBe("format");
    expect(etapeDeCorrection("CRS_INCOHERENT")).toBe("crs");
    expect(etapeDeCorrection("HORS_GUINEE")).toBe("crs");
    expect(etapeDeCorrection("MAPPING_COLONNE_INTROUVABLE")).toBe("mapping");
    expect(etapeDeCorrection("CONCESSIONNAIRE_REQUIS")).toBe("depot");
    expect(etapeDeCorrection("JEU_DEJA_CHARGE")).toBeNull();
  });
});

describe("hors cadre : un nom d'objet ou une colonne ne devient jamais du HTML", () => {
  it("les lecteurs gardent le texte tel quel (c'est le composant qui l'affiche comme texte)", () => {
    const piege = "<img src=x onerror=alert(1)>";
    const a = lireApercu(apercu({ echantillon: { taille: 1, total: 1, objets: [{ ordre: 0, nom: piege, typeGeom: "POINT", simplifiee: false, attributs: { [piege]: piege }, geometrie: { type: "Point", coordinates: [0, 0] } }] } }));
    expect(a.echantillon.objets[0].nom).toBe(piege);
  });
});
