import { describe, expect, it } from "vitest";
import {
  BANDEAU_GARDE_FOUS, FILTRES_VIDES, OPTIONS_DECISION, STATUTS_CONFLIT, STYLE_STATUT_CONFLIT, TYPES_CONFLIT, FORME_TYPE_CONFLIT, LIBELLE_OPTION_DECISION,
  bboxDeGeometrie, classerErreurConflit, echeanceDepassee, erreursDecision, erreursRegle, exigencesTransition, justificationValide, libelleAction, libelleTransition,
  lireMontant, nbFiltresActifs, paramsListeConflits, transitionsDeSecours, trierConflits,
  type SaisieDecision, type StatutConflit,
} from "./projetsVoirieConflits";

/**
 * Noyau pur des dossiers de conflit : machine a etats (affichage de secours), filtres, tri, echeance, geometrie, saisies, erreurs typees.
 * Le contrat (CONTRAT-CONFLITS.md section 4) fait foi pour la table des transitions ; le serveur reste l'autorite.
 */

describe("garde-fous et vocabulaire", () => {
  it("le bandeau reprend le texte du contrat, mot pour mot", () => {
    expect(BANDEAU_GARDE_FOUS).toBe("Un conflit est un signal de vérification : aucun déplacement n'est décidé ni ordonné par le système. L'absence de conflit détecté ne prouve pas l'absence de réseau.");
  });
  it("chaque statut a un libelle, une aide et une FORME propre (la couleur ne porte pas seule)", () => {
    const formes = STATUTS_CONFLIT.map((s) => STYLE_STATUT_CONFLIT[s].forme);
    expect(new Set(formes).size).toBe(STATUTS_CONFLIT.length);
    for (const s of STATUTS_CONFLIT) { expect(STYLE_STATUT_CONFLIT[s].libelle.length).toBeGreaterThan(3); expect(STYLE_STATUT_CONFLIT[s].aide.length).toBeGreaterThan(20); }
  });
  it("chaque type a une forme distincte", () => {
    expect(new Set(TYPES_CONFLIT.map((t) => FORME_TYPE_CONFLIT[t])).size).toBe(TYPES_CONFLIT.length);
  });
  it("aucun libelle d'option ni de transition n'ordonne, n'execute ni ne deplace sans condition", () => {
    const tous = [...Object.values(LIBELLE_OPTION_DECISION), ...STATUTS_CONFLIT.flatMap((a) => STATUTS_CONFLIT.map((b) => libelleTransition(a, b)))].join(" | ");
    expect(tous).not.toMatch(/ordonner|exécuter|executer|lancer les travaux|déplacer maintenant/i);
    // « Deplacer le reseau » n'existe que comme PROPOSITION.
    expect(LIBELLE_OPTION_DECISION.DEPLACER_RESEAU).toMatch(/proposition/);
    expect(OPTIONS_DECISION).toHaveLength(5);
  });
  it("une action d'historique inconnue est montree telle quelle", () => {
    expect(libelleAction("STATUT")).toBe("Changement de statut");
    expect(libelleAction("NOUVELLE_ACTION")).toBe("NOUVELLE_ACTION");
  });
});

