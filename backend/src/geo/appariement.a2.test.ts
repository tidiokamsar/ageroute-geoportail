import { describe, expect, it } from "vitest";
import { decider, scorer } from "./appariement.noyau";
import { JEU_ANNOTE, CAS_RATTACHABLES, CAS_ABSTENTION } from "./appariement.jeu-annote";

/**
 * Mesure du critere A2 du mandat v2.1.
 *
 * « Sur un jeu de test de points annotes (incluant routes parallelles et carrefours) :
 *   >= 95 % de bon candidat en tete quand la confiance est haute ; 0 rattachement
 *   automatique sous le seuil. »
 *
 * CE QUI EST MESURE, ET CE QUI NE L'EST PAS
 *
 * Les distances et orientations du jeu sont DONNEES, non calculees : la geometrie est le
 * travail de PostGIS. Ce fichier mesure la DECISION, qui est ce que le critere A2 nomme.
 * Voir l'en-tete de `appariement.jeu-annote.ts`.
 *
 * LE SECOND VOLET EST PLUS IMPORTANT QUE LE PREMIER
 *
 * « 0 rattachement automatique sous le seuil » est une garantie de surete : un faux
 * rattachement presente comme certain est pire qu'une abstention, parce qu'il entre dans le
 * referentiel sans que personne ne le revoie. Un seul manquement fait echouer ce test, la ou
 * le premier volet tolere 5 % d'erreur.
 */

describe("Critere A2 — le jeu annote couvre ce que le paragraphe 7.3.5 exige", () => {
  it("couvre les cinq situations nommees par le mandat", () => {
    const situations = new Set(JEU_ANNOTE.map((c) => c.situation));
    for (const exigee of [
      "PARALLELES_PROCHES", "CARREFOUR", "CHAUSSEES_SEPAREES",
      "PRECISION_DEGRADEE", "HORS_REFERENTIEL",
    ] as const) {
      expect(situations.has(exigee), `situation absente du jeu : ${exigee}`).toBe(true);
    }
  });

  it("comporte assez de cas pour qu'un pourcentage veuille dire quelque chose", () => {
    // Avec moins de 20 cas, « 95 % » ne distingue pas 0 erreur de 1.
    expect(JEU_ANNOTE.length).toBeGreaterThanOrEqual(20);
    expect(CAS_RATTACHABLES.length).toBeGreaterThanOrEqual(8);
    expect(CAS_ABSTENTION.length).toBeGreaterThanOrEqual(8);
  });

  it("chaque cas dit pourquoi il existe", () => {
    for (const c of JEU_ANNOTE) {
      expect(c.motif.length, c.nom).toBeGreaterThan(40);
    }
  });
});

describe("Critere A2, premier volet — le bon candidat en tete quand la confiance est haute", () => {
  it("atteint au moins 95 % sur les cas preselectionnes", () => {
    const preselections = JEU_ANNOTE
      .map((cas) => ({ cas, d: decider(cas.candidats, cas.contexte) }))
      .filter((x) => x.d.issue === "PRESELECTION");

    expect(preselections.length, "aucune preselection : le jeu ou le moteur est en cause")
      .toBeGreaterThan(0);

    const justes = preselections.filter((x) =>
      x.d.issue === "PRESELECTION" && x.d.appariement.tronconId === x.cas.attendu);

    const fautes = preselections
      .filter((x) => x.d.issue === "PRESELECTION" && x.d.appariement.tronconId !== x.cas.attendu)
      .map((x) => `${x.cas.nom} (attendu ${x.cas.attendu}, obtenu ${
        x.d.issue === "PRESELECTION" ? x.d.appariement.tronconId : "?"})`);

    const taux = justes.length / preselections.length;
    expect(taux, `fautes : ${fautes.join(" ; ")}`).toBeGreaterThanOrEqual(0.95);
  });

  it("classe le bon troncon en tete sur tous les cas rattachables, preselectionnes ou non", () => {
    // Plus exigeant que A2 : meme quand le moteur demande confirmation, le bon troncon doit
    // etre propose EN PREMIER, sinon l'agent doit chercher dans la liste.
    const fautes: string[] = [];
    for (const cas of CAS_RATTACHABLES) {
      const classe = scorer(cas.candidats, cas.contexte);
      if (classe.length === 0) continue;
      if (classe[0].candidat.tronconId !== cas.attendu) {
        fautes.push(`${cas.nom} : attendu ${cas.attendu}, obtenu ${classe[0].candidat.tronconId}`);
      }
    }
    expect(fautes).toEqual([]);
  });

  it("classe le bon troncon en tete meme dans les cas ou il faut s'abstenir", () => {
    // L'abstention porte sur l'AUTOMATISME, pas sur le classement. Un agent a qui l'on
    // demande de trancher doit voir le bon candidat en premier : c'est ce qui rend la
    // confirmation possible en un geste plutot qu'une recherche.
    const fautes: string[] = [];
    for (const cas of CAS_ABSTENTION) {
      if (cas.attendu === null || cas.candidats.length === 0) continue;
      const classe = scorer(cas.candidats, cas.contexte);
      if (classe[0].candidat.tronconId !== cas.attendu) {
        fautes.push(`${cas.nom} : attendu ${cas.attendu}, obtenu ${classe[0].candidat.tronconId}`);
      }
    }
    expect(fautes).toEqual([]);
  });
});

