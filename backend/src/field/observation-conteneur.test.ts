import { describe, expect, it } from "vitest";
import {
  typeObservationPourFamille, cleObservationConteneur, donneesObservationConteneur,
  type ReleveDefaut,
} from "./observation-conteneur";

/**
 * L'observation conteneur : ce que ces tests defendent.
 *
 * POURQUOI ELLE EXISTE
 *
 * `defauts.observationId` est NOT NULL depuis le 13/10/2026 : le paragraphe 7.1 du cahier
 * le marque « Oui », et c'est par l'observation qu'un defaut remonte jusqu'a la photo, au
 * point GPS et a l'agent.
 *
 * Or le frontend n'envoyait JAMAIS `observationId` — zero occurrence dans tout
 * `frontend/src`. La contrainte seule aurait casse la saisie terrain a la premiere photo,
 * sur une interface deja livree.
 *
 * LA LIGNE A NE PAS FRANCHIR
 *
 * Le serveur MATERIALISE le conteneur depuis le releve que l'agent vient d'envoyer. Il ne
 * le DEDUIT pas. Chaque champ vient de la soumission ; aucun n'est devine. Ces tests
 * defendent cette frontiere, parce que c'est exactement la qu'un raccourci futur
 * transformerait une materialisation honnete en fabrication de constat.
 */

const r = (p: Partial<ReleveDefaut> = {}): ReleveDefaut => ({
  famille: "CHAUSSEE",
  agentId: "agent-1",
  observeA: new Date("2026-10-13T08:30:00.000Z"),
  libelleCatalogue: "Nid-de-poule",
  ...p,
});

describe("La cle d'idempotence DERIVE de celle du defaut", () => {
  it("derive quand le defaut porte une cle", () => {
    // Un rejeu de la meme operation rencontre alors la MEME collision d'unicite sur les
    // deux lignes. Tirer une cle au hasard produirait une observation de plus a chaque
    // tentative : le doublon silencieux que le protocole de synchronisation existe pour
    // empecher.
    expect(cleObservationConteneur("op-42", () => "tire-au-sort")).toBe("op-42-observation");
  });

  it("est stable : deux appels sur la meme cle donnent le meme resultat", () => {
    const a = cleObservationConteneur("op-42", () => "x");
    const b = cleObservationConteneur("op-42", () => "y");
    expect(a).toBe(b);
  });

  it("tire au sort quand le defaut n'a pas de cle", () => {
    // Saisie directe au bureau, hors file : il n'y a rien a rejouer.
    for (const sans of [null, undefined, ""]) {
      expect(cleObservationConteneur(sans, () => "tire-au-sort")).toBe("tire-au-sort");
    }
  });
});

describe("Le type d'observation vient de la famille du catalogue", () => {
  it("reprend la famille quand les deux vocabulaires concordent", () => {
    for (const [famille, attendu] of [
      ["CHAUSSEE", "CHAUSSEE"], ["ASSAINISSEMENT", "ASSAINISSEMENT"],
      ["OUVRAGE", "OUVRAGE"], ["SIGNALISATION", "SIGNALISATION"],
      ["SECURITE", "SECURITE"], ["ENVIRONNEMENT", "ENVIRONNEMENT"],
    ] as const) {
      expect(typeObservationPourFamille(famille), famille).toBe(attendu);
    }
  });

  it("replie ACCOTEMENT sur DEGRADATION, faute d'equivalent", () => {
    // Les deux vocabulaires ont ete definis separement et ne se recouvrent pas tout a
    // fait. DEGRADATION est vrai sans etre precis, et surtout il ne PRETEND rien :
    // inventer un type plus flatteur ferait croire a une categorisation qui n'existe pas.
    expect(typeObservationPourFamille("ACCOTEMENT")).toBe("DEGRADATION");
  });

  it("replie une famille inconnue plutot que de rendre undefined", () => {
    // Une famille ajoutee au schema sans etre cartographiee ici ne doit pas produire un
    // `type: undefined` que Prisma refuserait au moment de l'insertion, en pleine
    // synchronisation de terrain.
    expect(typeObservationPourFamille("FAMILLE_FUTURE" as never)).toBe("DEGRADATION");
  });
});

describe("Aucun champ n'est devine : tout vient du releve", () => {
  it("reprend l'agent, la position, la precision et l'horodatage", () => {
    const d = donneesObservationConteneur(r({
      agentId: "agent-7", lat: 9.52, lon: -13.71, precisionM: 6,
      confianceAppariement: 0.92, pk: 188.42,
      observeA: new Date("2026-10-13T08:30:00.000Z"),
    }), () => "cle");

    expect(d).toMatchObject({
      agentId: "agent-7", lat: 9.52, lon: -13.71, precisionM: 6,
      confianceAppariement: 0.92, pk: 188.42,
    });
    expect((d.observeA as Date).toISOString()).toBe("2026-10-13T08:30:00.000Z");
  });

  it("reprend la mission et le troncon quand ils existent, null sinon", () => {
    expect(donneesObservationConteneur(r({ missionId: "m1", tronconId: "t1" }), () => "c"))
      .toMatchObject({ missionId: "m1", tronconId: "t1" });
    expect(donneesObservationConteneur(r(), () => "c"))
      .toMatchObject({ missionId: null, tronconId: null });
  });

  it("DIT que la ligne a ete ecrite avec le defaut", () => {
    // Sans cette mention, personne ne saurait dans six mois que cette observation a ete
    // ecrite par le serveur et non saisie par un agent sur le terrain.
    const d = donneesObservationConteneur(r({ libelleCatalogue: "Orniérage" }), () => "c");
    expect(d.description).toContain("Orniérage");
    expect(String(d.description)).toMatch(/conteneur/i);
  });

  it("N'INVENTE NI POSITION NI CONFIANCE quand le releve n'en a pas", () => {
    // Le cas le plus important. Un conteneur qui se verrait attribuer une position
    // plausible mentirait sur l'endroit du constat, et cette position remonterait ensuite
    // comme celle de l'observation d'origine.
    const d = donneesObservationConteneur(r(), () => "c");
    expect(d.lat).toBeNull();
    expect(d.lon).toBeNull();
    expect(d.precisionM).toBeNull();
    expect(d.confianceAppariement).toBeNull();
    expect(d.pk).toBeNull();
  });

  it("ne pose aucun statut : le defaut de colonne porte la regle", () => {
    // L'observation est une PROPOSITION, comme le defaut qu'elle porte, et c'est le meme
    // tiers habilite qui tranchera. Poser le statut ici permettrait a ce chemin de
    // contourner la porte de validation.
    const d = donneesObservationConteneur(r(), () => "c") as Record<string, unknown>;
    expect(d.statut).toBeUndefined();
    expect(d.valideeA).toBeUndefined();
    expect(d.validateurId).toBeUndefined();
  });
});
