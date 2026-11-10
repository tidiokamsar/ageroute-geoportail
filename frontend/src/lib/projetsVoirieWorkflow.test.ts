import { describe, expect, it } from "vitest";
import {
  ACTIONS_WORKFLOW, BANDEAU_WORKFLOW, FILTRES_DEMANDES_VIDES, FILTRES_RECOLEMENTS_VIDES, FILTRES_TACHES_VIDES, LIBELLE_ACTION_WORKFLOW, LIBELLE_ENVOI_HORS_APPLICATION, MENTION_AUCUN_ENVOI,
  MENTION_PREUVES, MENTION_RECOLEMENT, MESSAGE_CODE_WORKFLOW, RAPPEL_SEPARATION_WORKFLOW, SAISIE_PREUVE_VIDE, SAISIE_TACHE_VIDE, STATUTS_DEMANDE, STYLE_STATUT_DEMANDE, STYLE_STATUT_RECOLEMENT,
  STYLE_STATUT_TACHE, aLeDroit, aujourdhuiUtc, classerErreurWorkflow, corpsPreuve, erreursDemande, erreursEnvoi, erreursPreuve, erreursRecolement, erreursReception, erreursTache, jourValide,
  libelleTransitionDemande, libelleTransitionRecolement, libelleTransitionTache, manquePourSoumettre, paramsDemandes, paramsRecolements, paramsTaches, partageeImposee, referenceDangereuse,
  sectionsOuvertes, typesPreuvePermis, type ActionWorkflow, type SaisiePreuve, type SaisieRecolement, type SaisieTache,
} from "./projetsVoirieWorkflow";

/**
 * Noyau pur du workflow concessionnaire (lot B3, interface) : droits, sections, filtres, saisies, preuves (references et empreintes seulement), erreurs typees.
 * Le contrat (CONTRAT-WORKFLOW.md) et le code du backend font foi ; le serveur reste l'autorite.
 */