describe("machine a etats : table de secours (contrat, section 4)", () => {
  const cas: Array<[StatutConflit, string, StatutConflit[]]> = [
    ["A_INVESTIGUER", "GESTIONNAIRE", ["POTENTIEL", "INFIRME"]],
    ["A_INVESTIGUER", "ADMIN", ["POTENTIEL", "INFIRME"]],
    ["POTENTIEL", "GESTIONNAIRE", ["CONFIRME", "INFIRME", "A_INVESTIGUER"]],
    ["CONFIRME", "GESTIONNAIRE", ["TRAITEMENT_DECIDE"]],
    ["CONFIRME", "ADMIN", ["TRAITEMENT_DECIDE", "INFIRME"]],
    ["TRAITEMENT_DECIDE", "GESTIONNAIRE", []],
    ["TRAITEMENT_DECIDE", "ADMIN", ["INFIRME", "CLOTURE"]],
    ["INFIRME", "GESTIONNAIRE", ["A_INVESTIGUER"]],
    ["INFIRME", "ADMIN", ["A_INVESTIGUER"]],
    ["CLOTURE", "ADMIN", []],
    ["CLOTURE", "GESTIONNAIRE", []],
  ];
  it.each(cas)("%s, role %s : %j", (statut, role, attendu) => {
    expect(transitionsDeSecours(statut, role)).toEqual(attendu);
  });
  it("un lecteur (ou un role inconnu) n'a AUCUNE transition, quel que soit l'etat", () => {
    for (const s of STATUTS_CONFLIT) {
      expect(transitionsDeSecours(s, "LECTEUR")).toEqual([]);
      expect(transitionsDeSecours(s, undefined)).toEqual([]);
    }
  });
  it("jamais de retour direct a un etat qui ne figure pas au tableau (CLOTURE n'a pas de sortie, aucune transition vers le calcul)", () => {
    for (const s of STATUTS_CONFLIT) for (const r of ["ADMIN", "GESTIONNAIRE"]) {
      for (const v of transitionsDeSecours(s, r)) { expect(v).not.toBe(s); }
    }
    expect(transitionsDeSecours("CLOTURE", "ADMIN")).toHaveLength(0);
  });
  it("les exigences : preuve pour confirmer, decision approuvee pour decider, cloture", () => {
    expect(exigencesTransition("POTENTIEL", "CONFIRME")).toMatchObject({ justification: true, preuveRequise: true, decisionApprouveeRequise: false, cloture: false });
    expect(exigencesTransition("CONFIRME", "TRAITEMENT_DECIDE")).toMatchObject({ preuveRequise: false, decisionApprouveeRequise: true });
    expect(exigencesTransition("TRAITEMENT_DECIDE", "CLOTURE")).toMatchObject({ cloture: true });
    expect(exigencesTransition("A_INVESTIGUER", "POTENTIEL")).toMatchObject({ preuveRequise: false, decisionApprouveeRequise: false, cloture: false });
  });
  it("la justification valide compte 10 caracteres utiles", () => {
    expect(justificationValide("123456789")).toBe(false);
    expect(justificationValide("   123456789   ")).toBe(false);
    expect(justificationValide("1234567890")).toBe(true);
  });
});

describe("echeance depassee", () => {
  const nous = new Date(2026, 10, 6, 12, 0, 0);
  it("strictement avant aujourd'hui et dossier ouvert", () => {
    expect(echeanceDepassee("2026-11-05", "POTENTIEL", nous)).toBe(true);
    expect(echeanceDepassee("2026-11-06", "POTENTIEL", nous)).toBe(false);
    expect(echeanceDepassee("2026-12-01", "CONFIRME", nous)).toBe(false);
    expect(echeanceDepassee("2026-11-05T00:00:00.000Z", "A_INVESTIGUER", nous)).toBe(true);
  });
  it("jamais pour un dossier clos ou infirme, ni sans echeance, ni pour une date illisible", () => {
    expect(echeanceDepassee("2026-01-01", "CLOTURE", nous)).toBe(false);
    expect(echeanceDepassee("2026-01-01", "INFIRME", nous)).toBe(false);
    expect(echeanceDepassee(null, "POTENTIEL", nous)).toBe(false);
    expect(echeanceDepassee("bientot", "POTENTIEL", nous)).toBe(false);
  });
});

