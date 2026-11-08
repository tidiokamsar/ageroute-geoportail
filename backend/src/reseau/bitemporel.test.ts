import { describe, expect, it } from "vitest";
import {
  refusVersion, valideA, versionA, telQuEnregistreA, chevauchementsTemporels,
  clore, trousTemporels, MOTIFS_REFUS_VERSION,
  type VersionTemporelle,
} from "./bitemporel";

/**
 * Historisation bitemporelle : ce que ces tests defendent.
 *
 * DEUX AXES DE TEMPS, ET LA CONFUSION QU'ILS EVITENT
 *
 * Le paragraphe 7.2 du mandat v2.1 exige « `valide_du` / `valide_au` (date d'effet terrain) +
 * `enregistre_le` (date systeme) ». Ce ne sont pas deux manieres de dire la meme chose.
 *
 * Une route est reprise le 15 mars. Un agent le releve le 2 avril. Le modele doit savoir
 * repondre a DEUX questions differentes :
 *
 *   « Quel etait l'etat au 20 mars ? »          -> axe TERRAIN, reponse : repris
 *   « Que savait-on le 25 mars de l'etat ? »    -> axe SYSTEME, reponse : pas encore repris
 *
 * La seconde question n'est pas academique : c'est celle que pose un bailleur qui demande sur
 * quelles donnees une programmation a ete decidee. Sans elle, un programme arrete en mars
 * paraitrait avoir ignore une information qui n'existait pas encore.
 *
 * CE QUE LE MODELE PORTAIT DEJA, ET CE QUI MANQUAIT
 *
 * `portions` porte `observeeLe` (date de constat), `createdAt` (date systeme) et `remplaceeLe`
 * (cloture systeme). Il manquait une date d'effet de FIN : `remplaceeLe` dit quand on a
 * ENREGISTRE le remplacement, pas quand la realite a change. Au 2 avril, la base ne pouvait
 * pas dire que l'ancienne portion avait cesse d'etre vraie le 15 mars.
 *
 * L'INTERVALLE EST SEMI-OUVERT, ET C'EST LE CŒUR
 *
 * `[valideDu, valideAu)`. Si l'intervalle etait ferme des deux cotes, deux versions
 * successives seraient toutes deux valides a l'instant de la bascule, et toute requete a cette
 * date rendrait deux reponses. La convention semi-ouverte supprime cette classe entiere
 * d'ambiguites, et elle est testee frontiere par frontiere ci-dessous.
 */

const J = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function v(p: Partial<VersionTemporelle> & { id: string }): VersionTemporelle {
  return {
    valideDu: J("2026-01-01"), valideAu: null,
    enregistreLe: J("2026-01-01"), remplaceeLe: null, deletedAt: null,
    ...p,
  };
}

describe("Ce qui n'est pas une version datable est refuse", () => {
  it("accepte une version ouverte, sans date de fin", () => {
    expect(refusVersion(v({ id: "a", valideDu: J("2026-03-15"), valideAu: null }))).toBeNull();
  });

  it("refuse une fin anterieure au debut", () => {
    const r = refusVersion(v({ id: "a", valideDu: J("2026-03-15"), valideAu: J("2026-03-01") }));
    expect(r).toBe("FIN_AVANT_DEBUT");
  });

  it("refuse un intervalle de duree nulle, qui ne vaut a aucune date", () => {
    // Avec un intervalle semi-ouvert, [15/03, 15/03) est VIDE : la version ne serait vraie
    // a aucun instant, ce qui est une faute de saisie et non une version instantanee.
    expect(refusVersion(v({ id: "a", valideDu: J("2026-03-15"), valideAu: J("2026-03-15") })))
      .toBe("INTERVALLE_VIDE");
  });

  it("refuse une version sans date de debut d'effet", () => {
    // Une version non datee ne peut etre placee sur aucun des deux axes. L'accepter
    // obligerait chaque requete temporelle a deviner, et deviner une date est pire que
    // refuser : le resultat aurait l'air d'une reponse.
    expect(refusVersion(v({ id: "a", valideDu: null }))).toBe("SANS_DATE_EFFET");
  });

  it("refuse une date non analysable", () => {
    expect(refusVersion(v({ id: "a", valideDu: new Date("pas une date") }))).toBe("DATE_INVALIDE");
  });

  it("chaque motif de refus a une explication lisible", () => {
    for (const motif of Object.keys(MOTIFS_REFUS_VERSION)) {
      const phrase = MOTIFS_REFUS_VERSION[motif as keyof typeof MOTIFS_REFUS_VERSION];
      expect(phrase.length, motif).toBeGreaterThan(25);
      expect(phrase, motif).not.toMatch(/_|undefined|null/);
    }
  });
});

