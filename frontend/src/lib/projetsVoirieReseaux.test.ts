import { describe, expect, it } from "vitest";
import {
  ACTIONS_RELATION, BANDEAU_RESEAUX, CLASSES_NATURE, EFFET_ACTION_RELATION, FILTRES_OBJETS_VIDES, FILTRES_RELATIONS_VIDES, FORME_NATURE, LIBELLE_ACTION_RELATION, LIBELLE_ETAT_VERTICAL,
  LIBELLE_NATURE_COURT, LIBELLE_QUALIFICATION_CIBLE, MENTION_3D, MENTION_LIGNES_CABLES, MESSAGE_CODE_RESEAU, NATURES_FILTRE, QUALIFICATIONS_CIBLE, SAISIE_DESCRIPTEUR_VIDE,
  STATUTS_RELATION, STYLE_STATUT_RELATION, TYPES_OBJET_PAR_NATURE, classerErreurReseau, classeDeclarable, corpsDescripteur, erreursDescripteur, libelleCibleCourt, libelleClasse, libelleTypeObjet,
  nbFiltresObjets, naturesCompatibles, natureQuiSAppliquera, nombreDuCorps, paramsObjets, paramsRelations, texteMetres, texteNombre, type SaisieDescripteur,
} from "./projetsVoirieReseaux";

/**
 * Noyau pur des reseaux physiques et circuits logiques (lot B1, interface) : vocabulaire, filtres, saisie du descripteur, erreurs typees.
 * Le contrat (CONTRAT-RESEAUX.md) et le code du backend font foi : rien n'est invente (classe, precision, profondeur, altitude absentes restent nulles).
 */