describe("filtres, parametres de requete et tri", () => {
  it("seuls les filtres renseignes partent ; le tri n'est pas un parametre serveur", () => {
    expect(paramsListeConflits(FILTRES_VIDES, null)).toEqual({});
    expect(paramsListeConflits({ ...FILTRES_VIDES, statut: "POTENTIEL", type: "PROXIMITE", axe: " Axe A ", concessionnaireId: "c1", responsableId: "u1", aReexaminer: true, echeanceDepassee: true, q: " fibre ", tri: "risque" }, "cur-2")).toEqual({
      statut: "POTENTIEL", type: "PROXIMITE", axe: "Axe A", concessionnaireId: "c1", responsableId: "u1", aReexaminer: "true", echeanceDepassee: "true", q: "fibre", curseur: "cur-2",
    });
    expect(paramsListeConflits({ ...FILTRES_VIDES, aReexaminer: false, echeanceDepassee: false }, null)).not.toHaveProperty("aReexaminer");
  });
  it("compte les filtres actifs, sans le tri", () => {
    expect(nbFiltresActifs(FILTRES_VIDES)).toBe(0);
    expect(nbFiltresActifs({ ...FILTRES_VIDES, tri: "axe" })).toBe(0);
    expect(nbFiltresActifs({ ...FILTRES_VIDES, statut: "CONFIRME", aReexaminer: true, q: "  " })).toBe(2);
  });
  const c = (id: string, over: Partial<{ statut: StatutConflit; type: (typeof TYPES_CONFLIT)[number]; axe: string | null; risque: "FAIBLE" | "MOYEN" | "ELEVE" | "INCONNU" | null; echeance: string | null }> = {}) =>
    ({ id, statut: "POTENTIEL" as StatutConflit, type: "PROXIMITE" as const, axe: "Axe 2", risque: null, echeance: null, ...over });
  it("tri par echeance : les plus proches d'abord, sans echeance en dernier, stable", () => {
    const r = trierConflits([c("a"), c("b", { echeance: "2026-12-01" }), c("c", { echeance: "2026-11-10" }), c("d")], "echeance").map((x) => x.id);
    expect(r).toEqual(["c", "b", "a", "d"]);
  });
  it("tri par statut dans l'ordre du dossier, par risque (inconnu apres faible, absent en dernier), par axe naturel", () => {
    expect(trierConflits([c("a", { statut: "CLOTURE" }), c("b", { statut: "A_INVESTIGUER" }), c("c", { statut: "CONFIRME" })], "statut").map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(trierConflits([c("a", { risque: "INCONNU" }), c("b", { risque: "FAIBLE" }), c("c", { risque: "ELEVE" }), c("d", { risque: null })], "risque").map((x) => x.id)).toEqual(["c", "b", "a", "d"]);
    expect(trierConflits([c("a", { axe: "Axe 10" }), c("b", { axe: "Axe 2" }), c("c", { axe: null })], "axe").map((x) => x.id)).toEqual(["b", "a", "c"]);
  });
  it("le tri « ordre du serveur » ne change rien, et aucun tri ne modifie la liste d'origine", () => {
    const liste = [c("a", { axe: "B" }), c("b", { axe: "A" })];
    expect(trierConflits(liste, "serveur").map((x) => x.id)).toEqual(["a", "b"]);
    trierConflits(liste, "axe");
    expect(liste.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("emprise d'une geometrie (zoom de la carte)", () => {
  it("point, ligne, multiligne, polygone, collection, feature", () => {
    expect(bboxDeGeometrie({ type: "Point", coordinates: [-10.1, 9.2] })).toEqual([-10.1, 9.2, -10.1, 9.2]);
    expect(bboxDeGeometrie({ type: "LineString", coordinates: [[-10.1, 9.2], [-10.0, 9.3]] })).toEqual([-10.1, 9.2, -10.0, 9.3]);
    expect(bboxDeGeometrie({ type: "MultiLineString", coordinates: [[[-10.1, 9.2], [-10.05, 9.25]], [[-10.0, 9.3], [-9.9, 9.1]]] })).toEqual([-10.1, 9.1, -9.9, 9.3]);
    expect(bboxDeGeometrie({ type: "Polygon", coordinates: [[[-10, 9], [-9.9, 9], [-9.9, 9.1], [-10, 9]]] })).toEqual([-10, 9, -9.9, 9.1]);
    expect(bboxDeGeometrie({ type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [-10, 9] }, { type: "Point", coordinates: [-9, 10] }] })).toEqual([-10, 9, -9, 10]);
    expect(bboxDeGeometrie({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-10.1, 9.2] } })).toEqual([-10.1, 9.2, -10.1, 9.2]);
  });
  it("rien d'exploitable : null (jamais un cadrage invente)", () => {
    expect(bboxDeGeometrie(null)).toBeNull();
    expect(bboxDeGeometrie({ type: "Point", coordinates: [] })).toBeNull();
    expect(bboxDeGeometrie({ type: "Point", coordinates: [500, 900] })).toBeNull();
    expect(bboxDeGeometrie("x")).toBeNull();
  });
});

describe("saisies : couts distincts, jamais calcules ; regles", () => {
  const base: SaisieDecision = { option: "PROTEGER", justification: "Protection mécanique du fourreau", contraintes: "", coutEstime: "", deviseCout: "", coutReel: "", dateDebutPrevue: "", dateFinPrevue: "" };
  it("un montant vide est null (pas zero), une virgule est lue, du texte est refuse", () => {
    expect(lireMontant("")).toBeNull();
    expect(lireMontant("  ")).toBeNull();
    expect(lireMontant("1 250,5".replace(" ", ""))).toBe(1250.5);
    expect(lireMontant("0")).toBe(0);
    expect(Number.isNaN(lireMontant("beaucoup"))).toBe(true);
  });
  it("saisie complete ou sans cout : aucune erreur", () => {
    expect(erreursDecision(base)).toEqual([]);
    expect(erreursDecision({ ...base, coutEstime: "12000", deviseCout: "GNF" })).toEqual([]);
    expect(erreursDecision({ ...base, coutEstime: "12000", coutReel: "0", deviseCout: "GNF" })).toEqual([]);
  });
  it("chaque erreur est dite", () => {
    expect(erreursDecision({ ...base, option: "" })).toContain("Choisissez une option.");
    expect(erreursDecision({ ...base, justification: "court" }).join(" ")).toMatch(/au moins 10 caractères/);
    expect(erreursDecision({ ...base, coutEstime: "abc", deviseCout: "GNF" })).toContain("Le coût estimé n'est pas un nombre.");
    expect(erreursDecision({ ...base, coutReel: "-5", deviseCout: "GNF" })).toContain("Le coût réel ne peut pas être négatif.");
    expect(erreursDecision({ ...base, coutEstime: "10" })).toContain("Indiquez la devise des coûts saisis (par exemple GNF).");
    expect(erreursDecision({ ...base, coutEstime: "10", deviseCout: "gnf" })).toContain("La devise s'écrit sur trois lettres majuscules (par exemple GNF).");
    expect(erreursDecision({ ...base, coutEstime: "10", deviseCout: "GNFF" })).toContain("La devise s'écrit sur trois lettres majuscules (par exemple GNF).");
    expect(erreursDecision({ ...base, coutEstime: "10", deviseCout: "EUR" })).toEqual([]);
    expect(erreursDecision({ ...base, dateDebutPrevue: "2026-12-10", dateFinPrevue: "2026-12-01" })).toContain("La date de fin prévue ne peut pas précéder la date de début prévue.");
  });
  it("deplacer un reseau : responsable et planning complet exiges (regles du serveur, AT-09) ; les autres options non", () => {
    const dep = { ...base, option: "DEPLACER_RESEAU" as const };
    expect(erreursDecision(dep, { responsableConnu: false }).join(" ")).toMatch(/Désignez d'abord un responsable/);
    expect(erreursDecision(dep, { responsableConnu: true }).join(" ")).toMatch(/planning complet/);
    expect(erreursDecision({ ...dep, dateDebutPrevue: "2027-01-10" }, { responsableConnu: true }).join(" ")).toMatch(/planning complet/);
    expect(erreursDecision({ ...dep, dateDebutPrevue: "2027-01-10", dateFinPrevue: "2027-01-20" }, { responsableConnu: true })).toEqual([]);
    expect(erreursDecision({ ...base, option: "PROTEGER" }, { responsableConnu: false })).toEqual([]);
    expect(erreursDecision({ ...base, option: "A_ETUDIER" })).toEqual([]);
  });

  it("regle : aucune tolerance n'est inventee, tout champ requis est exige", () => {
    const ok = { famille: "TELECOM" as const, code: "RC-2D-0.2", toleranceProximiteM: "2", margeIncertitude: "1", justification: "Tolérance validée avec le concessionnaire" };
    expect(erreursRegle(ok)).toEqual([]);
    expect(erreursRegle({ ...ok, famille: "", toleranceProximiteM: "0" })).toEqual([]);
    expect(erreursRegle({ ...ok, toleranceProximiteM: "" }).join(" ")).toMatch(/aucune valeur n'est proposée/);
    expect(erreursRegle({ ...ok, toleranceProximiteM: "-1" }).join(" ")).toMatch(/compris entre 0 et 1 000/);
    expect(erreursRegle({ ...ok, toleranceProximiteM: "1001" }).join(" ")).toMatch(/compris entre 0 et 1 000/);
    expect(erreursRegle({ ...ok, toleranceProximiteM: "1000" })).toEqual([]);
    expect(erreursRegle({ ...ok, margeIncertitude: "101" }).join(" ")).toMatch(/compris entre 0 et 100/);
    expect(erreursRegle({ ...ok, margeIncertitude: "" }).join(" ")).toMatch(/marge/);
    expect(erreursRegle({ ...ok, code: "  " }).join(" ")).toMatch(/code/);
    expect(erreursRegle({ ...ok, code: "x".repeat(65) }).join(" ")).toMatch(/2 à 64/);
    expect(erreursRegle({ ...ok, code: "x" }).join(" ")).toMatch(/2 à 64/);
    expect(erreursRegle({ ...ok, code: "RC 2D" }).join(" ")).toMatch(/lettres, chiffres/);
    expect(erreursRegle({ ...ok, code: "RC-2D-0.2_a" })).toEqual([]);
    expect(erreursRegle({ ...ok, justification: "trop vite" }).join(" ")).toMatch(/justification/);
  });
});

describe("erreurs typees du lot", () => {
  const err = (status: number, code?: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(String(status)), { response: { status, data: { error: "texte du serveur", ...(code ? { code } : {}), ...extra } } });
  it.each([
    ["TRANSITION_INTERDITE", 409, "conflit", /n'est pas permise/],
    ["SEPARATION_DES_TACHES", 409, "conflit", /Séparation des tâches/],
    ["DECISION_REQUISE", 409, "conflit", /décision approuvée est requise/],
    ["PREUVE_REQUISE", 409, "conflit", /Au moins une preuve/],
    ["JUSTIFICATION_REQUISE", 422, "validation", /au moins 10 caractères/],
    ["REGLE_IMMUABLE", 409, "conflit", /immuable/],
    ["ROLE_INSUFFISANT", 403, "droit", /réservés aux administrateurs/],
    ["MENTION_RECOLEMENT_REQUISE", 422, "validation", /récolement reste à valider/],
    ["RESPONSABLE_REQUIS", 422, "validation", /responsable doit être désigné/],
    ["PLANNING_REQUIS", 422, "validation", /date de début et une date de fin/],
    ["STATUT_INCOMPATIBLE", 409, "conflit", /conflit confirmé/],
    ["DECISION_DEJA_TRANCHEE", 409, "conflit", /vient d'être tranchée/],
    ["RESPONSABLE_INCONNU", 400, "validation", /n'existe pas ou n'est pas actif/],
    ["ANALYSE_NON_COMPARABLE", 409, "conflit", /analyse en échec/],
  ] as const)("%s (%i) : message en clair, genre %s, jamais le texte brut du serveur", (code, status, genre, motif) => {
    const e = classerErreurConflit(err(status, code));
    expect(e.code).toBe(code);
    expect(e.genre).toBe(genre);
    expect(e.message).toMatch(motif);
    expect(e.message).not.toContain("texte du serveur");
    expect(e.message).toMatch(/Rien n'a été modifié|Rechargez|revenez|choisissez|Vérifiez|Utilisez/i);
  });
  it("503 PROJET_OCCUPE, 503 SERVICE_OCCUPE, 504 ANALYSE_TROP_LONGUE : expliques", () => {
    const occupe = classerErreurConflit(err(503, "PROJET_OCCUPE"));
    expect(occupe.message).toMatch(/Ce projet ou ce dossier est occupé/);
    expect(occupe.message).toMatch(/une analyse est peut-être en cours/);
    expect(occupe.genre).toBe("serveur");
    expect(classerErreurConflit(err(503, "SERVICE_OCCUPE")).message).toMatch(/Réessayez/);
    expect(classerErreurConflit(err(504, "ANALYSE_TROP_LONGUE")).message).toMatch(/délai/);
  });
  it("un 504 et un 503 SANS code sont expliques, un 403 sans code parle du role, un 404 de conflit est introuvable", () => {
    const a = classerErreurConflit(err(504));
    expect(a.genre).toBe("serveur");
    expect(a.message).toMatch(/délai autorisé \(504\)/);
    expect(a.message).toMatch(/historique des analyses/);
    expect(classerErreurConflit(err(503)).message).toMatch(/\(503\)/);
    const p = classerErreurConflit(err(403));
    expect(p.genre).toBe("permission");
    expect(p.message).toMatch(/administrateur et gestionnaire/);
    const n = classerErreurConflit(err(404, "CONFLIT_INTROUVABLE"));
    expect(n.genre).toBe("introuvable");
  });
  it("sans reponse : reseau ; reponse inattendue du lecteur : inattendue", () => {
    expect(classerErreurConflit(new Error("Network Error")).genre).toBe("reseau");
    const r = Object.assign(new Error("Réponse inattendue du serveur (x)."), { name: "ProjetVoirieReponseInattendue" });
    expect(classerErreurConflit(r).genre).toBe("inattendue");
  });
  it("un code inconnu garde le comportement du socle", () => {
    const e = classerErreurConflit(err(409, "AUTRE_CODE"));
    expect(e.genre).toBe("conflit");
    expect(e.message).toBe("texte du serveur");
  });
});
