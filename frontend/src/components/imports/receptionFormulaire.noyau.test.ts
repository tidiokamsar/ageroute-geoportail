import { describe, expect, it } from "vitest";
import type { MetaImport, ReceptionReponse } from "./types";
import {
  VALEURS_PAR_DEFAUT, accepterDepuisMeta, avertissementExtension, classerEchec, controlerFichier, diagnostiquerBouton,
  extensionDe, formaterDelai, formaterNombre, formaterTaille, joindreFr, libelleChampServeur, natureResultat,
  preparerDonnees, texteAideFormats, traduireDetailServeur, tronquerNom, validerChamp, validerReception,
  type ValeursReception,
} from "./receptionFormulaire.noyau";

/**
 * Noyau du formulaire de réception : ce que ces tests défendent.
 *
 * - Chaque champ obligatoire est refusé vide (espaces compris) avec SON message, et accepté une fois renseigné.
 * - Le fichier est refusé absent, vide ou au-dessus du plafond de /meta (jamais d'une constante), et
 *   une extension incohérente n'est qu'un AVERTISSEMENT : le serveur décide.
 * - Le bouton principal dit ce qui manque, champ par champ.
 * - Un refus du serveur (400 avec code) se distingue d'une réception non confirmée (réseau, 5xx).
 */

const META: MetaImport = {
  formats: [
    { code: "csv", libelle: "CSV (pivot, séparateur ;)", aide: "Fichier texte au format pivot." },
    { code: "geojson", libelle: "GeoJSON (4326)", aide: "Collection de points ou de tronçons en WGS 84." },
  ],
  tailleMaxOctets: 50 * 1024 * 1024,
  limiteLignes: 100000,
  statuts: ["RECU", "VALIDE_SCHEMA", "IMPORTE_TEST", "IMPORTE", "REJETE"],
};

const VALIDES: ValeursReception = {
  systemeSource: "ONR_BDR", format: "csv", methodeSource: "export L2R", versionMapping: "v0", autorisationRef: "AUT-2026-01",
};
const FICHIER = { nom: "lot.csv", taille: 1200 };

describe("validerChamp : un champ obligatoire à la fois", () => {
  const cas: Array<[Exclude<keyof ValeursReception, never>, string, RegExp]> = [
    ["systemeSource", "", /système source/i],
    ["systemeSource", "   ", /système source/i],
    ["format", "", /format/i],
    ["methodeSource", "", /méthode de la source/i],
    ["methodeSource", " \t ", /méthode de la source/i],
    ["versionMapping", "", /version du mapping/i],
    ["autorisationRef", "", /autorisation écrite/i],
    ["autorisationRef", "     ", /autorisation écrite/i],
  ];
  it.each(cas)("refuse %s = %j avec un message qui nomme le champ", (champ, valeur, attendu) => {
    expect(validerChamp(champ, valeur, META)).toMatch(attendu);
  });

  it.each(["systemeSource", "format", "methodeSource", "versionMapping", "autorisationRef"] as const)(
    "accepte %s renseigné", (champ) => {
      expect(validerChamp(champ, VALIDES[champ], META)).toBeNull();
    });

  it("refuse un format absent de /meta et liste ceux qui sont pris en charge", () => {
    const m = validerChamp("format", "xlsx", META);
    expect(m).toMatch(/pas pris en charge/);
    expect(m).toContain("GeoJSON (4326)");
  });

  it("refuse un texte plus long que le serveur ne l'accepte, avec le compte", () => {
    expect(validerChamp("systemeSource", "x".repeat(65), META)).toMatch(/64 caractères au maximum \(vous en avez saisi 65\)/);
    expect(validerChamp("systemeSource", "x".repeat(64), META)).toBeNull();
    expect(validerChamp("methodeSource", "x".repeat(121), META)).toMatch(/120 caractères/);
    expect(validerChamp("autorisationRef", "x".repeat(121), META)).toMatch(/120 caractères/);
  });
});

