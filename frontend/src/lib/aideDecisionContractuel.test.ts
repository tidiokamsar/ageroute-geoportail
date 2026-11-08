import { describe, expect, it } from "vitest";
import {
  BANDEAU_PARTIEL, LIBELLES, classerErreur, estErreurAutorisation, formaterDate, formaterGnf, formaterMontantOrigine, formaterPourcent, libelleMotif,
  marchePresent, parametresContractuel, phraseRetard, texteMontant, type MontantVue,
} from "./aideDecisionContractuel";
import { marcheVue, montant } from "../components/decision/contractuel/synthetique.testutil";

const NNBSP = "\u202f";
const NBSP = "\u00a0";

describe("montants GNF : des chaines, sans perte de precision", () => {
  it("groupe les chiffres par trois sans passer par Number", () => {
    expect(formaterGnf("0")).toBe(`0${NBSP}GNF`);
    expect(formaterGnf("999")).toBe(`999${NBSP}GNF`);
    expect(formaterGnf("1000")).toBe(`1${NNBSP}000${NBSP}GNF`);
    expect(formaterGnf("1250000000")).toBe(`1${NNBSP}250${NNBSP}000${NNBSP}000${NBSP}GNF`);
    expect(formaterGnf("-1234567")).toBe(`-1${NNBSP}234${NNBSP}567${NBSP}GNF`);
  });

  it("garde les derniers chiffres au-dela de 2^53 (Number les aurait faussés)", () => {
    const grand = "9007199254740993"; // 2^53 + 1
    expect(formaterGnf(grand).replace(/[\u202f\u00a0]/g, "")).toBe(`${grand}GNF`);
    expect(String(Number(grand))).not.toBe(grand);
  });

  it("une valeur qui n'est pas un entier n'est pas inventée : rendue telle quelle", () => {
    expect(formaterGnf("12,5")).toBe("12,5");
    expect(formaterGnf("abc")).toBe("abc");
  });

  it("montant en devise étrangère : montant d'origine, jamais converti", () => {
    expect(formaterMontantOrigine({ montant: "2000", devise: "USD" })).toBe(`2${NNBSP}000${NBSP}USD`);
  });

  it("MUTATION DE CONTROLE : un montant sans valeur affiche « Non disponible », jamais 0", () => {
    const sans: MontantVue = montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "SOURCE_NON_VALIDEE" });
    expect(texteMontant(sans)).toBe("Non disponible");
    expect(texteMontant(sans)).not.toMatch(/0/);
    expect(texteMontant(montant({ valeurGnf: "0" }))).toBe(`0${NBSP}GNF`); // un zero reel envoye par le serveur reste un zero
  });

  it("chaque motif d'indisponibilité a une phrase", () => {
    for (const m of ["SOURCE_NON_VALIDEE", "DROIT_FINANCIER", "TERRITOIRE", "MONTANT_ABSENT", "DEVISE_NON_GNF", "AUCUN_DECOMPTE", "AUCUN_LIEN", "LIEN_AMBIGU", "AUCUN_MARCHE"] as const) {
      expect(libelleMotif(m)).not.toBe("non disponible");
    }
    expect(libelleMotif(null)).toBe("non disponible");
  });
});

describe("libelles stricts", () => {
  it("« recensés », « contractuel », « engagé », « décaissé », « prévisionnel » ; jamais « actifs »", () => {
    expect(LIBELLES.recenses).toBe("Marchés recensés");
    expect(LIBELLES.contractuel).toBe("Contractuel");
    expect(LIBELLES.engage).toBe("Engagé");
    expect(LIBELLES.decaisse).toBe("Décaissé");
    expect(LIBELLES.previsionnel).toBe("Prévisionnel");
    expect(Object.values(LIBELLES).join(" ")).not.toMatch(/actif/i);
    expect(LIBELLES.declare).not.toBe(LIBELLES.constate);
  });

  it("le bandeau de données partielles dit la source externe non intégrée", () => {
    expect(BANDEAU_PARTIEL).toBe("Données contractuelles partielles : source de vérité externe non intégrée (DigitalRoad)");
  });
});