describe("L'axe TERRAIN : quel etait l'etat a telle date", () => {
  const repris = v({ id: "v2", valideDu: J("2026-03-15"), valideAu: null });

  it("est valide a sa date de debut", () => {
    expect(valideA(repris, J("2026-03-15"))).toBe(true);
  });

  it("n'est pas valide la veille", () => {
    expect(valideA(repris, J("2026-03-14"))).toBe(false);
  });

  it("reste valide indefiniment sans date de fin", () => {
    expect(valideA(repris, J("2030-01-01"))).toBe(true);
  });

  it("EXCLUT sa date de fin : l'intervalle est semi-ouvert", () => {
    const ancien = v({ id: "v1", valideDu: J("2026-01-01"), valideAu: J("2026-03-15") });
    expect(valideA(ancien, J("2026-03-14"))).toBe(true);
    // Le 15 mars appartient a la version SUIVANTE, pas a celle qui s'y termine.
    expect(valideA(ancien, J("2026-03-15"))).toBe(false);
  });

  it("une version refusee n'est valide a aucune date", () => {
    const cassee = v({ id: "x", valideDu: J("2026-03-15"), valideAu: J("2026-03-01") });
    expect(valideA(cassee, J("2026-03-10"))).toBe(false);
  });
});

describe("Choisir la version valide a une date", () => {
  const v1 = v({ id: "v1", valideDu: J("2026-01-01"), valideAu: J("2026-03-15") });
  const v2 = v({ id: "v2", valideDu: J("2026-03-15"), valideAu: null });

  it("rend la bonne de part et d'autre de la bascule", () => {
    expect(versionA([v1, v2], J("2026-02-01"))?.id).toBe("v1");
    expect(versionA([v1, v2], J("2026-03-15"))?.id).toBe("v2");
    expect(versionA([v1, v2], J("2026-12-31"))?.id).toBe("v2");
  });

  it("rend null avant toute version, sans inventer la plus proche", () => {
    expect(versionA([v1, v2], J("2025-06-01"))).toBeNull();
  });

  it("ignore les versions supprimees logiquement", () => {
    const sup = v({ id: "s", valideDu: J("2026-01-01"), deletedAt: J("2026-02-01") });
    expect(versionA([sup], J("2026-06-01"))).toBeNull();
  });

  it("ignore les versions refusees plutot que de les retenir par defaut", () => {
    const cassee = v({ id: "x", valideDu: J("2026-01-01"), valideAu: J("2025-01-01") });
    expect(versionA([cassee, v2], J("2026-06-01"))?.id).toBe("v2");
  });

  it("devant deux versions valides a la meme date, rend la PLUS RECEMMENT ENREGISTREE", () => {
    // Un chevauchement temporel est une anomalie, signalee par chevauchementsTemporels().
    // Mais une requete doit rendre UNE reponse : la derniere connaissance enregistree est le
    // choix le moins arbitraire, et il est deterministe.
    const a = v({ id: "a", valideDu: J("2026-01-01"), enregistreLe: J("2026-01-02") });
    const b = v({ id: "b", valideDu: J("2026-01-01"), enregistreLe: J("2026-05-10") });
    expect(versionA([a, b], J("2026-06-01"))?.id).toBe("b");
  });
});

describe("L'axe SYSTEME : que savait-on a telle date", () => {
  // La reprise a eu lieu le 15/03 mais n'a ete enregistree que le 02/04.
  const ancien = v({
    id: "v1", valideDu: J("2026-01-01"), valideAu: J("2026-03-15"),
    enregistreLe: J("2026-01-01"), remplaceeLe: J("2026-04-02"),
  });
  const nouveau = v({
    id: "v2", valideDu: J("2026-03-15"), valideAu: null,
    enregistreLe: J("2026-04-02"),
  });
  const versions = [ancien, nouveau];

  it("au 25 mars, on ne savait pas encore que la route avait ete reprise", () => {
    const connues = telQuEnregistreA(versions, J("2026-03-25"));
    expect(connues.map((x) => x.id)).toEqual(["v1"]);
    // Et a cette connaissance, l'ancienne version paraissait encore ouverte.
    expect(connues[0].valideAu).toBeNull();
  });

  it("au 10 avril, on le savait", () => {
    const connues = telQuEnregistreA(versions, J("2026-04-10"));
    expect(connues.map((x) => x.id).sort()).toEqual(["v1", "v2"]);
  });

  it("repond donc differemment aux deux questions pour la MEME date de terrain", () => {
    const dateTerrain = J("2026-03-20");

    // Ce qu'on sait aujourd'hui de l'etat au 20 mars : repris.
    expect(versionA(versions, dateTerrain)?.id).toBe("v2");

    // Ce qu'on en savait le 25 mars : pas encore repris.
    const vu25 = versionA(telQuEnregistreA(versions, J("2026-03-25")), dateTerrain);
    expect(vu25?.id).toBe("v1");
  });

  it("une version enregistree plus tard n'existe pas pour une date systeme anterieure", () => {
    expect(telQuEnregistreA(versions, J("2025-12-31"))).toEqual([]);
  });
});

