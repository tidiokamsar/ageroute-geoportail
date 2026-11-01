import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  abregerTexte, AIDE_ERREUR_DROITS, AIDE_ERREUR_LISTE, DATE_ILLISIBLE, DATE_INCONNUE, descripteurEtat, descripteurStatut, estEtatConnu,
  estStatutConnu, ETATS_ETAPE, etapesAucunLot, formaterDate, formaterTaille, iconeEtape, indiceEtapeEnCours, libelleEtatEtape, libelleStatut,
  MESSAGE_AUCUN_LOT, MESSAGE_ERREUR_DROITS, MESSAGE_ERREUR_LISTE, messageErreurListe, nettoyerTexte, NOM_FICHIER_INCONNU,
  nomAccessibleEtape, ORDRE_ETAPES, RAISON_MANQUANTE, raisonAffichee, REGLES_RECEPTION, resumeEtapes, STATUTS_LOT, TAILLE_INCONNUE,
  TITRES_ETAPES, tronquerNomFichier, TONS, PHRASE_GOUVERNANCE, TITRE_GOUVERNANCE, type NomIcone, type NomTon,
} from "./imports.noyau";
import type { Etape, EtatEtape, StatutLot } from "./types";

/**
 * Le noyau pur : tout est teste par table. Ce que ces tests defendent :
 *   - un statut « en attente » ou « non applique » n'est jamais en ton de reussite ; un statut ou un etat INCONNU non plus ;
 *   - chaque statut et chaque etat a une icone ET un texte (la couleur ne porte pas le sens seule) ;
 *   - la taille se calcule depuis une CHAINE, sans Number() : aucun arrondi silencieux au-dela de 2^53 ;
 *   - la date est deterministe (UTC, aucune horloge, aucun fuseau de la machine) ;
 *   - un nom de fichier est abrege sans perdre son extension et sans signe de sens de lecture ;
 *   - le fichier reste pur (garde de source, comme src/roulage/noyau.garde.test.ts).
 */

const NBSP = " ";
const FINE = " ";

describe("statuts du lot", () => {
  const table: [StatutLot, string, NomTon, NomIcone][] = [
    ["RECU", "Reçu", "neutre", "boite"],
    ["VALIDE_SCHEMA", "Schéma validé : non appliqué", "attention", "sablier"],
    ["IMPORTE_TEST", "Importé en test", "info", "fiole"],
    ["IMPORTE", "Importé", "succes", "coche"],
    ["REJETE", "Rejeté", "echec", "croix"],
  ];

  it.each(table)("%s : libelle, ton et icone", (statut, libelle, ton, icone) => {
    const d = descripteurStatut(statut);
    expect(d).toMatchObject({ code: statut, libelle, ton, icone, connu: true });
    expect(libelleStatut(statut)).toBe(libelle);
    expect(d.description.length).toBeGreaterThan(20);
  });

  it("les cinq statuts du contrat sont couverts, avec cinq tons DISTINCTS", () => {
    expect(table.map((t) => t[0])).toEqual([...STATUTS_LOT]);
    expect(new Set(table.map((t) => t[2])).size).toBe(5);
    expect(new Set(table.map((t) => t[3])).size).toBe(5);
    expect(STATUTS_LOT.every(estStatutConnu)).toBe(true);
  });

  it("SEUL « Importé » a le ton de reussite : un lot en attente ou non applique n'est jamais vert", () => {
    expect(STATUTS_LOT.filter((s) => descripteurStatut(s).ton === "succes")).toEqual(["IMPORTE"]);
    expect(descripteurStatut("VALIDE_SCHEMA").ton).not.toBe("succes");
    expect(descripteurStatut("RECU").ton).not.toBe("succes");
  });

  it("le libelle de VALIDE_SCHEMA dit lui-meme « non appliqué »", () => {
    expect(libelleStatut("VALIDE_SCHEMA")).toMatch(/non appliqué/);
  });

  it.each([["TERMINE"], [""], ["recu"], [null], [undefined], [42], [{}], ["__proto__"], ["toString"], ["constructor"]])(
    "une valeur inattendue (%j) est neutre et dite inconnue, jamais en reussite",
    (valeur) => {
      const d = descripteurStatut(valeur);
      expect(d).toMatchObject({ connu: false, ton: "neutre", icone: "cercle" });
      expect(d.libelle).toMatch(/^Statut inconnu/);
      expect(estStatutConnu(valeur)).toBe(false);
    },
  );

  it("le code inconnu affiche est nettoye et abrege", () => {
    const d = descripteurStatut("X‮".repeat(50) + "fin");
    expect(d.libelle).not.toMatch(/‮/);
    expect(Array.from(d.code).length).toBeLessThanOrEqual(40);
  });
});