describe("formats", () => {
  it("date : AAAA-MM-JJ en UTC, tiret quand absente ou illisible", () => {
    expect(formaterDate("2026-10-26")).toMatch(/26/);
    expect(formaterDate("2026-10-26")).toMatch(/2026/);
    expect(formaterDate(null)).toBe("—");
    expect(formaterDate("n'importe quoi")).toBe("—");
  });

  it("pourcentage : tiret pour une absence (jamais 0 %), virgule française", () => {
    expect(formaterPourcent(null)).toBe("—");
    expect(formaterPourcent(undefined)).toBe("—");
    expect(formaterPourcent(0)).toBe(`0${NBSP}%`);
    expect(formaterPourcent(12.34)).toBe(`12,3${NBSP}%`);
  });

  it("phrase de retard : dit le dénominateur, jamais « 0 » pour un retard non évaluable", () => {
    const base = { regle: "r", statutDefinition: "PROVISOIRE" as const };
    expect(phraseRetard({ ...base, enRetard: 1, aJour: 2, nonEvaluables: 3, termines: 4 })).toBe("1 en retard sur 3 évalués (3 non évaluables, 4 terminés non évalués)");
    expect(phraseRetard({ ...base, enRetard: 0, aJour: 0, nonEvaluables: 5, termines: 0 })).toBe("Aucun marché dont le retard soit évaluable");
  });
});

describe("parametres de requete", () => {
  it("n'envoie que ce qui est renseigné, les listes séparées par des virgules", () => {
    expect(parametresContractuel({})).toEqual({});
    expect(parametresContractuel({ regionId: 3, classe: ["RN", "RR"], etat: [], statutChantier: ["EN_COURS"], depuis: "2026-01-01", jusqua: "2026-12-31" }, { statutMarche: ["EN_COURS", "SOLDE"], limite: 25, curseur: "abc" })).toEqual({
      regionId: "3", classe: "RN,RR", statutChantier: "EN_COURS", depuis: "2026-01-01", jusqua: "2026-12-31", statutMarche: "EN_COURS,SOLDE", limite: "25", curseur: "abc",
    });
  });

  it("une région à 0 reste envoyée (le serveur la refusera) ; un curseur null ne l'est pas", () => {
    expect(parametresContractuel({ regionId: 0 }, { curseur: null })).toEqual({ regionId: "0" });
  });
});

describe("classement des erreurs", () => {
  const http = (status: number, data: object = {}) => ({ response: { status, data } });

  it("403 : permission (état distinct d'une panne), message dédié", () => {
    const e = classerErreur(http(403, { error: "Accès à ce module non autorisé pour votre compte" }));
    expect(e.genre).toBe("permission");
    expect(e.message).toMatch(/ne permettent pas/);
    expect(estErreurAutorisation(http(403))).toBe(true);
  });

  it("401 session ; 404 introuvable ; 400 entrée ; 429 limite ; 503 indisponible ; 500 serveur ; sans réponse réseau", () => {
    expect(classerErreur(http(401)).genre).toBe("session");
    expect(classerErreur(http(404)).genre).toBe("introuvable");
    expect(classerErreur(http(400, { code: "PARAMETRES_INVALIDES" }))).toMatchObject({ genre: "entree", code: "PARAMETRES_INVALIDES" });
    expect(classerErreur(http(429)).genre).toBe("limite");
    expect(classerErreur(http(503)).genre).toBe("indisponible");
    expect(classerErreur(http(500, { error: "boom" }))).toMatchObject({ genre: "serveur", message: "boom" });
    expect(classerErreur(new Error("network"))).toMatchObject({ genre: "reseau", status: null });
    expect(estErreurAutorisation(http(500))).toBe(false);
  });
});

describe("fiche ouverte", () => {
  it("un marché absent de la liste n'est pas « présent »", () => {
    expect(marchePresent([marcheVue()], null)).toBe(false);
    expect(marchePresent([marcheVue()], marcheVue().id)).toBe(true);
    expect(marchePresent([marcheVue()], "autre")).toBe(false);
  });
});