describe("validerChamp : la référence d'autorisation (audit de sécurité)", () => {
  it.each([
    ["AB", /au moins 5 caractères/],
    ["abcd", /au moins 5 caractères/],
    ["  abcd  ", /au moins 5 caractères/], // les espaces de début et de fin ne comptent pas
  ])("refuse %j : trop courte", (v, attendu) => {
    expect(validerChamp("autorisationRef", v, META)).toMatch(attendu);
  });

  it("le message cite des exemples de références", () => {
    expect(validerChamp("autorisationRef", "ab", META)).toBe(
      "La référence doit comporter au moins 5 caractères (contrat, courrier, numéro de référence...).",
    );
  });

  it("accepte exactement 5 caractères, espaces internes permis", () => {
    expect(validerChamp("autorisationRef", "abcde", META)).toBeNull();
    expect(validerChamp("autorisationRef", "  ab cd  ", META)).toBeNull();
  });

  it.each([
    ["retour à la ligne interne", "AUT-2026\n01"],
    ["retour chariot", "AUT-2026\r01"],
    ["tabulation", "AUT-2026\t01"],
    ["caractère nul", "AUT-2026\u000001"],
    ["séparateur de ligne Unicode", "AUT-2026 01"],
    ["caractère de contrôle C1", "AUT-2026\u008501"],
  ])("refuse une référence sur plusieurs lignes ou avec %s", (_nom, v) => {
    expect(validerChamp("autorisationRef", v, META)).toMatch(/une seule ligne/);
  });

  it("une référence courte compte comme « à corriger », pas comme « manquante »", () => {
    const r = validerReception({ valeurs: { ...VALIDES, autorisationRef: "ab" }, fichier: FICHIER, meta: META });
    expect(r.manques).toEqual([]);
    expect(r.problemes).toEqual(["autorisationRef"]);
  });
});

describe("controlerFichier", () => {
  it("refuse l'absence de fichier", () => {
    expect(controlerFichier(null, "csv", META).erreur).toMatch(/Choisissez le fichier/);
  });

  it("refuse un fichier vide", () => {
    expect(controlerFichier({ nom: "a.csv", taille: 0 }, "csv", META).erreur).toMatch(/vide/);
  });

  it("applique le plafond de /meta, pas une constante : pile au plafond passe, un octet de plus non", () => {
    expect(controlerFichier({ nom: "a.csv", taille: META.tailleMaxOctets }, "csv", META).erreur).toBeNull();
    const trop = controlerFichier({ nom: "a.csv", taille: META.tailleMaxOctets + 1 }, "csv", META);
    expect(trop.erreur).toMatch(/50 Mo/);
    expect(trop.erreur).toMatch(/ne sera pas envoyé/);
    // Un autre plafond annoncé par le serveur change le verdict : la limite n'est pas écrite en dur.
    const petit: MetaImport = { ...META, tailleMaxOctets: 1000 };
    expect(controlerFichier({ nom: "a.csv", taille: 1001 }, "csv", petit).erreur).toMatch(/1000 o|1000/);
    expect(controlerFichier({ nom: "a.csv", taille: 1000 }, "csv", petit).erreur).toBeNull();
  });

  it("un fichier cohérent n'a ni erreur ni avertissement", () => {
    expect(controlerFichier(FICHIER, "csv", META)).toEqual({ erreur: null, avertissement: null });
  });
});