describe("tons", () => {
  it("chaque ton declare des jetons et des classes de jetons, sans teinte Tailwind brute", () => {
    for (const ton of Object.values(TONS)) {
      expect(Object.values(ton.jetons).every((j) => /^[a-z-]+$/.test(j))).toBe(true);
      for (const c of Object.values(ton.classes).join(" ").split(/\s+/)) {
        expect(c).not.toMatch(/-(red|green|amber|yellow|orange|blue|gray|slate|emerald|lime|teal|sky)-\d/);
      }
    }
    expect(Object.keys(TONS).sort()).toEqual(["attention", "echec", "info", "neutre", "succes"]);
  });
});

describe("etats d'etape", () => {
  const table: [EtatEtape, string, NomTon, NomIcone, boolean][] = [
    ["TERMINEE", "Terminée", "succes", "coche", false],
    ["TERMINEE_AVEC_RESERVES", "Terminée avec réserves", "attention", "alerte", false],
    ["ECHEC", "Échec", "echec", "croix", false],
    ["EN_COURS", "En cours", "info", "chargement", false],
    ["NON_DISPONIBLE", "Non disponible", "neutre", "cadenas", true],
    ["NON_COMMENCEE", "Non commencée", "neutre", "cercle", false],
  ];

  it.each(table)("%s : libelle, ton, icone, tirets", (etat, libelle, ton, icone, pointille) => {
    expect(descripteurEtat(etat)).toMatchObject({ code: etat, libelle, ton, icone, pointille, connu: true });
    expect(libelleEtatEtape(etat)).toBe(libelle);
    expect(iconeEtape(etat)).toBe(icone);
  });

  it("les six etats du contrat sont couverts, six apparences DISTINCTES (ton + icone + tirets)", () => {
    expect(table.map((t) => t[0])).toEqual([...ETATS_ETAPE]);
    expect(new Set(table.map((t) => t[1])).size).toBe(6);
    expect(new Set(table.map((t) => `${t[2]}|${t[3]}|${t[4]}`)).size).toBe(6);
  });

  it("seule une etape TERMINEE est en ton de reussite", () => {
    expect(table.filter((t) => t[2] === "succes").map((t) => t[0])).toEqual(["TERMINEE"]);
  });

  it("« non disponible » est pointille avec un cadenas, et « non commencee » ne l'est pas", () => {
    expect(descripteurEtat("NON_DISPONIBLE")).toMatchObject({ pointille: true, icone: "cadenas" });
    expect(descripteurEtat("NON_COMMENCEE").pointille).toBe(false);
  });

  it.each([["TERMINE"], [null], [undefined], [3], ["terminee"], ["toString"]])("un etat inattendu (%j) est « État inconnu » en neutre", (v) => {
    expect(descripteurEtat(v)).toMatchObject({ connu: false, libelle: "État inconnu", ton: "neutre", icone: "cercle" });
    expect(estEtatConnu(v)).toBe(false);
  });
});