describe("Clore une version a une date d'effet, et non a « maintenant »", () => {
  const ouverte = v({ id: "v1", valideDu: J("2026-01-01") });

  it("pose la date d'effet, pas la date du jour", () => {
    const close = clore(ouverte, J("2026-03-15"));
    expect(close.valideAu).toEqual(J("2026-03-15"));
  });

  it("REFUSE une date d'effet anterieure au debut de validite", () => {
    // Clore au 2025 une version valide depuis 2026 produirait un intervalle vide, donc une
    // version vraie a aucune date : la perte serait silencieuse.
    expect(() => clore(ouverte, J("2025-06-01"))).toThrow(/FIN_AVANT_DEBUT/);
  });

  it("REFUSE de clore a sa propre date de debut", () => {
    expect(() => clore(ouverte, J("2026-01-01"))).toThrow(/INTERVALLE_VIDE/);
  });

  it("ne modifie pas la version d'origine", () => {
    clore(ouverte, J("2026-03-15"));
    expect(ouverte.valideAu).toBeNull();
  });
});

describe("Les chevauchements temporels sont signales, jamais corriges", () => {
  it("ne signale rien pour deux versions successives jointives", () => {
    const a = v({ id: "a", valideDu: J("2026-01-01"), valideAu: J("2026-03-15") });
    const b = v({ id: "b", valideDu: J("2026-03-15"), valideAu: null });
    expect(chevauchementsTemporels([a, b])).toEqual([]);
  });

  it("signale deux versions qui se recouvrent, avec la periode commune", () => {
    const a = v({ id: "a", valideDu: J("2026-01-01"), valideAu: J("2026-04-01") });
    const b = v({ id: "b", valideDu: J("2026-03-01"), valideAu: null });
    const ch = chevauchementsTemporels([a, b]);
    expect(ch).toHaveLength(1);
    expect(ch[0].a).toBe("a");
    expect(ch[0].b).toBe("b");
    expect(ch[0].duM).toEqual(J("2026-03-01"));
    expect(ch[0].auM).toEqual(J("2026-04-01"));
  });

  it("signale deux versions ouvertes simultanement", () => {
    const a = v({ id: "a", valideDu: J("2026-01-01"), valideAu: null });
    const b = v({ id: "b", valideDu: J("2026-06-01"), valideAu: null });
    const ch = chevauchementsTemporels([a, b]);
    expect(ch).toHaveLength(1);
    expect(ch[0].auM).toBeNull();
  });

  it("n'invente pas de chevauchement entre une version supprimee et une autre", () => {
    const a = v({ id: "a", valideDu: J("2026-01-01"), valideAu: null, deletedAt: J("2026-02-01") });
    const b = v({ id: "b", valideDu: J("2026-01-01"), valideAu: null });
    expect(chevauchementsTemporels([a, b])).toEqual([]);
  });
});

describe("Les trous dans l'histoire sont nommes par leurs dates", () => {
  it("ne signale rien pour une histoire continue", () => {
    const a = v({ id: "a", valideDu: J("2026-01-01"), valideAu: J("2026-03-15") });
    const b = v({ id: "b", valideDu: J("2026-03-15"), valideAu: null });
    expect(trousTemporels([a, b])).toEqual([]);
  });

  it("nomme la periode ou l'on ne sait rien, au lieu d'un pourcentage", () => {
    // Meme raison que les trous de couverture spatiale : « 80 % d'historique » n'envoie
    // personne nulle part, « rien entre le 15/03 et le 01/06 » dit ou chercher.
    const a = v({ id: "a", valideDu: J("2026-01-01"), valideAu: J("2026-03-15") });
    const b = v({ id: "b", valideDu: J("2026-06-01"), valideAu: null });
    const t = trousTemporels([a, b]);
    expect(t).toEqual([{ duM: J("2026-03-15"), auM: J("2026-06-01") }]);
  });

  it("ne signale aucun trou pour une seule version", () => {
    expect(trousTemporels([v({ id: "a" })])).toEqual([]);
  });

  it("ne signale aucun trou pour une liste vide, plutot qu'un trou infini", () => {
    // Un troncon sans aucune version n'a pas un trou de l'origine des temps : il n'a pas
    // d'histoire, ce qui est different et se dit ailleurs.
    expect(trousTemporels([])).toEqual([]);
  });
});