const erreurHttp = (status: number, code?: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  ({ response: { status, data: { error: "texte brut du serveur : valeur du fichier X12", ...(code ? { code } : {}), ...extra }, headers } });

describe("vocabulaire et mentions obligatoires", () => {
  it("la phrase du contrat : un fichier de N lignes n'est pas N cables", () => {
    expect(MENTION_LIGNES_CABLES).toMatch(/Un fichier de N lignes n'est pas N câbles/);
    expect(MENTION_LIGNES_CABLES).toMatch(/n'est jamais un nombre d'équipements/);
  });
  it("le bandeau dit qu'une association automatique n'est qu'une proposition sans effet avant validation humaine", () => {
    expect(BANDEAU_RESEAUX).toMatch(/proposition/);
    expect(BANDEAU_RESEAUX).toMatch(/aucun effet tant qu'une personne ne l'a pas validée/);
  });
  it("aucune evaluation 3D : les trois etats verticaux le disent, et la mention est explicite", () => {
    expect(LIBELLE_ETAT_VERTICAL.ABSENTE).toBe("Profondeur et altitude absentes : aucune conclusion 3D.");
    expect(LIBELLE_ETAT_VERTICAL.FOURNIE).toMatch(/l'évaluation 3D n'est pas réalisée/);
    expect(MENTION_3D).toMatch(/ne conclut ni à un conflit vertical ni à son absence/);
  });
  it("chaque nature a un libelle, une FORME et des classes propres : la couleur ne porte pas seule", () => {
    const natures = NATURES_FILTRE;
    expect(new Set(natures.map((n) => FORME_NATURE[n])).size).toBe(natures.length);
    for (const n of natures) { expect(LIBELLE_NATURE_COURT[n].length).toBeGreaterThan(5); expect(CLASSES_NATURE[n]).toMatch(/text-\w+-(800|900)/); }
  });
  it("les types par nature reprennent la liste du contrat (3.3) ; un type inconnu s'affiche tel quel, un type absent est dit", () => {
    expect(TYPES_OBJET_PAR_NATURE.CIRCUIT_LOGIQUE).toEqual(["LIAISON", "FIBRE", "RESEAU", "SERVICE", "AUTRE"]);
    expect(TYPES_OBJET_PAR_NATURE.ACTIF_PHYSIQUE).toContain("CHAMBRE");
    expect(TYPES_OBJET_PAR_NATURE.EQUIPEMENT).toContain("VANNE");
    expect(libelleTypeObjet("FOURREAU")).toBe("Fourreau");
    expect(libelleTypeObjet("TYPE_NOUVEAU")).toBe("TYPE_NOUVEAU");
    expect(libelleTypeObjet(null)).toBe("Type non renseigné");
  });
  it("une classe absente n'est jamais rendue comme une classe", () => {
    expect(libelleClasse(null)).toBe("Classe non renseignée");
    expect(libelleClasse("INCONNUE")).toBe("Classe non renseignée");
    expect(libelleClasse("B")).toBe("Classe B");
    expect(classeDeclarable(null)).toBe("");
    expect(classeDeclarable("INCONNUE")).toBe("");
    expect(classeDeclarable("E")).toBe("E");
  });
  it("une proposition est dite sans effet ; une refusee ne revient pas ; chaque statut a une forme distincte", () => {
    expect(STYLE_STATUT_RELATION.PROPOSEE.aide).toMatch(/Aucun effet/);
    expect(STYLE_STATUT_RELATION.REFUSEE.aide).toMatch(/jamais reproposée/);
    expect(new Set(STATUTS_RELATION.map((s) => STYLE_STATUT_RELATION[s].forme)).size).toBe(4);
  });
  it("aucune action ne deplace, n'ordonne ni n'execute : valider, refuser, revoquer seulement", () => {
    expect(ACTIONS_RELATION).toEqual(["valider", "refuser", "revoquer"]);
    const tous = [...Object.values(LIBELLE_ACTION_RELATION), ...Object.values(EFFET_ACTION_RELATION)].join(" | ");
    expect(tous).not.toMatch(/ordonner|exécuter|executer|déplacer|deplacer/i);
  });
  it("aucun texte du module n'emploie d'emoji ni de tiret cadratin", () => {
    const textes = [BANDEAU_RESEAUX, MENTION_LIGNES_CABLES, MENTION_3D, ...Object.values(MESSAGE_CODE_RESEAU), ...Object.values(LIBELLE_ETAT_VERTICAL), ...Object.values(LIBELLE_QUALIFICATION_CIBLE)].join("\n");
    expect(textes).not.toMatch(/—/);
    expect(textes).not.toMatch(/[\u{1F300}-\u{1FAFF}☀-➿]/u);
  });
});

describe("compatibilite nature et geometrie (contrat 3.4)", () => {
  it("un circuit est une ligne, un equipement un point, un actif physique n'importe quelle geometrie", () => {
    expect(naturesCompatibles("LIGNE")).toEqual(["ACTIF_PHYSIQUE", "CIRCUIT_LOGIQUE"]);
    expect(naturesCompatibles("POINT")).toEqual(["ACTIF_PHYSIQUE", "EQUIPEMENT"]);
    expect(naturesCompatibles("POLYGONE")).toEqual(["ACTIF_PHYSIQUE"]);
    expect(naturesCompatibles(null)).toHaveLength(3);
  });
  it("la nature qui s'appliquera est la declaree, sinon celle du jeu si elle est declarable, sinon aucune", () => {
    expect(natureQuiSAppliquera({ nature: "EQUIPEMENT" }, "CIRCUIT_LOGIQUE")).toBe("EQUIPEMENT");
    expect(natureQuiSAppliquera({ nature: "" }, "CIRCUIT_LOGIQUE")).toBe("CIRCUIT_LOGIQUE");
    expect(natureQuiSAppliquera({ nature: "" }, "INCONNUE")).toBeNull();
    expect(natureQuiSAppliquera({ nature: "" }, "AXE")).toBeNull();
  });
});

describe("filtres et parametres de requete", () => {
  it("les objets : seuls les filtres valides partent, la limite est celle du contrat", () => {
    expect(paramsObjets(FILTRES_OBJETS_VIDES, null)).toEqual({ limite: 50 });
    const jeuId = "11111111-1111-4111-8111-111111111111";
    expect(paramsObjets({ jeuId, nature: "CIRCUIT_LOGIQUE", typeObjet: "FIBRE", q: "  fo-01 " }, "curs")).toEqual({ limite: 50, jeuId, nature: "CIRCUIT_LOGIQUE", typeObjet: "FIBRE", q: "fo-01", curseur: "curs" });
  });
  it("un identifiant de jeu qui n'est pas un UUID et un code de type mal forme ne partent jamais (le serveur repondrait 400)", () => {
    expect(paramsObjets({ jeuId: "jeu-tel", nature: "", typeObjet: "fibre", q: "" }, null)).toEqual({ limite: 50 });
    expect(paramsObjets({ jeuId: "", nature: "", typeObjet: "A", q: "" }, null)).toEqual({ limite: 50 });
  });
  it("la recherche est coupee a 100 caracteres (maximum du serveur)", () => {
    expect((paramsObjets({ ...FILTRES_OBJETS_VIDES, q: "x".repeat(150) }, null).q as string).length).toBe(100);
  });
  it("compte les filtres actifs", () => {
    expect(nbFiltresObjets(FILTRES_OBJETS_VIDES)).toBe(0);
    expect(nbFiltresObjets({ jeuId: "a", nature: "EQUIPEMENT", typeObjet: "", q: " " })).toBe(2);
  });
  it("les relations : statut, type, origine, objetId valide seulement", () => {
    expect(paramsRelations(FILTRES_RELATIONS_VIDES, null)).toEqual({ limite: 50 });
    expect(paramsRelations({ statut: "PROPOSEE", type: "PORTE_PAR", origine: "AUTOMATIQUE", objetId: "12" }, "c")).toEqual({ limite: 50, statut: "PROPOSEE", type: "PORTE_PAR", origine: "AUTOMATIQUE", objetId: "12", curseur: "c" });
    expect(paramsRelations({ ...FILTRES_RELATIONS_VIDES, objetId: "0" }, null)).toEqual({ limite: 50 });
    expect(paramsRelations({ ...FILTRES_RELATIONS_VIDES, objetId: "abc" }, null)).toEqual({ limite: 50 });
  });
});

describe("saisie du descripteur (PUT : le descripteur est REMPLACE, une valeur omise devient nulle)", () => {
  const ctx = { typeGeom: "LIGNE" as const, natureHeritee: "CIRCUIT_LOGIQUE" as const };
  const ok = (over: Partial<SaisieDescripteur> = {}): SaisieDescripteur => ({ ...SAISIE_DESCRIPTEUR_VIDE, justification: "Controle avec le chef de projet", ...over });

  it("une saisie vide hors justification donne des valeurs nulles : jamais une valeur par defaut, jamais heritee", () => {
    const c = corpsDescripteur(ok());
    expect(c).toEqual({
      nature: null, typeObjet: null, classePrecision: null, precisionHorizontaleM: null, precisionVerticaleM: null, methodeCollecte: null, dateConstat: null, niveauConfiance: null,
      statutQualite: "INCONNU", profondeurM: null, altitudeM: null, referenceVerticale: null, justification: "Controle avec le chef de projet",
    });
  });
  it("la justification de 10 caracteres au moins est obligatoire (espaces de bord ignores)", () => {
    expect(erreursDescripteur(ok({ justification: "court" }), ctx)).toContain("La justification doit faire au moins 10 caractères.");
    expect(erreursDescripteur(ok({ justification: "         x         " }), ctx)).toContain("La justification doit faire au moins 10 caractères.");
    expect(erreursDescripteur(ok(), ctx)).toEqual([]);
  });
  it("les nombres a virgule francaise sont lus et arrondis au centimetre ; vide reste nul", () => {
    const c = corpsDescripteur(ok({ precisionHorizontaleM: "0,126", profondeurM: "1,2", altitudeM: "-3", precisionVerticaleM: "" }));
    expect(c).toMatchObject({ precisionHorizontaleM: 0.13, profondeurM: 1.2, altitudeM: -3, precisionVerticaleM: null });
    expect(texteNombre(1.2)).toBe("1,2");
    expect(texteNombre(null)).toBe("");
  });
  it("une precision doit etre strictement positive, jamais nulle apres arrondi, et au plus 100 000", () => {
    expect(erreursDescripteur(ok({ precisionHorizontaleM: "0" }), ctx)).toContain("La précision horizontale doit être strictement positive, au moins 0,01 m.");
    expect(erreursDescripteur(ok({ precisionVerticaleM: "0,004" }), ctx)).toContain("La précision verticale doit être strictement positive, au moins 0,01 m.");
    expect(erreursDescripteur(ok({ precisionHorizontaleM: "-2" }), ctx)).toHaveLength(1);
    expect(erreursDescripteur(ok({ precisionHorizontaleM: "100001" }), ctx)).toContain("La précision horizontale ne peut pas dépasser 100 000 m.");
    expect(erreursDescripteur(ok({ precisionHorizontaleM: "abc" }), ctx)).toContain("La précision horizontale n'est pas un nombre.");
    expect(erreursDescripteur(ok({ precisionHorizontaleM: "0,01" }), ctx)).toEqual([]);
  });
  it("profondeur de 0 a 10 000 m, altitude de -500 a 9 000 m ; la profondeur 0 est une valeur fournie, pas une absence", () => {
    expect(erreursDescripteur(ok({ profondeurM: "-1" }), ctx)).toHaveLength(1);
    expect(erreursDescripteur(ok({ profondeurM: "10001" }), ctx)).toHaveLength(1);
    expect(erreursDescripteur(ok({ altitudeM: "-501" }), ctx)).toHaveLength(1);
    expect(erreursDescripteur(ok({ altitudeM: "9001" }), ctx)).toHaveLength(1);
    expect(erreursDescripteur(ok({ profondeurM: "0" }), ctx)).toEqual([]);
    expect(corpsDescripteur(ok({ profondeurM: "0" })).profondeurM).toBe(0);
  });
  it("une reference verticale sans profondeur ni altitude est refusee ; une valeur sans reference est admise (incomplete)", () => {
    expect(erreursDescripteur(ok({ referenceVerticale: "terrain naturel" }), ctx)).toContain("Une référence verticale exige une profondeur ou une altitude.");
    expect(erreursDescripteur(ok({ profondeurM: "1", referenceVerticale: "terrain naturel" }), ctx)).toEqual([]);
    expect(erreursDescripteur(ok({ profondeurM: "1" }), ctx)).toEqual([]);
  });
  it("un type exige une nature connue et propre a cette nature", () => {
    expect(erreursDescripteur(ok({ typeObjet: "FIBRE" }), ctx)).toEqual([]);
    expect(erreursDescripteur(ok({ typeObjet: "CHAMBRE" }), ctx)).toContain("Ce type n'existe pas pour cette nature.");
    expect(erreursDescripteur(ok({ typeObjet: "FIBRE" }), { typeGeom: "LIGNE", natureHeritee: "INCONNUE" })).toContain("Un type d'objet exige une nature connue : déclarez la nature de l'objet avant d'en donner le type.");
    expect(erreursDescripteur(ok({ nature: "ACTIF_PHYSIQUE", typeObjet: "GAINE" }), { typeGeom: "LIGNE", natureHeritee: "INCONNUE" })).toEqual([]);
  });
  it("une nature incompatible avec la geometrie est refusee (circuit : ligne ; equipement : point)", () => {
    expect(erreursDescripteur(ok({ nature: "EQUIPEMENT" }), ctx)).toContain("Cette nature n'est pas compatible avec la géométrie de l'objet : un circuit logique est une ligne, un équipement un point.");
    expect(erreursDescripteur(ok({ nature: "CIRCUIT_LOGIQUE" }), { typeGeom: "POINT", natureHeritee: "INCONNUE" })).toHaveLength(1);
  });
  it("la date du constat doit etre une vraie date ; les longueurs sont bornees", () => {
    expect(erreursDescripteur(ok({ dateConstat: "2026-02-30" }), ctx)).toContain("La date du constat doit être une date valide.");
    expect(erreursDescripteur(ok({ dateConstat: "2026-10-01" }), ctx)).toEqual([]);
    expect(erreursDescripteur(ok({ methodeCollecte: "m".repeat(201) }), ctx)).toContain("La méthode de collecte fait 200 caractères au plus.");
    expect(erreursDescripteur(ok({ profondeurM: "1", referenceVerticale: "r".repeat(121) }), ctx)).toContain("La référence verticale fait 120 caractères au plus.");
  });
  it("le corps complet porte chaque champ declare, avec des nombres (pas des chaines)", () => {
    const c = corpsDescripteur(ok({
      nature: "CIRCUIT_LOGIQUE", typeObjet: "FIBRE", classePrecision: "A", precisionHorizontaleM: "0,1", methodeCollecte: " GNSS RTK ", dateConstat: "2026-10-01", niveauConfiance: "ELEVE",
      statutQualite: "OBSERVE", profondeurM: "1,2", referenceVerticale: " terrain naturel ",
    }));
    expect(c).toEqual({
      nature: "CIRCUIT_LOGIQUE", typeObjet: "FIBRE", classePrecision: "A", precisionHorizontaleM: 0.1, precisionVerticaleM: null, methodeCollecte: "GNSS RTK", dateConstat: "2026-10-01", niveauConfiance: "ELEVE",
      statutQualite: "OBSERVE", profondeurM: 1.2, altitudeM: null, referenceVerticale: "terrain naturel", justification: "Controle avec le chef de projet",
    });
  });
});

describe("erreurs typees : message en clair, jamais le texte du serveur pour un code connu", () => {
  const codes: Array<[number, string, string, string]> = [
    [404, "OBJET_INTROUVABLE", "introuvable", "Cet objet de réseau est introuvable"],
    [404, "RELATION_INTROUVABLE", "introuvable", "Cette relation est introuvable"],
    [404, "JEU_INTROUVABLE", "introuvable", "Ce jeu de données est introuvable"],
    [422, "ROLE_NON_QUALIFIABLE", "validation", "Seuls les objets d'un réseau de concessionnaire"],
    [422, "NATURE_INCOMPATIBLE_GEOMETRIE", "validation", "pas compatible avec la géométrie"],
    [422, "TYPE_OBJET_INCONNU_POUR_NATURE", "validation", "n'existe pas pour cette nature"],
    [422, "TYPE_OBJET_SANS_NATURE", "validation", "exige une nature connue"],
    [422, "REFERENCE_VERTICALE_SANS_VALEUR", "validation", "exige une profondeur ou une altitude"],
    [422, "PRECISION_INCOHERENTE", "validation", "hors des bornes admises"],
    [409, "JEU_NON_QUALIFIABLE", "conflit", "rejeté, remplacé ou retiré"],
    [409, "RELATIONS_ACTIVES", "conflit", "refusez ou révoquez-la avant de changer sa nature"],
    [422, "NATURE_RELATION_INCOMPATIBLE", "validation", "natures des deux objets"],
    [422, "GEOMETRIE_RELATION_INCOMPATIBLE", "validation", "géométries des deux objets"],
    [422, "RELATION_SUR_SOI", "validation", "relié à lui-même"],
    [409, "RELATION_DEJA_CONNUE", "conflit", "ne se contourne pas par une déclaration manuelle"],
    [409, "TRANSITION_INTERDITE", "conflit", "déjà été traitée par une autre personne"],
    [400, "JUSTIFICATION_INVALIDE", "validation", "10 caractères au moins"],
    [422, "JUSTIFICATION_REQUISE", "validation", "10 caractères"],
    [409, "JEU_NON_AUTORISE", "conflit", "ne portent que sur des jeux autorisés"],
    [504, "ASSOCIATION_TROP_LONGUE", "serveur", "aucune proposition n'a été enregistrée"],
    [504, "COMPTAGE_TROP_LONG", "serveur", "comptage a dépassé le délai"],
    [504, "LECTURE_TROP_LONGUE", "serveur", "lecture a dépassé le délai"],
    [503, "SERVICE_OCCUPE", "serveur", "d'autres calculs"],
    [503, "PROJET_OCCUPE", "serveur", "occupé par une autre opération"],
    [403, "QUARANTAINE_RESERVEE", "droit", "réservé aux administrateurs et aux gestionnaires"],
    [400, "CURSEUR_INVALIDE", "validation", "première page"],
    [400, "CHAMPS_INVALIDES", "validation", "refusées par le serveur"],
  ];
  it.each(codes)("%s %s : genre %s, message en clair, texte du serveur masque", (status, code, genre, extrait) => {
    const e = classerErreurReseau(erreurHttp(status, code));
    expect(e.code).toBe(code);
    expect(e.genre).toBe(genre);
    expect(e.message).toContain(extrait);
    expect(e.message).not.toContain("texte brut du serveur");
  });
  it("429 ASSOCIATION_TROP_FREQUENTE : le delai du corps ou de l'en-tete Retry-After est donne", () => {
    const corps = classerErreurReseau(erreurHttp(429, "ASSOCIATION_TROP_FREQUENTE", { retryAfterS: 27 }));
    expect(corps).toMatchObject({ code: "ASSOCIATION_TROP_FREQUENTE", status: 429, retryAfterS: 27, genre: "serveur" });
    expect(corps.message).toContain("Réessayez dans 27 secondes.");
    const entete = classerErreurReseau(erreurHttp(429, "ASSOCIATION_TROP_FREQUENTE", {}, { "retry-after": "1" }));
    expect(entete.message).toContain("Réessayez dans 1 seconde.");
    expect(entete.message).not.toContain("secondes");
    expect(classerErreurReseau(erreurHttp(429, "ASSOCIATION_TROP_FREQUENTE")).message).toContain("Réessayez dans un instant.");
  });
  it("422 TROP_DE_CIRCUITS : le maximum du serveur est cite quand il est fourni", () => {
    expect(classerErreurReseau(erreurHttp(422, "TROP_DE_CIRCUITS", { maximum: 3000 })).message).toContain("plus de 3000 circuits");
    expect(classerErreurReseau(erreurHttp(422, "TROP_DE_CIRCUITS")).message).toContain("trop de circuits");
    expect(nombreDuCorps(erreurHttp(422, "TROP_DE_CIRCUITS", { maximum: "3000" }), "maximum")).toBe(3000);
    expect(nombreDuCorps(erreurHttp(422, "X"), "maximum")).toBeNull();
  });
  it("INCOHERENCE_REFUSEE : la precision de la base (ecrite par le module) complete le message", () => {
    const e = classerErreurReseau({ response: { status: 422, data: { error: "Refusé par la base : un circuit logique est une ligne", code: "INCOHERENCE_REFUSEE" } } });
    expect(e.message).toContain("La base de données refuse cette écriture comme incohérente.");
    expect(e.message).toContain("Précision du serveur : Refusé par la base : un circuit logique est une ligne");
  });
  it("sans code : 503, 504 et 429 sont expliques (jamais « erreur » nu) ; reseau coupe distingue", () => {
    expect(classerErreurReseau(erreurHttp(503)).message).toContain("momentanément indisponible");
    expect(classerErreurReseau(erreurHttp(504)).message).toContain("délai autorisé");
    expect(classerErreurReseau(erreurHttp(429, undefined, {}, { "retry-after": "5" })).message).toContain("Réessayez dans 5 secondes");
    expect(classerErreurReseau(new Error("Network Error")).genre).toBe("reseau");
  });
  it("COMPTE_REFERENT_RESTREINT : un message precis (ni « pas de cle de module », ni erreur brute)", () => {
    const e = classerErreurReseau(erreurHttp(403, "COMPTE_REFERENT_RESTREINT"));
    expect(e.code).toBe("COMPTE_REFERENT_RESTREINT");
    expect(e.genre).toBe("droit");
    expect(e.message).toContain("Échanges avec les concessionnaires");
    expect(e.message).not.toContain("clé de module");
  });
  it("un code inconnu garde le texte du serveur ; 403 sans code est une permission", () => {
    expect(classerErreurReseau(erreurHttp(409, "CODE_INCONNU")).message).toContain("texte brut du serveur");
    expect(classerErreurReseau(erreurHttp(403)).genre).toBe("permission");
  });
});

describe("presentation de valeurs", () => {
  it("une longueur absente est « non renseignee », jamais 0 m", () => {
    expect(texteMetres(null)).toBe("non renseignée");
    expect(texteMetres(null, "non fournie")).toBe("non fournie");
    expect(texteMetres(0)).toBe("0 m");
    expect(texteMetres(1234.5)).toBe("1 234,5 m");
    expect(texteMetres(Number.NaN)).toBe("non renseignée");
  });
  it("la cible d'un conflit : la qualification du serveur d'abord, la nature sinon, rien si le serveur ne dit rien", () => {
    expect(libelleCibleCourt(null)).toBeNull();
    expect(libelleCibleCourt({ nature: "CIRCUIT_LOGIQUE", origineNature: "JEU", qualification: "CIRCUIT_LOGIQUE_SANS_SUPPORT_VALIDE", libelle: null, supportPhysique: null, tracePartagee: null })).toBe("Circuit logique sans support validé");
    expect(libelleCibleCourt({ nature: "EQUIPEMENT", origineNature: "OBJET", qualification: null, libelle: null, supportPhysique: null, tracePartagee: null })).toBe("Équipement");
    expect(libelleCibleCourt({ nature: null, origineNature: "INCONNUE", qualification: null, libelle: null, supportPhysique: null, tracePartagee: null })).toBeNull();
    expect(QUALIFICATIONS_CIBLE).toHaveLength(5);
  });
});