describe("raison, nom accessible, etape en cours", () => {
  const e = (etat: EtatEtape, raison = "", titre = "Échantillon à valider"): Etape => ({ id: "echantillon", titre, etat, raison });

  it("la raison du serveur est rendue telle quelle (rognee), jamais deduite", () => {
    expect(raisonAffichee(e("NON_DISPONIBLE", "  Aucun circuit d'approbation. "))).toBe("Aucun circuit d'approbation.");
  });

  it.each<[EtatEtape, string]>([
    ["NON_DISPONIBLE", RAISON_MANQUANTE],
    ["ECHEC", RAISON_MANQUANTE],
    ["TERMINEE_AVEC_RESERVES", RAISON_MANQUANTE],
    ["TERMINEE", ""],
    ["EN_COURS", ""],
    ["NON_COMMENCEE", ""],
  ])("raison absente, etat %s", (etat, attendu) => {
    expect(raisonAffichee(e(etat))).toBe(attendu);
    expect(raisonAffichee({ etat, raison: undefined as unknown as string })).toBe(attendu);
  });

  it.each<[number, number, EtatEtape, string, string]>([
    [3, 4, "NON_DISPONIBLE", "Aucun circuit.", "Étape 3 sur 4, non disponible : Échantillon à valider. Aucun circuit."],
    [1, 4, "TERMINEE", "", "Étape 1 sur 4, terminée : Échantillon à valider."],
    [2, 4, "ECHEC", "Colonne absente.", "Étape 2 sur 4, échec : Échantillon à valider. Colonne absente."],
    [2, 4, "TERMINEE_AVEC_RESERVES", "Colonnes inconnues.", "Étape 2 sur 4, terminée avec réserves : Échantillon à valider. Colonnes inconnues."],
    [4, 4, "EN_COURS", "", "Étape 4 sur 4, en cours : Échantillon à valider."],
    [1, 4, "NON_COMMENCEE", "", "Étape 1 sur 4, non commencée : Échantillon à valider."],
  ])("nom accessible : etape %i sur %i, %s", (rang, total, etat, raison, attendu) => {
    expect(nomAccessibleEtape(rang, total, e(etat, raison))).toBe(attendu);
  });

  it("indiceEtapeEnCours : la premiere etape EN_COURS, sinon -1", () => {
    expect(indiceEtapeEnCours([])).toBe(-1);
    expect(indiceEtapeEnCours([{ etat: "TERMINEE" }, { etat: "NON_DISPONIBLE" }])).toBe(-1);
    expect(indiceEtapeEnCours([{ etat: "TERMINEE" }, { etat: "EN_COURS" }, { etat: "EN_COURS" }])).toBe(1);
  });
});

describe("etapesAucunLot", () => {
  const etapes = etapesAucunLot();

  it("quatre etapes dans l'ordre du cycle, toutes NON_COMMENCEE : aucune n'est jamais terminee", () => {
    expect(etapes.map((x) => x.id)).toEqual([...ORDRE_ETAPES]);
    expect(etapes.map((x) => x.titre)).toEqual(ORDRE_ETAPES.map((id) => TITRES_ETAPES[id]));
    expect(etapes.every((x) => x.etat === "NON_COMMENCEE")).toBe(true);
  });

  it("la premiere dit que le formulaire est disponible ; les autres ne promettent rien", () => {
    expect(etapes[0].raison).toBe("Disponible : formulaire ci-dessous.");
    for (const x of etapes.slice(1)) expect(x.raison).not.toMatch(/disponible|terminée|importé/i);
  });
});

