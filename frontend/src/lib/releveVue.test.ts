import { beforeEach, describe, expect, it } from "vitest";
import {
  dureeEffectiveMs, etatSessionVue, lireEnvoiConfirme, noterEnvoiConfirme, oublierEnvoi, PROFILS_PRECISION, profilParCode, qualiteTrace,
  segmentsPourCarte, sessionVide, stockageProche, vitesseKmH,
} from "./releveVue";
import { validerParametres, type EchantillonRetenu, type ResumeSession } from "../roulage";

/** Un resume minimal : ce que `qualiteTrace` lit, le reste a zero. */
function resume(surcharge: Partial<ResumeSession> = {}): ResumeSession {
  return {
    statut: "ARRETEE", echantillons: 100, rejetsTotal: 0, rejets: {} as ResumeSession["rejets"], trous: 0, dureeTrousMs: 0, interruptions: 0,
    pauses: 0, marqueurs: 0, evenementsOuverts: 0, evenementsClos: 0, evenementsAbandonnes: 0, segments: 1, distanceM: 1000, alertes: 0, echecsJournal: 0,
    ...surcharge,
  };
}

function ech(segment: number, lat: number, lon: number, tMs = 0): EchantillonRetenu {
  return { tMs, lat, lon, precisionM: 5, vitesseMs: null, capDeg: null, altitudeM: null, segment };
}

describe("profils de precision", () => {
  it("trois profils, tous acceptes par le noyau, le standard etant la valeur par defaut du noyau", () => {
    expect(PROFILS_PRECISION.map((p) => p.code)).toEqual(["standard", "strict", "tolerant"]);
    for (const p of PROFILS_PRECISION) expect(validerParametres(p.parametres).ok).toBe(true);
    expect(profilParCode("standard").parametres.precisionMaxM).toBe(50);
    expect(profilParCode("strict").parametres.precisionMaxM).toBeLessThan(50);
    expect(profilParCode("tolerant").parametres.precisionMaxM).toBeGreaterThan(50);
  });

  it("un code inconnu retombe sur le standard, jamais sur une valeur inventee", () => {
    expect(profilParCode("n-importe-quoi").code).toBe("standard");
  });
});

describe("session vide", () => {
  it("zero position retenue = vide ; une seule position ne l'est pas, mais sa trace est de faible qualite", () => {
    expect(sessionVide(resume({ echantillons: 0 }))).toBe(true);
    expect(sessionVide(resume({ echantillons: 1 }))).toBe(false);
    expect(qualiteTrace(resume({ echantillons: 1 }), 60_000).niveau).toBe("faible");
  });
});

describe("qualite de la trace", () => {
  it("vide : aucune trace, et le dit", () => {
    const q = qualiteTrace(resume({ echantillons: 0 }), 60_000);
    expect(q.niveau).toBe("vide");
    expect(q.raisons.join(" ")).toMatch(/Aucune position valide/);
  });

  it("bonne : peu d'ecarts, peu de trous", () => {
    const q = qualiteTrace(resume({ echantillons: 100, rejetsTotal: 2, dureeTrousMs: 1000 }), 600_000);
    expect(q.niveau).toBe("bonne");
  });

  it("moyenne au-dela de 20 % de positions ecartees ou de 10 % du temps en trou", () => {
    expect(qualiteTrace(resume({ echantillons: 70, rejetsTotal: 30 }), 600_000).niveau).toBe("moyenne");
    expect(qualiteTrace(resume({ echantillons: 100, dureeTrousMs: 80_000 }), 600_000).niveau).toBe("moyenne");
  });

  it("faible au-dela de 50 % de positions ecartees ou de 30 % du temps en trou, avec la raison en toutes lettres", () => {
    const a = qualiteTrace(resume({ echantillons: 40, rejetsTotal: 60 }), 600_000);
    expect(a.niveau).toBe("faible");
    expect(a.raisons.join(" ")).toMatch(/60 % des positions reçues ont été écartées/);
    const b = qualiteTrace(resume({ echantillons: 100, dureeTrousMs: 300_000, interruptions: 2 }), 600_000);
    expect(b.niveau).toBe("faible");
    expect(b.raisons.join(" ")).toMatch(/50 % du temps/);
    expect(b.raisons.join(" ")).toMatch(/2 interruption/);
  });
});