describe("avertissementExtension : un indice, jamais un blocage", () => {
  const cas: Array<[string, string, RegExp | null]> = [
    ["lot.csv", "csv", null],
    ["LOT.CSV", "csv", null],
    ["lot.geojson", "geojson", null],
    ["lot.json", "geojson", null],
    ["lot.geojson", "csv", /évoque le format GeoJSON \(4326\).*déclaré CSV/],
    ["lot.csv", "geojson", /évoque le format CSV/],
    ["lot.xlsx", "csv", /« \.xlsx » n'est pas une de celles attendues pour le format CSV/],
    ["lot", "csv", /pas d'extension/],
    ["lot.csv", "inconnu", null],
  ];
  it.each(cas)("%s déclaré %s", (nom, format, attendu) => {
    const a = avertissementExtension(nom, format, META);
    if (attendu === null) expect(a).toBeNull();
    else expect(a).toMatch(attendu);
  });

  it("dit que le serveur décide, et ne bloque pas", () => {
    const c = controlerFichier({ nom: "lot.xlsx", taille: 10 }, "csv", META);
    expect(c.avertissement).toMatch(/le serveur contrôle le contenu réel du fichier et décide/);
    expect(c.erreur).toBeNull();
  });

  it("n'invente aucun format absent de /meta", () => {
    const seulCsv: MetaImport = { ...META, formats: [META.formats[0]] };
    // .geojson n'évoque plus aucun format annoncé : on parle d'extension inattendue, pas de GeoJSON.
    expect(avertissementExtension("lot.geojson", "csv", seulCsv)).toMatch(/n'est pas une de celles attendues/);
    expect(avertissementExtension("lot.geojson", "csv", seulCsv)).not.toMatch(/GeoJSON/);
  });
});

describe("validerReception", () => {
  it("accepte un ensemble complet", () => {
    const r = validerReception({ valeurs: VALIDES, fichier: FICHIER, meta: META });
    expect(r).toMatchObject({ valide: true, erreurs: {}, manques: [], problemes: [] });
  });

  it("classe les manques dans l'ordre du formulaire", () => {
    const r = validerReception({ valeurs: { ...VALEURS_PAR_DEFAUT, systemeSource: "", versionMapping: "" }, fichier: null, meta: META });
    expect(r.manques).toEqual(["systemeSource", "methodeSource", "versionMapping", "autorisationRef", "fichier"]);
    expect(r.valide).toBe(false);
  });

  it("un fichier trop gros est un problème, pas un manque", () => {
    const r = validerReception({ valeurs: VALIDES, fichier: { nom: "a.csv", taille: META.tailleMaxOctets + 1 }, meta: META });
    expect(r.manques).toEqual([]);
    expect(r.problemes).toEqual(["fichier"]);
  });

  it("rapporte l'avertissement d'extension sans invalider", () => {
    const r = validerReception({ valeurs: VALIDES, fichier: { nom: "a.geojson", taille: 5 }, meta: META });
    expect(r.valide).toBe(true);
    expect(r.avertissements.fichier).toMatch(/GeoJSON/);
  });
});

describe("diagnostiquerBouton : pourquoi « Recevoir et contrôler le lot » est inactif", () => {
  const entree = { valeurs: VALIDES, fichier: FICHIER, meta: META };

  it("est actif quand tout est réuni, sans phrase", () => {
    expect(diagnostiquerBouton(entree)).toEqual({ actif: true, manques: [], problemes: [], phrase: null });
  });

  const manques: Array<[string, Partial<ValeursReception>, RegExp]> = [
    ["le système source", { systemeSource: "" }, /il manque : le système source\./],
    ["la méthode", { methodeSource: "" }, /il manque : la méthode de la source\./],
    ["la version du mapping", { versionMapping: " " }, /il manque : la version du mapping\./],
    ["l'autorisation", { autorisationRef: "" }, /il manque : la référence de l'autorisation écrite\./],
    ["le format", { format: "" }, /il manque : le format\./],
  ];
  it.each(manques)("dit qu'il manque %s", (_n, surcharge, attendu) => {
    const d = diagnostiquerBouton({ ...entree, valeurs: { ...VALIDES, ...surcharge } });
    expect(d.actif).toBe(false);
    expect(d.phrase).toMatch(attendu);
    expect(d.phrase).toMatch(/Pour activer « Recevoir et contrôler le lot »/);
  });

  it("dit qu'il manque le fichier", () => {
    const d = diagnostiquerBouton({ ...entree, fichier: null });
    expect(d.actif).toBe(false);
    expect(d.phrase).toMatch(/il manque : un fichier\./);
  });

  it("énumère plusieurs manques avec « et »", () => {
    const d = diagnostiquerBouton({ valeurs: { ...VALIDES, methodeSource: "", autorisationRef: "" }, fichier: null, meta: META });
    expect(d.phrase).toMatch(/il manque : la méthode de la source, la référence de l'autorisation écrite et un fichier\./);
    expect(d.manques).toEqual(["methodeSource", "autorisationRef", "fichier"]);
  });

  it("dit de corriger un fichier trop gros", () => {
    const d = diagnostiquerBouton({ ...entree, fichier: { nom: "a.csv", taille: META.tailleMaxOctets + 1 } });
    expect(d.actif).toBe(false);
    expect(d.phrase).toMatch(/corrigez : le fichier choisi/);
  });

  it("dit de corriger une référence trop courte et ce qui manque en plus", () => {
    const d = diagnostiquerBouton({ valeurs: { ...VALIDES, autorisationRef: "ab", methodeSource: "" }, fichier: FICHIER, meta: META });
    expect(d.phrase).toMatch(/il manque : la méthode de la source\. Il faut aussi corriger : la référence de l'autorisation écrite \(au moins 5 caractères/);
  });

  it("pendant l'envoi : inactif, avec l'avertissement de ne pas relancer", () => {
    const d = diagnostiquerBouton({ ...entree, envoiEnCours: true });
    expect(d.actif).toBe(false);
    expect(d.phrase).toMatch(/Envoi en cours/);
  });

  it("formulaire désactivé par le parent : inactif, avec sa raison si elle est donnée", () => {
    expect(diagnostiquerBouton({ ...entree, desactive: true }).phrase).toMatch(/indisponible/);
    expect(diagnostiquerBouton({ ...entree, desactive: true, raisonDesactive: "Chargement des formats…" }).phrase).toBe("Chargement des formats…");
  });
});

describe("mise en forme", () => {
  it.each([
    [0, "0 o"], [1, "1 o"], [1023, "1023 o"], [1024, "1 Ko"], [1536, "1,5 Ko"], [12 * 1024, "12 Ko"],
    [1024 * 1024, "1 Mo"], [50 * 1024 * 1024, "50 Mo"], [Math.round(2.34 * 1024 * 1024), "2,3 Mo"],
    [1024 * 1024 * 1024, "1 Go"], [1024 * 1024 - 1, "1 Mo"],
  ])("formaterTaille(%d) = %s", (octets, attendu) => {
    expect(formaterTaille(octets)).toBe(attendu);
  });

  it("formaterTaille refuse l'invraisemblable plutôt que d'inventer", () => {
    expect(formaterTaille(-1)).toBe("taille inconnue");
    expect(formaterTaille(Number.NaN)).toBe("taille inconnue");
  });

  it.each([[100000, "100 000"], [999, "999"], [1234567, "1 234 567"]])("formaterNombre(%d) = %s", (n, s) => {
    expect(formaterNombre(n)).toBe(s);
  });

  it.each([[[], ""], [["a"], "a"], [["a", "b"], "a et b"], [["a", "b", "c"], "a, b et c"]])("joindreFr(%j) = %j", (liste, s) => {
    expect(joindreFr(liste as string[])).toBe(s);
  });

  it.each([["a.csv", ".csv"], ["A.CSV", ".csv"], ["archive.tar.gz", ".gz"], ["sans", ""], ["fin.", ""], [".caché", ".caché"]])(
    "extensionDe(%j) = %j", (nom, ext) => { expect(extensionDe(nom)).toBe(ext); });

  it("tronquerNom garde l'extension et laisse intact un nom court", () => {
    expect(tronquerNom("lot.csv")).toBe("lot.csv");
    const long = "export_releves_RN1_2026_octobre_version_finale_corrigee.geojson";
    const court = tronquerNom(long, 30);
    expect(Array.from(court).length).toBe(30);
    expect(court.endsWith(".geojson")).toBe(true);
    expect(court).toContain("…");
    expect(long.startsWith(court.slice(0, 10))).toBe(true);
  });

  it("tronquerNom ne perd pas l'extension même très longue du nom, et traite un nom sans extension", () => {
    expect(tronquerNom("a".repeat(60) + ".csv", 20).endsWith(".csv")).toBe(true);
    expect(Array.from(tronquerNom("b".repeat(60), 20)).length).toBe(20);
  });

  it("tronquerNom compte les points de code (pas de caractère coupé en deux)", () => {
    const nom = "é".repeat(50) + ".csv";
    expect(tronquerNom(nom, 20)).toMatch(/^é+….csv$/);
  });
});

describe("textes tirés de /meta", () => {
  it("accept = extensions des formats annoncés, sans doublon", () => {
    expect(accepterDepuisMeta(META)).toBe(".csv,.geojson,.json");
    expect(accepterDepuisMeta({ ...META, formats: [META.formats[0]] })).toBe(".csv");
    expect(accepterDepuisMeta({ ...META, formats: [] })).toBeUndefined();
  });

  it("l'aide reprend les libellés et les plafonds du serveur", () => {
    const t = texteAideFormats(META);
    expect(t).toContain("CSV (pivot, séparateur ;) et GeoJSON (4326)");
    expect(t).toContain("Seuls ces formats sont pris en charge");
    expect(t).toContain("50 Mo");
    expect(t).toContain("100 000 lignes");
    const autre = texteAideFormats({ ...META, formats: [{ code: "csv", libelle: "Tableur maison", aide: "" }], tailleMaxOctets: 5 * 1024 * 1024, limiteLignes: 0 });
    expect(autre).toContain("Tableur maison");
    expect(autre).toContain("5 Mo");
    expect(autre).not.toContain("lignes");
    expect(autre).not.toContain("GeoJSON");
  });

  it("sans format annoncé, le dit", () => {
    expect(texteAideFormats({ ...META, formats: [] })).toMatch(/aucun format/i);
  });
});

describe("preparerDonnees", () => {
  it("retire les espaces de début et de fin", () => {
    expect(preparerDonnees({ systemeSource: " ONR ", format: "csv ", methodeSource: " m ", versionMapping: " v1 ", autorisationRef: " AUT-1 " })).toEqual({
      systemeSource: "ONR", format: "csv", methodeSource: "m", versionMapping: "v1", autorisationRef: "AUT-1",
    });
  });
});

describe("classerEchec : refus du serveur ou réception non confirmée", () => {
  const axios = (status: number, data: unknown, headers: Record<string, string> = {}) => ({ response: { status, data, headers } });

  const parCode: Array<[string, "fichier" | "format", RegExp]> = [
    ["FICHIER_MANQUANT", "fichier", /aucun fichier/],
    ["FICHIER_VIDE", "fichier", /fichier vide/],
    ["FICHIER_TROP_GROS", "fichier", /taille maximale.*50 Mo/],
    ["TROP_DE_LIGNES", "fichier", /100 000 lignes/],
    ["ENCODAGE_NON_UTF8", "fichier", /pas encodé en UTF-8 : réenregistrez-le en UTF-8 puis réessayez/],
    ["FORMAT_INCOHERENT", "format", /ne correspond pas au format déclaré/],
  ];

  it.each(parCode)("400 %s : refus, texte propre et rattaché au champ %s", (code, champ, texte) => {
    const e = classerEchec(axios(400, { error: "brut", code }), META);
    expect(e.nature).toBe("refus");
    expect(e.code).toBe(code);
    expect(e.titre).toMatch(/refusé la réception\. Rien n'a été enregistré/);
    expect(e.message).toMatch(texte);
    expect(e.champs[champ]).toMatch(texte);
    expect(e.delaiSecondes).toBeNull();
  });

  it("400 TELEVERSEMENT_INVALIDE : refus sans champ", () => {
    const e = classerEchec(axios(400, { error: "televersement invalide", code: "TELEVERSEMENT_INVALIDE" }), META);
    expect(e.nature).toBe("refus");
    expect(e.message).toMatch(/interrompu ou était mal formé/);
    expect(e.champs).toEqual({});
  });

  it("400 CHAMPS_INVALIDES : détails rattachés aux champs, en français", () => {
    const e = classerEchec(axios(400, {
      error: "champs invalides", code: "CHAMPS_INVALIDES",
      details: {
        systemeSource: ["Required"], autorisationRef: ["String must contain at least 5 character(s)"],
        methodeSource: ["String must contain at most 120 character(s)"], dateSource: ["Invalid date"],
      },
    }), META);
    expect(e.nature).toBe("refus");
    expect(e.champs.systemeSource).toBe("Le serveur refuse cette valeur : valeur manquante.");
    expect(e.champs.autorisationRef).toMatch(/valeur trop courte \(5 caractères au minimum\)/);
    expect(e.champs.methodeSource).toMatch(/trop longue \(120 caractères au maximum\)/);
    expect(Object.keys(e.champs)).not.toContain("dateSource");
    expect(e.autres).toEqual(["dateSource : date non valide"]);
    expect(JSON.stringify(e)).not.toMatch(/String must|Required/);
  });

  it("400 « champs invalides » sans code (serveur non encore à jour) : reconnu par ses détails", () => {
    const e = classerEchec(axios(400, { error: "champs invalides", details: { methodeSource: ["Required"] } }), META);
    expect(e.code).toBe("CHAMPS_INVALIDES");
    expect(e.champs.methodeSource).toMatch(/valeur manquante/);
  });

  it("400 avec un code inconnu : le texte du serveur, sans rien inventer", () => {
    const e = classerEchec(axios(400, { error: "autre chose", code: "NOUVEAU_CODE" }), META);
    expect(e.nature).toBe("refus");
    expect(e.message).toBe("Le serveur a répondu : autre chose.");
  });

  it("400 sans corps lisible : refus, motif non donné", () => {
    expect(classerEchec(axios(400, "<html>"), META).message).toMatch(/sans en donner le motif/);
  });

  it("413 du serveur web : traité comme un fichier trop gros", () => {
    const e = classerEchec(axios(413, ""), META);
    expect(e.nature).toBe("refus");
    expect(e.code).toBe("FICHIER_TROP_GROS");
    expect(e.champs.fichier).toMatch(/50 Mo/);
  });

  it("403 et 401 : refus, avec une phrase adaptée", () => {
    expect(classerEchec(axios(403, {}), META)).toMatchObject({ nature: "refus", message: expect.stringMatching(/pas autorisé/) });
    expect(classerEchec(axios(401, {}), META)).toMatchObject({ nature: "refus", message: expect.stringMatching(/session a expiré/) });
  });

  it("503 SERVICE_OCCUPE : le serveur affirme que rien n'a été enregistré ; le délai Retry-After est proposé", () => {
    const e = classerEchec(axios(503, { error: "occupé", code: "SERVICE_OCCUPE" }, { "retry-after": "30" }), META);
    expect(e.nature).toBe("refus");
    expect(e.code).toBe("SERVICE_OCCUPE");
    expect(e.titre).toMatch(/serveur est occupé\. Rien n'a été enregistré pour ce fichier/);
    expect(e.message).toMatch(/traite déjà d'autres lots.*réessayez dans quelques instants/);
    expect(e.message).toMatch(/Délai conseillé par le serveur : 30 secondes/);
    expect(e.delaiSecondes).toBe(30);
    expect(e.message).not.toMatch(/pas pu être confirmée/);
  });

  it.each([
    ["sans en-tête", {}, null],
    ["en minutes", { "retry-after": "120" }, 120],
    ["une seconde", { "retry-after": "1" }, 1],
    ["date HTTP (non lue, pas d'horloge)", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, null],
    ["valeur absurde", { "retry-after": "-5" }, null],
  ])("503 SERVICE_OCCUPE, Retry-After %s", (_n, entetes, delai) => {
    const e = classerEchec(axios(503, { code: "SERVICE_OCCUPE" }, entetes as Record<string, string>), META);
    expect(e.nature).toBe("refus");
    expect(e.delaiSecondes).toBe(delai);
    if (delai === null) expect(e.message).not.toMatch(/Délai conseillé/);
  });

  it("formaterDelai", () => {
    expect(formaterDelai(1)).toBe("1 seconde");
    expect(formaterDelai(30)).toBe("30 secondes");
    expect(formaterDelai(120)).toBe("2 minutes");
    expect(formaterDelai(61)).toBe("2 minutes");
  });

  it("503 sans le code SERVICE_OCCUPE (passerelle, serveur tombé) : réception non confirmée", () => {
    const e = classerEchec(axios(503, "<html>Service Unavailable</html>", { "retry-after": "5" }), META);
    expect(e.nature).toBe("incertain");
    expect(e.delaiSecondes).toBeNull();
  });

  it.each([
    ["réseau coupé (axios sans réponse)", { code: "ERR_NETWORK", message: "Network Error" }],
    ["délai dépassé", { code: "ECONNABORTED", message: "timeout of 30000ms exceeded" }],
    ["500", axios(500, { error: "boom" })],
    ["502", axios(502, "")],
    ["504", axios(504, "")],
    ["408", axios(408, "")],
    ["erreur quelconque", new Error("x")],
    ["rien", undefined],
  ])("%s : la réception n'a pas pu être confirmée", (_n, erreur) => {
    const e = classerEchec(erreur, META);
    expect(e.nature).toBe("incertain");
    expect(e.titre).toBe("La réception n'a pas pu être confirmée.");
    expect(e.message).toMatch(/Consultez la liste des lots avant de réessayer : le lot a peut-être été enregistré/);
    expect(e.champs).toEqual({});
  });

  it("lit aussi la forme directe { status, code, details }", () => {
    const e = classerEchec({ status: 400, code: "FICHIER_VIDE" }, META);
    expect(e.nature).toBe("refus");
    expect(e.champs.fichier).toMatch(/vide/);
  });
});

describe("traduireDetailServeur", () => {
  it.each([
    ["Required", "valeur manquante"],
    ["String must contain at least 1 character(s)", "valeur vide"],
    ["String must contain at least 5 character(s)", "valeur trop courte (5 caractères au minimum)"],
    ["String must contain at most 64 character(s)", "valeur trop longue (64 caractères au maximum)"],
    ["Invalid enum value. Expected 'csv' | 'geojson', received 'x'", "valeur non admise"],
    ["Invalid date", "date non valide"],
    ["quelque chose d'inattendu", "valeur non acceptée"],
  ])("%s", (brut, attendu) => { expect(traduireDetailServeur(brut)).toBe(attendu); });
});

describe("natureResultat et libellés", () => {
  const base: ReceptionReponse = {
    id: "1", reference: "IMP-1", statut: "VALIDE_SCHEMA", dejaRecu: false, motifRejetLot: null,
    compteurs: { lues: 1, validees: 1, rejetees: 0, ignorees: 0 },
  };
  it.each([
    [{}, "controle"],
    [{ statut: "REJETE" }, "rejete"],
    [{ dejaRecu: true }, "dejaRecu"],
    [{ dejaRecu: true, statut: "REJETE" }, "dejaRecu"],
    [{ statut: "RECU" }, "autre"],
    [{ statut: "IMPORTE" }, "autre"],
  ])("%j", (surcharge, attendu) => {
    expect(natureResultat({ ...base, ...(surcharge as Partial<ReceptionReponse>) })).toBe(attendu);
  });

  it("libelleChampServeur", () => {
    expect(libelleChampServeur("methodeSource")).toBe("Méthode de la source");
    expect(libelleChampServeur("auteurSource")).toBe("Auteur de la source");
    expect(libelleChampServeur("inconnu")).toBe("inconnu");
  });
});

describe("style des textes", () => {
  it("aucun tiret cadratin ni demi-cadratin dans les messages produits", () => {
    const textes = [
      texteAideFormats(META),
      diagnostiquerBouton({ valeurs: { ...VALEURS_PAR_DEFAUT }, fichier: null, meta: META }).phrase ?? "",
      controlerFichier({ nom: "a.xlsx", taille: META.tailleMaxOctets + 1 }, "csv", META).erreur ?? "",
      avertissementExtension("a.xlsx", "csv", META) ?? "",
      classerEchec({ response: { status: 503, data: { code: "SERVICE_OCCUPE" }, headers: { "retry-after": "9" } } }, META).message,
      classerEchec(undefined, META).message,
    ].join("\n");
    expect(textes).not.toMatch(/[—–]/);
  });
});