describe("resumeEtapes", () => {
  const e = (...etats: EtatEtape[]) => etats.map((etat) => ({ etat }));

  const table: [string, ReturnType<typeof e>, string][] = [
    ["lot valide, etapes 3 et 4 non disponibles", e("TERMINEE", "TERMINEE", "NON_DISPONIBLE", "NON_DISPONIBLE"), "Avancement du lot, 4 étapes : 2 terminées, 2 non disponibles."],
    ["lot rejete", e("TERMINEE", "ECHEC", "NON_DISPONIBLE", "NON_DISPONIBLE"), "Avancement du lot, 4 étapes : 1 terminée, 1 en échec, 2 non disponibles."],
    ["reserves", e("TERMINEE", "TERMINEE_AVEC_RESERVES", "NON_DISPONIBLE", "NON_DISPONIBLE"), "Avancement du lot, 4 étapes : 1 terminée, 1 terminée avec réserves, 2 non disponibles."],
    ["en cours", e("TERMINEE", "EN_COURS", "NON_COMMENCEE", "NON_COMMENCEE"), "Avancement du lot, 4 étapes : 1 terminée, 1 en cours, 2 non commencées."],
    ["une seule etape", e("NON_COMMENCEE"), "Avancement du lot, 1 étape : 1 non commencée."],
    ["liste vide", [], "Aucune étape à afficher."],
  ];

  it.each(table)("%s", (_nom, etapes, phrase) => {
    expect(resumeEtapes(etapes).phrase).toBe(phrase);
  });

  it("compte chaque etat, y compris un etat inattendu", () => {
    const r = resumeEtapes([{ etat: "TERMINEE" }, { etat: "BIZARRE" as EtatEtape }, { etat: "ECHEC" }]);
    expect(r).toMatchObject({ total: 3, terminees: 1, echecs: 1, inconnues: 1 });
    expect(r.phrase).toContain("1 dans un état inconnu");
  });

  it("aucun lot : phrase dediee, jamais « terminée »", () => {
    const r = resumeEtapes(etapesAucunLot(), { aucunLot: true });
    expect(r.phrase).toBe("Aucun lot sélectionné : les 4 étapes du cycle ne sont pas commencées.");
    expect(r.terminees).toBe(0);
  });

  it("null et undefined sont une liste vide", () => {
    expect(resumeEtapes(null).total).toBe(0);
    expect(resumeEtapes(undefined).phrase).toBe("Aucune étape à afficher.");
  });
});

describe("formaterTaille (depuis une chaine decimale, sans Number)", () => {
  const table: [string, string][] = [
    ["0", `0${NBSP}o`],
    ["1", `1${NBSP}o`],
    ["1023", `1023${NBSP}o`],
    ["1024", `1${NBSP}Ko`],
    ["1536", `1,5${NBSP}Ko`],
    ["2048", `2${NBSP}Ko`],
    ["10240", `10${NBSP}Ko`],
    ["1048575", `1023,9${NBSP}Ko`], // tronque : on ne gonfle pas a « 1024 Ko »
    ["1048576", `1${NBSP}Mo`],
    ["1572864", `1,5${NBSP}Mo`],
    ["52428800", `50${NBSP}Mo`], // plafond annonce par le serveur : 50 Mo
    ["1073741823", `1023,9${NBSP}Mo`],
    ["10737418240", `10${NBSP}Go`],
    ["10995116277760", `10${FINE}240${NBSP}Go`], // 10 To : groupe de trois, a partir de cinq chiffres
    ["1073741824", `1${NBSP}Go`],
    ["0042", `42${NBSP}o`],
    ["  2048  ", `2${NBSP}Ko`],
    // Au-dela de 2^53 : un Number() arrondirait ; la chaine reste exacte.
    ["9007199254740993", `8${FINE}388${FINE}608${NBSP}Go`],
    ["1125899906842624", `1${FINE}048${FINE}576${NBSP}Go`],
  ];

  it.each(table)("%s", (entree, attendu) => {
    expect(formaterTaille(entree)).toBe(attendu);
  });

  it.each([[""], ["   "], ["-1"], ["12.5"], ["1e3"], ["abc"], ["12 Ko"], ["0x10"], [null], [undefined], [1024], [{}], ["9".repeat(31)]])(
    "%j : « Taille inconnue », jamais « 0 o »",
    (entree) => {
      expect(formaterTaille(entree)).toBe(TAILLE_INCONNUE);
    },
  );
});