describe("duree effective", () => {
  it("duree totale moins pauses et trous, jamais negative", () => {
    expect(dureeEffectiveMs(600_000, { dureeTrousMs: 60_000 }, 120_000)).toBe(420_000);
    expect(dureeEffectiveMs(10_000, { dureeTrousMs: 60_000 }, 120_000)).toBe(0);
  });
});

describe("trace pour la carte", () => {
  it("deux segments restent deux lignes : un trou n'est jamais relie par une ligne droite", () => {
    const segs = segmentsPourCarte([ech(0, 9.6, -13.6), ech(0, 9.601, -13.6), ech(1, 9.7, -13.5), ech(1, 9.701, -13.5)]);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual([[9.6, -13.6], [9.601, -13.6]]);
    expect(segs[1]).toEqual([[9.7, -13.5], [9.701, -13.5]]);
  });

  it("aucune position : aucune ligne", () => {
    expect(segmentsPourCarte([])).toEqual([]);
  });
});

describe("etat d'une session pour l'agent", () => {
  const base = { vide: false, gpsInterrompu: false, envoi: "aucun" as const };
  it("couvre la preparation, l'enregistrement, la pause et l'interruption du GPS", () => {
    expect(etatSessionVue({ ...base, phase: "repos" })).toBe("preparation");
    expect(etatSessionVue({ ...base, phase: "en_cours" })).toBe("enregistrement");
    expect(etatSessionVue({ ...base, phase: "en_cours", gpsInterrompu: true })).toBe("interruption_gps");
    expect(etatSessionVue({ ...base, phase: "pause" })).toBe("suspendue");
  });

  it("une session terminee sans position n'est jamais « a envoyer » ni « envoyee »", () => {
    expect(etatSessionVue({ ...base, phase: "arretee", vide: true })).toBe("terminee_vide");
    expect(etatSessionVue({ ...base, phase: "arretee", vide: true, envoi: "envoye" })).toBe("terminee_vide");
  });

  it("terminee : a envoyer, envoi en cours, erreur d'envoi, envoyee et confirmee sont quatre etats distincts", () => {
    const etats = (["aucun", "en_cours", "echec", "envoye"] as const).map((envoi) => etatSessionVue({ ...base, phase: "arretee", envoi }));
    expect(etats).toEqual(["terminee_a_envoyer", "envoi", "erreur_envoi", "envoyee"]);
    expect(new Set(etats).size).toBe(4);
  });
});

describe("envoi confirme, retenu sur l'appareil", () => {
  beforeEach(() => localStorage.clear());

  it("rien n'est retenu avant la confirmation, puis la date de confirmation est lisible", () => {
    expect(lireEnvoiConfirme("s1")).toBeNull();
    noterEnvoiConfirme("s1", new Date("2026-10-24T08:00:00.000Z"));
    expect(lireEnvoiConfirme("s1")).toBe("2026-10-24T08:00:00.000Z");
    expect(lireEnvoiConfirme("s2")).toBeNull();
  });

  it("oublier une session efface sa confirmation", () => {
    noterEnvoiConfirme("s1");
    oublierEnvoi("s1");
    expect(lireEnvoiConfirme("s1")).toBeNull();
  });

  it("un stockage indisponible ne fait jamais echouer l'ecran", () => {
    const reel = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("quota"); };
    try { expect(() => noterEnvoiConfirme("s1")).not.toThrow(); } finally { Storage.prototype.setItem = reel; }
  });
});

describe("vitesse et stockage", () => {
  it("la vitesse est convertie en km/h ; absente, negative ou non finie : null, jamais inventee", () => {
    expect(vitesseKmH(10)).toBeCloseTo(36, 6);
    expect(vitesseKmH(0)).toBe(0);
    expect(vitesseKmH(null)).toBeNull();
    expect(vitesseKmH(undefined)).toBeNull();
    expect(vitesseKmH(-1)).toBeNull();
    expect(vitesseKmH(Number.NaN)).toBeNull();
  });

  it("le stockage est « proche du plein » a partir de 80 % du quota ; inconnu : pas d'alerte inventee", () => {
    expect(stockageProche(null)).toBe(false);
    expect(stockageProche({ usageMo: 10, quotaMo: 100, part: 0.1 })).toBe(false);
    expect(stockageProche({ usageMo: 80, quotaMo: 100, part: 0.8 })).toBe(true);
  });
});