describe("Critere A2, second volet — zero rattachement automatique sous le seuil", () => {
  it("ne preselectionne AUCUN cas ou l'abstention est la bonne reponse", () => {
    const fautes = CAS_ABSTENTION
      .map((cas) => ({ cas, d: decider(cas.candidats, cas.contexte) }))
      .filter((x) => x.d.issue === "PRESELECTION")
      .map((x) => `${x.cas.nom} — ${x.cas.motif}`);

    // Zero tolerance : un faux rattachement presente comme certain entre dans le
    // referentiel sans revue. C'est la garantie de surete du mandat.
    expect(fautes).toEqual([]);
  });

  it("ne rattache jamais rien quand aucun troncon n'est sous le point", () => {
    const sansVerite = JEU_ANNOTE.filter((c) => c.attendu === null);
    expect(sansVerite.length).toBeGreaterThan(0);
    for (const cas of sansVerite) {
      const d = decider(cas.candidats, cas.contexte);
      expect(d.issue, cas.nom).toBe("NON_RATTACHE");
    }
  });

  it("nomme toujours une cause de refus, et jamais une cause fausse", () => {
    const d = decider(
      JEU_ANNOTE.find((c) => c.nom.startsWith("Canyon urbain"))!.candidats,
      JEU_ANNOTE.find((c) => c.nom.startsWith("Canyon urbain"))!.contexte,
    );
    if (d.issue !== "NON_RATTACHE") throw new Error("issue inattendue");
    // Un trace passe a 3 m : dire « trop loin » serait un diagnostic FAUX, et enverrait
    // l'agent corriger ce qui n'est pas en faute. La cause est la precision.
    expect(d.motif).toBe("PRECISION_INSUFFISANTE");
  });

  it("conserve les candidats examines meme en refusant", () => {
    // Paragraphe 7.3.6 : conserver « le score, le candidat retenu, l'auteur du choix ». Un
    // refus muet empecherait un rattachement ulterieur au bureau.
    for (const cas of CAS_ABSTENTION) {
      const d = decider(cas.candidats, cas.contexte);
      if (d.issue === "NON_RATTACHE") {
        expect(d.candidats.length, cas.nom).toBe(cas.candidats.length);
      }
    }
  });
});

describe("Ce que le jeu annote rend mesurable, et qui ne l'etait pas", () => {
  it("rend un bilan lisible par situation", () => {
    const parSituation = new Map<string, { total: number; preselection: number; justes: number }>();
    for (const cas of JEU_ANNOTE) {
      const d = decider(cas.candidats, cas.contexte);
      const s = parSituation.get(cas.situation) ?? { total: 0, preselection: 0, justes: 0 };
      s.total++;
      if (d.issue === "PRESELECTION") {
        s.preselection++;
        if (d.appariement.tronconId === cas.attendu) s.justes++;
      }
      parSituation.set(cas.situation, s);
    }

    // Les cinq situations sont representees, et aucune ne preselectionne a faux.
    for (const [situation, s] of parSituation) {
      expect(s.total, situation).toBeGreaterThan(0);
      expect(s.justes, `${situation} : ${s.preselection - s.justes} preselection(s) fausse(s)`)
        .toBe(s.preselection);
    }
  });
});