describe("formaterDate (UTC, deterministe)", () => {
  const table: [string, string, { heure?: boolean }?][] = [
    ["2026-10-25T14:05:00Z", `25 octobre 2026 à 14${NBSP}h${NBSP}05`],
    ["2026-10-25T14:05:00.123Z", `25 octobre 2026 à 14${NBSP}h${NBSP}05`],
    ["2026-10-25T00:00:00Z", `25 octobre 2026 à 0${NBSP}h${NBSP}00`],
    ["2026-10-25T23:59:59Z", `25 octobre 2026 à 23${NBSP}h${NBSP}59`],
    ["2026-11-01T08:30:00Z", `1er novembre 2026 à 8${NBSP}h${NBSP}30`],
    ["2026-11-01", "1er novembre 2026"],
    ["2026-02-28", "28 février 2026"],
    ["2028-02-29", "29 février 2028"],
    ["2026-08-05T10:00:00Z", `5 août 2026 à 10${NBSP}h${NBSP}00`],
    ["2026-12-31T22:00:00Z", `31 décembre 2026 à 22${NBSP}h${NBSP}00`],
    // Decalages : l'instant est ramene a UTC, la date suit (changement de jour compris).
    ["2026-10-25T14:05:00+02:00", `25 octobre 2026 à 12${NBSP}h${NBSP}05`],
    ["2026-10-25T23:30:00-02:00", `26 octobre 2026 à 1${NBSP}h${NBSP}30`],
    ["2026-10-31T23:30:00-01:00", `1er novembre 2026 à 0${NBSP}h${NBSP}30`],
    ["2026-12-31T23:30:00-01:00", `1er janvier 2027 à 0${NBSP}h${NBSP}30`],
    ["2026-10-25T14:05:00+0530", `25 octobre 2026 à 8${NBSP}h${NBSP}35`],
    // Sans decalage : lu en UTC, comme le serveur le serialise.
    ["2026-10-25T14:05:00", `25 octobre 2026 à 14${NBSP}h${NBSP}05`],
    ["2026-10-25 14:05", `25 octobre 2026 à 14${NBSP}h${NBSP}05`],
    // Sans l'heure.
    ["2026-10-25T23:30:00-02:00", "26 octobre 2026", { heure: false }],
    ["2026-10-25T14:05:00Z", "25 octobre 2026", { heure: false }],
  ];

  it.each(table)("%s", (entree, attendu, options) => {
    expect(formaterDate(entree, options)).toBe(attendu);
  });

  it("ne depend pas du fuseau de la machine", () => {
    const avant = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        expect(formaterDate("2026-10-25T14:05:00Z")).toBe(`25 octobre 2026 à 14${NBSP}h${NBSP}05`);
      }
    } finally {
      if (avant === undefined) delete process.env.TZ; else process.env.TZ = avant;
    }
  });

  it.each([[null], [undefined], [""], ["   "]])("%j : « Date inconnue »", (v) => {
    expect(formaterDate(v)).toBe(DATE_INCONNUE);
  });

  it.each([
    ["hier"], ["2026-13-01"], ["2026-00-10"], ["2026-02-30"], ["2026-02-29"], ["2026-04-31"], ["2026-10-32"], ["2026-10-00"],
    ["2026-10-25T24:00:00Z"], ["2026-10-25T14:60:00Z"], ["2026-10-25T14:05:60Z"], ["2026-10-25T14:05:00+25:00"], ["2026-10-25T14:05:00+02:75"],
    ["0099-10-25"], ["26-10-2026"], ["2026/10/25"], ["2026-10-25T14:05:00Zjunk"], ["<b>2026-10-25</b>"], [20261025], [{}], [true],
  ])("%j : « Date illisible », jamais une date inventee", (v) => {
    expect(formaterDate(v)).toBe(DATE_ILLISIBLE);
  });
});

describe("nettoyerTexte et abregerTexte", () => {
  it.each([
    ["  a   b  ", "a b"],
    ["a\tb\nc\r\nd", "a b c d"],
    ["a\u0000b\u0007c", "abc"],
    ["a​b﻿c­d", "abcd"],
    ["invoice‮gnp.csv", "invoicegnp.csv"],
    ["x⁦y⁩z", "xyz"],
    ["a b", "a b"],
    ["é à ç", "é à ç"],
  ])("%j -> %j", (entree, attendu) => {
    expect(nettoyerTexte(entree)).toBe(attendu);
  });

  it("une valeur qui n'est pas du texte donne une chaine vide", () => {
    expect(nettoyerTexte(null)).toBe("");
    expect(nettoyerTexte(12)).toBe("");
    expect(nettoyerTexte(undefined)).toBe("");
  });

  it("abregerTexte : court inchange, long coupe avec « … », jamais plus de `max` signes", () => {
    expect(abregerTexte("Délai dépassé", 200)).toBe("Délai dépassé");
    const long = "x".repeat(500);
    const r = abregerTexte(long, 200);
    expect(Array.from(r)).toHaveLength(200);
    expect(r.endsWith("…")).toBe(true);
    expect(abregerTexte(long, Number.NaN)).toHaveLength(200);
    expect(abregerTexte(null)).toBe("");
  });
});