const U = "11111111-1111-4111-8111-111111111111";
const erreurHttp = (status: number, code?: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  ({ response: { status, data: { error: "texte brut du serveur : valeur X12", ...(code ? { code } : {}), ...extra }, headers } });

describe("l'application n'envoie rien : mentions obligatoires", () => {
  it("le libelle impose : l'envoi se fait hors application, enregistrez-le ici", () => {
    expect(LIBELLE_ENVOI_HORS_APPLICATION).toBe("L'envoi se fait hors application, enregistrez-le ici");
    expect(MENTION_AUCUN_ENVOI).toMatch(/L'application n'envoie rien/);
    expect(MENTION_AUCUN_ENVOI).toMatch(/hors application/);
    expect(BANDEAU_WORKFLOW).toMatch(/n'envoie aucun message, ne donne aucun ordre, ne déplace aucun réseau/);
  });
  it("une preuve est une reference et une empreinte : aucun fichier n'est stocke", () => {
    expect(MENTION_PREUVES).toMatch(/aucun fichier/);
    expect(MENTION_PREUVES).toMatch(/n'ouvre ni ne suit jamais une référence/);
  });
  it("valider un recolement ne met a jour ni le referentiel, ni un jeu, ni le conflit", () => {
    expect(MENTION_RECOLEMENT).toMatch(/ni le référentiel officiel, ni un jeu de données, ni le dossier de conflit/);
  });
  it("aucun libelle d'action ni de transition n'ordonne, n'envoie, n'execute ni ne deplace", () => {
    const tous = [
      ...Object.values(LIBELLE_ACTION_WORKFLOW),
      ...STATUTS_DEMANDE.map(libelleTransitionDemande),
      ...(["A_FAIRE", "EN_COURS", "A_VALIDER", "TERMINEE", "ANNULEE"] as const).flatMap((a) => (["A_FAIRE", "EN_COURS", "A_VALIDER", "TERMINEE", "ANNULEE"] as const).map((b) => libelleTransitionTache(a, b))),
      ...(["BROUILLON", "SOUMIS", "VALIDE", "REJETE"] as const).flatMap((a) => (["BROUILLON", "SOUMIS", "VALIDE", "REJETE"] as const).map((b) => libelleTransitionRecolement(a, b))),
    ].join(" | ");
    expect(tous).not.toMatch(/ordonner|exécuter|executer|déplacer|deplacer|lancer les travaux/i);
    // « Envoyer » n'existe que sous la forme « enregistrer l'envoi (fait hors application) ».
    expect(libelleTransitionDemande("ENVOYEE")).toBe("Enregistrer l'envoi (fait hors application)");
    expect(tous).not.toMatch(/\bEnvoyer\b/);
  });
  it("aucun texte n'emploie d'emoji ni de tiret cadratin", () => {
    const textes = [MENTION_AUCUN_ENVOI, MENTION_PREUVES, MENTION_RECOLEMENT, BANDEAU_WORKFLOW, RAPPEL_SEPARATION_WORKFLOW, ...Object.values(MESSAGE_CODE_WORKFLOW), ...Object.values(LIBELLE_ACTION_WORKFLOW)].join("\n");
    expect(textes).not.toMatch(/\u2014/);
    expect(textes).not.toMatch(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u);
  });
  it("chaque statut a un libelle, une aide et une forme (le mot et la forme portent l'information)", () => {
    for (const st of [STYLE_STATUT_DEMANDE, STYLE_STATUT_TACHE, STYLE_STATUT_RECOLEMENT]) {
      for (const s of Object.values(st)) { expect(s.libelle.length).toBeGreaterThan(3); expect(s.aide.length).toBeGreaterThan(15); expect(s.classes).toMatch(/text-\w+-(800|900)/); }
    }
    expect(new Set(Object.values(STYLE_STATUT_RECOLEMENT).map((s) => s.forme)).size).toBe(4);
  });
});

describe("droits : aucune action n'est supposee", () => {
  it("un droit n'existe que s'il est renvoye par le serveur", () => {
    expect(aLeDroit(["workflow.lire"], "workflow.lire")).toBe(true);
    expect(aLeDroit(["workflow.lire"], "demande.ecrire")).toBe(false);
    expect(aLeDroit([], "workflow.lire")).toBe(false);
    expect(aLeDroit(null, "workflow.lire")).toBe(false);
    expect(aLeDroit(undefined, "workflow.lire")).toBe(false);
  });
  it("les sections ouvertes suivent les droits : le referent n'a ni la section Referents ni l'ecriture", () => {
    const referent: ActionWorkflow[] = ["workflow.lire", "tache.executer", "preuve.ajouter"];
    expect(sectionsOuvertes(referent)).toEqual(["profil", "demandes", "taches", "recolements", "dossiers"]);
    expect(sectionsOuvertes(ACTIONS_WORKFLOW)).toEqual(["profil", "demandes", "taches", "recolements", "dossiers", "referents"]);
    expect(sectionsOuvertes(["referent.lire", "workflow.lire"])).toContain("referents");
  });
  it("un agent de terrain ne voit que ses taches ; un lecteur n'a que son profil", () => {
    expect(sectionsOuvertes(["tache.executer", "preuve.ajouter"])).toEqual(["profil", "taches"]);
    expect(sectionsOuvertes([])).toEqual(["profil"]);
    expect(sectionsOuvertes(null)).toEqual(["profil"]);
  });
});

describe("filtres et parametres", () => {
  it("demandes : statut, concessionnaire UUID, echeance depassee, curseur ; limite 25", () => {
    expect(paramsDemandes(FILTRES_DEMANDES_VIDES, null)).toEqual({ limite: 25 });
    expect(paramsDemandes({ statut: "ENVOYEE", concessionnaireId: U, echeanceDepassee: true }, "c")).toEqual({ limite: 25, statut: "ENVOYEE", concessionnaireId: U, echeanceDepassee: "true", curseur: "c" });
    expect(paramsDemandes({ statut: "", concessionnaireId: "pas-un-uuid", echeanceDepassee: false }, null)).toEqual({ limite: 25 });
  });
  it("taches et recolements", () => {
    expect(paramsTaches(FILTRES_TACHES_VIDES, null)).toEqual({ limite: 25 });
    expect(paramsTaches({ statut: "A_VALIDER", responsableId: U, echeanceDepassee: false }, "x")).toEqual({ limite: 25, statut: "A_VALIDER", responsableId: U, curseur: "x" });
    expect(paramsTaches({ statut: "", responsableId: "abc", echeanceDepassee: false }, null)).toEqual({ limite: 25 });
    expect(paramsRecolements(FILTRES_RECOLEMENTS_VIDES, null)).toEqual({ limite: 25 });
    expect(paramsRecolements({ statut: "SOUMIS" }, "y")).toEqual({ limite: 25, statut: "SOUMIS", curseur: "y" });
  });
});

describe("dates", () => {
  it("jour valide : vraie date AAAA-MM-JJ entre 1900 et 2100", () => {
    expect(jourValide("2026-11-08")).toBe(true);
    expect(jourValide("2026-02-30")).toBe(false);
    expect(jourValide("08/11/2026")).toBe(false);
    expect(jourValide("1899-01-01")).toBe(false);
    expect(jourValide("2101-01-01")).toBe(false);
    expect(aujourdhuiUtc(new Date("2026-11-08T23:30:00Z"))).toBe("2026-11-08");
  });
});

describe("demande : creation, envoi enregistre, reception", () => {
  it("creation : concessionnaire UUID et objet obligatoires, bornes, echeance valide", () => {
    expect(erreursDemande({ concessionnaireId: U, objet: "Plan", description: "", echeance: "" }, true)).toEqual([]);
    expect(erreursDemande({ concessionnaireId: "", objet: "Plan", description: "", echeance: "" }, true)).toContain("Choisissez le concessionnaire.");
    expect(erreursDemande({ concessionnaireId: U, objet: "  ", description: "", echeance: "" }, true)).toContain("L'objet de la demande est obligatoire.");
    expect(erreursDemande({ concessionnaireId: U, objet: "x".repeat(201), description: "", echeance: "" }, true)).toContain("L'objet fait 200 caractères au plus.");
    expect(erreursDemande({ concessionnaireId: U, objet: "Plan", description: "d".repeat(4001), echeance: "" }, true)).toContain("La description fait 4 000 caractères au plus.");
    expect(erreursDemande({ concessionnaireId: U, objet: "Plan", description: "", echeance: "2026-02-30" }, true)).toContain("L'échéance doit être une date valide.");
    expect(erreursDemande({ concessionnaireId: "", objet: "Plan", description: "", echeance: "" }, false)).toEqual([]);
  });
  it("envoi : canal et date obligatoires, la date n'est jamais dans le futur (un envoi deja fait)", () => {
    const ok = { canalEnvoi: "Courriel", dateEnvoi: "2026-11-03", referenceEnvoi: "", interlocuteur: "" };
    expect(erreursEnvoi(ok, "2026-11-08")).toEqual([]);
    expect(erreursEnvoi({ ...ok, canalEnvoi: " " }, "2026-11-08")).toContain("Indiquez le canal de l'envoi (courriel, courrier, remise en main propre...).");
    expect(erreursEnvoi({ ...ok, dateEnvoi: "" }, "2026-11-08")).toContain("Indiquez la date de l'envoi.");
    expect(erreursEnvoi({ ...ok, dateEnvoi: "2026-11-09" }, "2026-11-08")[0]).toMatch(/pas être dans le futur/);
    expect(erreursEnvoi({ ...ok, dateEnvoi: "2026-11-08" }, "2026-11-08")).toEqual([]);
    expect(erreursEnvoi({ ...ok, dateEnvoi: "demain" }, "2026-11-08")[0]).toMatch(/date valide/);
    expect(erreursEnvoi({ ...ok, canalEnvoi: "c".repeat(101) }, "2026-11-08")).toContain("Le canal fait 100 caractères au plus.");
    expect(erreursEnvoi({ ...ok, referenceEnvoi: "r".repeat(201), interlocuteur: "i".repeat(201) }, "2026-11-08")).toHaveLength(2);
  });
  it("reception : date obligatoire, ni dans le futur, ni avant l'envoi", () => {
    const ok = { dateReception: "2026-11-05", jeuRecuId: "", note: "" };
    expect(erreursReception(ok, "2026-11-03", "2026-11-08")).toEqual([]);
    expect(erreursReception({ ...ok, dateReception: "" }, "2026-11-03", "2026-11-08")).toContain("Indiquez la date de réception de la réponse.");
    expect(erreursReception({ ...ok, dateReception: "2026-11-02" }, "2026-11-03", "2026-11-08")).toContain("La réponse ne peut pas être reçue avant l'envoi.");
    expect(erreursReception({ ...ok, dateReception: "2026-11-09" }, "2026-11-03", "2026-11-08")).toContain("La date de réception ne peut pas être dans le futur.");
    expect(erreursReception({ ...ok, dateReception: "2026-11-02" }, null, "2026-11-08")).toEqual([]);
    expect(erreursReception({ ...ok, jeuRecuId: "pas-un-uuid" }, null, "2026-11-08")).toContain("Le jeu reçu choisi n'est pas valide.");
    expect(erreursReception({ ...ok, jeuRecuId: U }, null, "2026-11-08")).toEqual([]);
  });
});

describe("tache et recolement : saisies", () => {
  const tache = (over: Partial<SaisieTache> = {}): SaisieTache => ({ ...SAISIE_TACHE_VIDE, titre: "Verifier", responsableId: U, ...over });
  it("tache : titre et responsable (UUID) obligatoires ; un lien exige son choix", () => {
    expect(erreursTache(tache())).toEqual([]);
    expect(erreursTache(tache({ titre: " " }))).toContain("Le titre de la tâche est obligatoire.");
    expect(erreursTache(tache({ responsableId: "" }))[0]).toMatch(/Choisissez le responsable/);
    expect(erreursTache(tache({ responsableId: "pas-un-uuid" }))[0]).toMatch(/UUID/);
    expect(erreursTache(tache({ lien: "DEMANDE" }))).toContain("Choisissez la demande liée.");
    expect(erreursTache(tache({ lien: "CONFLIT" }))).toContain("Choisissez le dossier de conflit lié.");
    expect(erreursTache(tache({ lien: "CONFLIT", conflitId: U }))).toEqual([]);
    expect(erreursTache(tache({ echeance: "2026-13-01" }))).toContain("L'échéance doit être une date valide.");
  });
  const rec = (over: Partial<SaisieRecolement> = {}): SaisieRecolement => ({ lien: "CONFLIT", conflitId: U, jeuId: "", objet: "Recolement", constat: "", ecarts: "", dateRecolement: "", ...over });
  it("recolement : un dossier, un jeu ou les deux ; l'objet est obligatoire", () => {
    expect(erreursRecolement(rec(), true)).toEqual([]);
    expect(erreursRecolement(rec({ conflitId: "" }), true)[0]).toMatch(/dossier de conflit dont un déplacement est décidé/);
    expect(erreursRecolement(rec({ lien: "JEU", conflitId: "", jeuId: U }), true)).toEqual([]);
    expect(erreursRecolement(rec({ lien: "JEU", conflitId: "", jeuId: "" }), true)[0]).toMatch(/jeu reçu/);
    expect(erreursRecolement(rec({ lien: "LES_DEUX", jeuId: "" }), true)).toHaveLength(1);
    expect(erreursRecolement(rec({ objet: " " }), true)).toContain("L'objet du récolement est obligatoire.");
    expect(erreursRecolement(rec({ conflitId: "" }), false)).toEqual([]);
    expect(erreursRecolement(rec({ constat: "c".repeat(4001) }), true)).toContain("Le constat fait 4 000 caractères au plus.");
  });
  it("soumettre exige un objet et un constat : dit avant l'envoi", () => {
    expect(manquePourSoumettre({ objet: "Recolement", constat: "Fibre deplacee" })).toEqual([]);
    expect(manquePourSoumettre({ objet: "Recolement", constat: null })).toEqual(["le constat"]);
    expect(manquePourSoumettre({ objet: " ", constat: "  " })).toEqual(["l'objet", "le constat"]);
  });
});

describe("preuves : references et empreintes, JAMAIS un fichier", () => {
  const p = (over: Partial<SaisiePreuve> = {}): SaisiePreuve => ({ ...SAISIE_PREUVE_VIDE, texte: "Courrier du 03/11", ...over });
  it("une reference commençant par un schema executable est refusee ; une reference ordinaire est du texte", () => {
    for (const r of ["javascript:alert(1)", " JavaScript:x", "data:text/html,<b>", "vbscript:x", "file:///etc/passwd"]) expect(referenceDangereuse(r)).toBe(true);
    for (const r of ["COUR-2026-41", "https://exemple.test/plan", "ARCH-12 / javascript-non", "C:\\archives\\plan.pdf"]) expect(referenceDangereuse(r)).toBe(false);
    expect(erreursPreuve(p({ reference: "javascript:alert(1)" }))[0]).toMatch(/jamais un lien exécutable/);
    expect(erreursPreuve(p({ reference: "COUR-2026-41" }))).toEqual([]);
  });
  it("texte obligatoire, empreinte SHA-256 de 64 hexadecimaux, taille entiere", () => {
    expect(erreursPreuve(p({ texte: " " }))[0]).toMatch(/texte de la preuve est obligatoire/);
    expect(erreursPreuve(p({ sha256: "abc" }))[0]).toMatch(/64 caractères hexadécimaux/);
    expect(erreursPreuve(p({ sha256: "ab".repeat(32) }))).toEqual([]);
    expect(erreursPreuve(p({ sha256: "AB".repeat(32) }))).toEqual([]);
    expect(erreursPreuve(p({ sha256: "zz".repeat(32) }))).toHaveLength(1);
    expect(erreursPreuve(p({ tailleOctets: "12,5" }))[0]).toMatch(/nombre entier d'octets/);
    expect(erreursPreuve(p({ tailleOctets: "2147483648" }))).toHaveLength(1);
    expect(erreursPreuve(p({ tailleOctets: "2048" }))).toEqual([]);
    expect(erreursPreuve(p({ nomFichier: "n".repeat(256) }))).toContain("Le nom du fichier fait 255 caractères au plus.");
  });
  it("le corps ne porte que du texte, une empreinte en minuscules et une taille declaree : jamais le contenu d'un fichier", () => {
    const c = corpsPreuve(p({ type: "PLAN_RECOLEMENT", reference: " ARCH-12 ", nomFichier: " plan.pdf ", sha256: "AB".repeat(32), tailleOctets: "2048", partagee: true }), "GESTIONNAIRE");
    expect(c).toEqual({ type: "PLAN_RECOLEMENT", texte: "Courrier du 03/11", reference: "ARCH-12", nomFichier: "plan.pdf", sha256: "ab".repeat(32), tailleOctets: 2048, partagee: true });
    expect(Object.keys(c).sort()).toEqual(["nomFichier", "partagee", "reference", "sha256", "tailleOctets", "texte", "type"]);
    expect(corpsPreuve(p(), "GESTIONNAIRE")).toMatchObject({ reference: null, nomFichier: null, sha256: null, tailleOctets: null, partagee: false });
  });
  it("types et visibilite imposes par profil : le referent partage toujours, l'agent de terrain jamais", () => {
    expect(typesPreuvePermis("REFERENT")).toEqual(["NOTE", "REFERENCE_DOCUMENT", "REPONSE_CONCESSIONNAIRE", "PLAN_RECOLEMENT"]);
    expect(typesPreuvePermis("INSPECTEUR")).toEqual(["NOTE", "REFERENCE_DOCUMENT", "RELEVE_TERRAIN"]);
    expect(typesPreuvePermis("GESTIONNAIRE")).toHaveLength(6);
    expect(typesPreuvePermis(null)).toHaveLength(6);
    expect(partageeImposee("REFERENT")).toBe(true);
    expect(partageeImposee("INSPECTEUR")).toBe(false);
    expect(partageeImposee("ADMIN")).toBeNull();
    expect(corpsPreuve(p({ partagee: false }), "REFERENT").partagee).toBe(true);
    expect(corpsPreuve(p({ partagee: true }), "INSPECTEUR").partagee).toBe(false);
  });
});

describe("erreurs typees : message en clair, jamais le texte du serveur pour un code connu", () => {
  const codes: Array<[number, string, string, string]> = [
    [403, "COMPTE_REFERENT_RESTREINT", "droit", "n'ouvre que l'écran des échanges"],
    [403, "ACTION_NON_AUTORISEE", "droit", "Votre profil ne permet pas cette action"],
    [404, "PROJET_INTROUVABLE", "introuvable", "Projet introuvable"],
    [404, "DEMANDE_INTROUVABLE", "introuvable", "Cette demande est introuvable"],
    [404, "TACHE_INTROUVABLE", "introuvable", "Cette tâche est introuvable"],
    [404, "RECOLEMENT_INTROUVABLE", "introuvable", "Ce récolement est introuvable"],
    [404, "RATTACHEMENT_INTROUVABLE", "introuvable", "Ce rattachement est introuvable"],
    [404, "CONCESSIONNAIRE_INTROUVABLE", "introuvable", "Ce concessionnaire est introuvable"],
    [404, "CONFLIT_INTROUVABLE", "introuvable", "Ce dossier de conflit est introuvable"],
    [404, "JEU_INTROUVABLE", "introuvable", "Ce jeu de données est introuvable"],
    [400, "COMPTE_INCONNU", "validation", "n'existe pas"],
    [400, "REFERENCE_INVALIDE", "validation", "jamais un lien exécutable"],
    [400, "CURSEUR_INVALIDE", "validation", "première page"],
    [400, "CHAMPS_INVALIDES", "validation", "refusées par le serveur"],
    [409, "TRANSITION_INTERDITE", "conflit", "déjà été traité par une autre personne"],
    [409, "STATUT_INCOMPATIBLE", "conflit", "état final"],
    [409, "SEPARATION_DES_TACHES", "conflit", "exige un tiers"],
    [409, "PREUVE_REQUISE", "conflit", "qui n'est pas une simple note"],
    [409, "RECOLEMENT_EN_COURS", "conflit", "déjà en cours"],
    [409, "RATTACHEMENT_DEJA_ACTIF", "conflit", "déjà référent"],
    [409, "RATTACHEMENT_DEJA_REVOQUE", "conflit", "déjà révoqué"],
    [409, "RECOLEMENT_NON_VALIDE", "conflit", "doit être validé par un tiers"],
    [422, "JUSTIFICATION_REQUISE", "validation", "10 caractères"],
    [422, "DATE_INVALIDE", "validation", "pas être dans le futur"],
    [422, "RESPONSABLE_NON_HABILITE", "validation", "ne peut pas être responsable"],
    [422, "COMPTE_NON_ELIGIBLE", "validation", "actif de rôle lecteur"],
    [422, "COMPTE_SANS_MODULE", "validation", "clé de module"],
    [422, "CONCESSIONNAIRE_INCOHERENT", "validation", "ne correspond pas"],
    [422, "LIEN_INVALIDE", "validation", "pas aux deux"],
    [422, "CONFLIT_NON_ELIGIBLE", "validation", "déplacement de réseau est décidé"],
    [422, "CHAMPS_INCOMPLETS", "validation", "objet et un constat"],
    [422, "QUOTA_ATTEINT", "validation", "plafond"],
    [503, "PROJET_OCCUPE", "serveur", "occupé par une autre écriture"],
  ];
  it.each(codes)("%s %s : genre %s, message en clair, texte du serveur masque", (status, code, genre, extrait) => {
    const e = classerErreurWorkflow(erreurHttp(status, code));
    expect(e.code).toBe(code);
    expect(e.genre).toBe(genre);
    expect(e.message).toContain(extrait);
    // Seule la separation des taches ajoute la precision du serveur (qui peut deroger), sous une etiquette explicite.
    if (code !== "SEPARATION_DES_TACHES") expect(e.message).not.toContain("texte brut du serveur");
  });
  it("429 CADENCE_CREATION : le delai du corps ou de l'en-tete est donne", () => {
    const a = classerErreurWorkflow(erreurHttp(429, "CADENCE_CREATION", { retryAfterS: 12 }));
    expect(a).toMatchObject({ code: "CADENCE_CREATION", genre: "serveur", retryAfterS: 12 });
    expect(a.message).toContain("Réessayez dans 12 secondes.");
    expect(classerErreurWorkflow(erreurHttp(429, "CADENCE_CREATION", {}, { "retry-after": "1" })).message).toContain("Réessayez dans 1 seconde.");
    expect(classerErreurWorkflow(erreurHttp(429, "CADENCE_CREATION")).message).toContain("Réessayez dans un instant.");
  });
  it("SEPARATION_DES_TACHES : la precision du serveur complete le message", () => {
    const e = classerErreurWorkflow({ response: { status: 409, data: { error: "Un récolement doit être validé par un tiers.", code: "SEPARATION_DES_TACHES" } } });
    expect(e.message).toContain("Précision du serveur : Un récolement doit être validé par un tiers.");
  });
  it("sans code : 503, 504, 429 expliques ; reseau coupe ; un code inconnu garde le texte du serveur", () => {
    expect(classerErreurWorkflow(erreurHttp(503)).message).toContain("momentanément indisponible");
    expect(classerErreurWorkflow(erreurHttp(504)).message).toContain("délai autorisé");
    expect(classerErreurWorkflow(erreurHttp(429, undefined, {}, { "retry-after": "5" })).message).toContain("Réessayez dans 5 secondes");
    expect(classerErreurWorkflow(new Error("Network Error")).genre).toBe("reseau");
    expect(classerErreurWorkflow(erreurHttp(409, "CODE_INCONNU")).message).toContain("texte brut du serveur");
    expect(classerErreurWorkflow(erreurHttp(403)).genre).toBe("permission");
  });
});