describe("tronquerNomFichier", () => {
  const long = "rapport-inspection-des-ponts-region-de-kankan-et-faranah-2026";
  const table: [string, string, number | undefined, string][] = [
    ["nom court inchange", "releve.csv", undefined, "releve.csv"],
    ["pile a la limite", "a".repeat(36) + ".csv", 40, "a".repeat(36) + ".csv"],
    ["long avec extension conservee", `${long}.csv`, undefined, `${long.slice(0, 35)}….csv`],
    ["long geojson", `${long}.geojson`, 30, `${long.slice(0, 21)}….geojson`],
    ["limite personnalisee", "export-des-troncons-2026.csv", 20, "export-des-tron….csv"],
    ["sans extension", "a".repeat(60), 40, `${"a".repeat(39)}…`],
    ["fichier cache sans nom (.gitignore long)", ".".concat("b".repeat(60)), 20, `.${"b".repeat(18)}…`],
    ["extension trop longue : ignoree", `${"c".repeat(50)}.${"d".repeat(20)}`, 30, `${"c".repeat(29)}…`],
    ["plancher de max a 12", "abcdefghijklmnopqrstuvwxyz.csv", 3, "abcdefg….csv"],
    ["accents conserves", "résumé-des-opérations-du-trimestre-écoulé-2026.csv", 24, "résumé-des-opératio….csv"],
    ["signes de sens retires", "invoice‮gnp.csv", undefined, "invoicegnp.csv"],
    ["blancs ramenes a une espace", "  rapport \n  final .csv ", undefined, "rapport final .csv"],
  ];

  it.each(table)("%s", (_nom, entree, max, attendu) => {
    expect(tronquerNomFichier(entree, max)).toBe(attendu);
  });

  it("le resultat ne depasse jamais le plafond", () => {
    for (const max of [12, 13, 20, 40, 80]) {
      for (const nom of [`${long}.csv`, `${long}.geojson`, "z".repeat(200), `${"é".repeat(100)}.csv`, `${"😀".repeat(100)}.csv`]) {
        expect(Array.from(tronquerNomFichier(nom, max)).length).toBeLessThanOrEqual(max);
      }
    }
  });

  it("ne coupe pas un emoji en deux (aucun signe de remplacement ni demi-paire)", () => {
    const r = tronquerNomFichier(`${"😀".repeat(60)}.csv`, 20);
    // Chaque signe est une paire complete ou un signe BMP : aucune moitie d'emoji, aucun signe de remplacement.
    expect(Array.from(r).every((signe) => signe.length === 2 || !/[\uD800-\uDFFF�]/.test(signe))).toBe(true);
    expect(r.endsWith("….csv")).toBe(true);
  });

  it.each([[""], ["   "], [null], [undefined], [12], ["‮​"]])("%j : « Nom de fichier inconnu »", (v) => {
    expect(tronquerNomFichier(v)).toBe(NOM_FICHIER_INCONNU);
  });
});

describe("textes de gouvernance et de liste", () => {
  it("la phrase de gouvernance nomme les cinq etats et dit que deposer n'ecrit jamais", () => {
    expect(TITRE_GOUVERNANCE).toBe("Recevoir un lot n'est pas importer.");
    for (const mot of ["Reçu", "validé techniquement", "approuvé par le métier", "autorisé à écrire", "importé"]) expect(PHRASE_GOUVERNANCE).toContain(mot);
    expect(PHRASE_GOUVERNANCE).toMatch(/jamais à l'écriture dans le référentiel/);
    expect(PHRASE_GOUVERNANCE.split(/(?<=[.!?])\s/)).toHaveLength(1); // « en une phrase »
  });

  it("les regles de reception disent les cinq regles imposees et « non disponible » pour ce qui n'existe pas", () => {
    const tout = REGLES_RECEPTION.map((r) => r.texte).join("\n");
    expect(tout).toMatch(/n'écrit rien dans le référentiel/);
    expect(tout).toMatch(/empreinte.*calculée par le serveur/);
    expect(tout).toMatch(/même fichier reçu deux fois.*rien n'est écrit/);
    expect(tout).toMatch(/lot rejeté est un résultat/);
    expect(tout).toMatch(/L'application au référentiel.*non disponible/);
    expect(new Set(REGLES_RECEPTION.map((r) => r.id)).size).toBe(REGLES_RECEPTION.length);
  });

  it("aucune promesse : pas de format ni de plafond que le contrat n'annonce pas", () => {
    const tout = [PHRASE_GOUVERNANCE, ...REGLES_RECEPTION.map((r) => r.texte)].join("\n");
    expect(tout).not.toMatch(/xlsx|gpkg|geopackage|zip|1 ?Go/i);
  });

  it("messageErreurListe : 403 dit les droits, tout le reste dit « n'a pas pu etre chargee »", () => {
    expect(messageErreurListe(403)).toEqual({ message: MESSAGE_ERREUR_DROITS, aide: AIDE_ERREUR_DROITS, droits: true });
    for (const code of [401, 404, 500, 502, 503, 0, null, undefined]) {
      expect(messageErreurListe(code)).toEqual({ message: MESSAGE_ERREUR_LISTE, aide: AIDE_ERREUR_LISTE, droits: false });
    }
    expect(MESSAGE_ERREUR_LISTE).toBe("La liste des lots n'a pas pu être chargée.");
    expect(MESSAGE_ERREUR_DROITS).toBe("Votre profil ne permet pas de consulter les lots d'import.");
    expect(MESSAGE_AUCUN_LOT).toBe("Aucun lot reçu. Sélectionnez un fichier et renseignez les informations obligatoires pour commencer.");
  });

  it("tous les textes du noyau sont en francais sans emoji ni tiret cadratin", () => {
    const textes: string[] = [
      TITRE_GOUVERNANCE, PHRASE_GOUVERNANCE, MESSAGE_AUCUN_LOT, MESSAGE_ERREUR_LISTE, MESSAGE_ERREUR_DROITS, AIDE_ERREUR_LISTE, AIDE_ERREUR_DROITS,
      RAISON_MANQUANTE, ...REGLES_RECEPTION.map((r) => r.texte), ...etapesAucunLot().map((x) => `${x.titre} ${x.raison}`),
      ...STATUTS_LOT.flatMap((s) => [descripteurStatut(s).libelle, descripteurStatut(s).description]),
      ...ETATS_ETAPE.map((s) => descripteurEtat(s).libelle),
    ];
    for (const t of textes) {
      expect(t).not.toMatch(/[–—]/);
      expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("garde : le noyau reste pur", () => {
  const retirerCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const code = retirerCommentaires(readFileSync(join(__dirname, "imports.noyau.ts"), "utf8"));

  it("n'importe que des fichiers du dossier", () => {
    const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.filter((i) => !i.startsWith("./"))).toEqual([]);
  });

  it("n'utilise ni DOM, ni stockage, ni reseau, ni horloge globale, ni hasard", () => {
    const interdits = /\b(document|window|localStorage|sessionStorage|indexedDB|navigator|fetch|XMLHttpRequest|axios|setTimeout|setInterval|Math\.random|toLocale\w*)\b|Date\.now\(|new Date\(\)/;
    expect(code.match(interdits)).toBeNull();
  });

  it("ne convertit jamais une taille avec Number() (BigInt sur la chaine)", () => {
    const corps = code.slice(code.indexOf("export function formaterTaille"), code.indexOf("const MOIS"));
    expect(corps).not.toMatch(/\bNumber\(|parseInt|parseFloat|\bparseFloat/);
    expect(corps).toMatch(/BigInt\(/);
  });
});
