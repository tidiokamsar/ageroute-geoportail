import { describe, expect, it } from "vitest";
import {
  aDesPortionsNonListees, classerErreur, compter, etatTrace, etiquetteMarqueur, fusionnerAgents, libelleDateHeure, libelleDistance, libelleDureeReleve,
  libelleHeure, libelleMotifEvenement, libelleMotifMarqueur, libelleProvenance, libelleQualification, libellePortion, libelleRattachementMarqueur,
  libelleResultatEvenement, libelleSens, libelleSourcePosition, libelleStatutMarqueur, libelleStatutRattachement, libelleTaux, libelleTotal, libelleTroncon,
  lignesResume, lignesSeuils, lignesTrace, lireAnalyseServeur, lireCompte, messageErreur, nomLienReleve, noteMarqueur, noteSurPositions,
  noteTronconsManquants, peutReessayer, periodeVersParametres, positionApproximative, positionsEcartees, repartirMarqueurs, tronconsRattaches, voitPlusieursAgents,
} from "./roulageEnvoyesVue";
import { lireDetailReleve, type DetailReleveEnvoye, type EvenementReleve, type MarqueurReleve } from "./roulageEnvoyes";
import { CORPS_404_REEL, DETAIL_REEL_ECR1, DETAIL_REEL_ECR2, DETAIL_REEL_ECR3 } from "./roulageEnvoyes.reel.fixture";

/**
 * Le noyau d'affichage des releves envoyes : ce que ces tests defendent.
 *   - une valeur ABSENTE reste absente (taux `null` = « non evalue », jamais « 0 % » ; distance `null` = « non calculee ») ;
 *   - un code de statut ou de motif inconnu est rendu tel quel, jamais traduit au hasard ;
 *   - une erreur est classee par son STATUT HTTP, et un refus de droit n'est pas presente comme une panne ;
 *   - les liens vers un releve ont chacun un nom distinct (date a la seconde) ;
 *   - sur les REPONSES REELLES du serveur (roulageEnvoyes.reel.fixture.ts) : le compte de troncons detailles egale celui du serveur,
 *     les avertissements sont repris tels quels, et un repere place sur la trace n'est pas dit « perime » a tort.
 * Les dates sont toutes donnees en UTC et lues en UTC : le resultat ne depend pas du fuseau de la machine.
 */

const UTC = { fuseau: "UTC" };
const reel = (d: unknown): DetailReleveEnvoye => lireDetailReleve(structuredClone(d));

describe("dates", () => {
  it("ecrit le jour et l'heure, avec ou sans secondes", () => {
    expect(libelleDateHeure("2026-10-26T12:30:15Z", UTC)).toBe("26/10/2026 à 12:30");
    expect(libelleDateHeure("2026-10-26T12:30:15Z", { ...UTC, secondes: true })).toBe("26/10/2026 à 12:30:15");
    expect(libelleHeure("2026-10-26T07:05:09Z", UTC)).toBe("07:05:09");
  });
  it("dit qu'une date est illisible plutot que de l'inventer", () => {
    expect(libelleDateHeure("pas une date")).toBe("date inconnue");
    expect(libelleHeure("")).toBe("date inconnue");
  });
});

describe("chiffres du releve", () => {
  it("le taux null se lit « non évalué », jamais 0 %", () => {
    expect(libelleTaux(null)).toBe("non évalué");
    expect(libelleTaux(0)).toBe("0 %");
    expect(libelleTaux(0.874)).toBe("87 %");
    expect(libelleTaux(1)).toBe("100 %");
  });
  it("un taux hors de [0, 1] est dit invalide, pas converti", () => {
    expect(libelleTaux(87)).toBe("valeur invalide");
    expect(libelleTaux(-0.1)).toBe("valeur invalide");
    expect(libelleTaux(Number.NaN)).toBe("valeur invalide");
  });
  it("la distance null se lit « non calculée »", () => {
    expect(libelleDistance(null)).toBe("non calculée");
    expect(libelleDistance(850)).toBe("850 m");
    expect(libelleDistance(12_345)).toBe("12,3 km");
    expect(libelleDistance(-5)).toBe("non calculée");
  });
  it("la duree est lisible, et une duree invalide est dite non communiquee", () => {
    expect(libelleDureeReleve(45)).toBe("45 s");
    expect(libelleDureeReleve(725)).toBe("12 min 05 s");
    expect(libelleDureeReleve(3_900)).toBe("1 h 05 min");
    expect(libelleDureeReleve(0)).toBe("0 s");
    expect(libelleDureeReleve(-1)).toBe("non communiquée");
    expect(libelleDureeReleve(Number.NaN)).toBe("non communiquée");
  });
  it("le total dit ce qui est affiche sur ce qui existe", () => {
    expect(libelleTotal(0, 0)).toBe("Aucun relevé");
    expect(libelleTotal(1, 1)).toBe("1 relevé envoyé");
    expect(libelleTotal(3, 3)).toBe("3 relevés envoyés");
    expect(libelleTotal(25, 40)).toBe("25 relevés affichés sur 40");
  });
});

describe("liens et agents", () => {
  it("deux releves de la meme minute ont des liens de noms distincts", () => {
    const a = nomLienReleve({ id: "aaaaaaaa-1", debutA: "2026-10-26T12:30:15Z" }, UTC);
    const b = nomLienReleve({ id: "bbbbbbbb-2", debutA: "2026-10-26T12:30:48Z" }, UTC);
    expect(a).toBe("Voir le relevé du 26/10/2026 à 12:30:15");
    expect(b).not.toBe(a);
  });
  it("sans date lisible, le nom du lien porte l'identifiant (jamais « du date inconnue »)", () => {
    expect(nomLienReleve({ id: "abcdef12-0000", debutA: "x" }, UTC)).toBe("Voir le relevé abcdef12");
  });
  it("ADMIN et GESTIONNAIRE voient plusieurs agents, les autres roles non", () => {
    expect(voitPlusieursAgents("ADMIN")).toBe(true);
    expect(voitPlusieursAgents("GESTIONNAIRE")).toBe(true);
    expect(voitPlusieursAgents("INSPECTEUR")).toBe(false);
    expect(voitPlusieursAgents("LECTEUR")).toBe(false);
    expect(voitPlusieursAgents(undefined)).toBe(false);
  });
  it("fusionne les agents sans doublon, par nom", () => {
    const l = fusionnerAgents([{ id: "2", nom: "Zoe" }], [{ agent: { id: "1", nom: "Alice" } }, { agent: { id: "2", nom: "Zoe" } }]);
    expect(l).toEqual([{ id: "1", nom: "Alice" }, { id: "2", nom: "Zoe" }]);
  });
});

describe("periode", () => {
  it("convertit les jours locaux en instants ISO avec fuseau : debut du premier jour, fin du dernier", () => {
    const p = periodeVersParametres("2026-10-01", "2026-10-26");
    expect(p.erreur).toBeNull();
    expect(p.depuis).toBe(new Date(2026, 9, 1, 0, 0, 0, 0).toISOString());
    expect(p.jusqua).toBe(new Date(2026, 9, 26, 23, 59, 59, 999).toISOString());
    // Le format que le serveur reel a accepte (200) : AAAA-MM-JJThh:mm:ss.mmmZ.
    expect(p.depuis).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(p.jusqua).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
  it("une borne vide n'est pas envoyee", () => {
    expect(periodeVersParametres("", "")).toEqual({ depuis: null, jusqua: null, erreur: null });
    expect(periodeVersParametres("2026-10-01", "").jusqua).toBeNull();
  });
  it("refuse un debut apres la fin et un jour inexistant", () => {
    expect(periodeVersParametres("2026-10-26", "2026-10-01").erreur).toMatch(/postérieure/);
    expect(periodeVersParametres("2026-02-30", "").erreur).toMatch(/début/);
    expect(periodeVersParametres("", "2026-13-01").erreur).toMatch(/fin/);
  });
  it("refuse une annee que le serveur refuserait (400 hors 2000 a 2099, constate sur le serveur reel) au lieu de l'envoyer", () => {
    expect(periodeVersParametres("1999-06-01", "").erreur).toMatch(/début.*2000 à 2099/);
    expect(periodeVersParametres("", "2100-06-01").erreur).toMatch(/fin.*2000 à 2099/);
    expect(periodeVersParametres("1900-01-01", "").erreur).not.toBeNull();
    expect(periodeVersParametres("2000-06-01", "2099-06-01").erreur).toBeNull();
  });
});

describe("erreurs", () => {
  it("classe par statut HTTP", () => {
    expect(classerErreur({ response: { status: 403 } })).toBe("refuse");
    expect(classerErreur({ response: { status: 401 } })).toBe("refuse");
    expect(classerErreur({ response: { status: 404 } })).toBe("introuvable");
    expect(classerErreur({ response: { status: 500 } })).toBe("serveur");
    expect(classerErreur(new Error("Network Error"))).toBe("reseau");
    expect(classerErreur({ name: "ReponseIllisible" })).toBe("illisible");
  });
  it("le 404 reel (corps RELEVE_INTROUVABLE) est « introuvable » ; le 503 reel d'un compte non relu l'est « serveur »", () => {
    expect(classerErreur({ response: { status: 404, data: CORPS_404_REEL } })).toBe("introuvable");
    expect(classerErreur({ response: { status: 503, data: { error: "Service momentanement indisponible", code: "SERVICE_INDISPONIBLE" } } })).toBe("serveur");
    expect(classerErreur({ response: { status: 400, data: { error: "Parametre depuis invalide", code: "PARAMETRE_INVALIDE" } } })).toBe("serveur");
  });
  it("un refus ou un 404 ne propose pas « Réessayer »", () => {
    expect(peutReessayer("refuse")).toBe(false);
    expect(peutReessayer("introuvable")).toBe(false);
    expect(peutReessayer("reseau")).toBe(true);
    expect(peutReessayer("serveur")).toBe(true);
    expect(peutReessayer("illisible")).toBe(true);
  });
  it("chaque genre a son propre message, et aucun ne dit « aucun relevé »", () => {
    const genres = ["refuse", "introuvable", "reseau", "illisible", "serveur"] as const;
    const messages = genres.map((g) => messageErreur(g, "liste"));
    expect(new Set(messages).size).toBe(genres.length);
    for (const m of messages) expect(m.toLowerCase()).not.toMatch(/aucun relevé/);
    expect(messageErreur("introuvable", "detail")).toMatch(/introuvable/i);
  });
});

describe("trace", () => {
  const trace = { nbPoints: 1200, pointsDisponibles: true };
  const ligne = [[-13.6, 9.6], [-13.61, 9.61], [-13.62, 9.62]];

  it("inverse [lon, lat] en [lat, lon] et ecarte ce qui n'est pas dessinable", () => {
    expect(lignesTrace({ type: "MultiLineString", coordinates: [ligne] })).toEqual([[[9.6, -13.6], [9.61, -13.61], [9.62, -13.62]]]);
    // un point hors plage est ecarte ; une ligne de moins de deux points aussi
    expect(lignesTrace({ type: "MultiLineString", coordinates: [[[-13.6, 9.6], [500, 9.6], [-13.7, 9.7]], [[-13.6, 9.6]]] })).toEqual([[[9.6, -13.6], [9.7, -13.7]]]);
    expect(lignesTrace(null)).toEqual([]);
  });
  it("dessine la geometrie REELLE du serveur (ECR-1) : meme nombre de sommets, [lat, lon] en tete", () => {
    const d = reel(DETAIL_REEL_ECR1);
    const lignes = lignesTrace(d.geometrie);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toHaveLength(d.geometrie!.coordinates[0].length);
    expect(lignes[0][0]).toEqual([9.64, -13.598178]);
  });
  it("sans geometrie : « trace non disponible »", () => {
    const e = etatTrace({ geometrie: null, simplifiee: false, trace });
    expect(e.genre).toBe("absente");
    expect(e.message).toMatch(/Trace non disponible/);
  });
  it("une geometrie sans ligne exploitable est aussi « absente »", () => {
    expect(etatTrace({ geometrie: { type: "MultiLineString", coordinates: [] }, simplifiee: false, trace }).genre).toBe("absente");
  });
  it("une trace simplifiee le dit, avec le nombre de positions enregistrees et le fait que la distance ne vient pas du trace dessine", () => {
    const e = etatTrace({ geometrie: { type: "MultiLineString", coordinates: [ligne] }, simplifiee: true, trace });
    expect(e.genre).toBe("simplifiee");
    expect(e.message).toMatch(/simplifiée/);
    expect(e.message).toMatch(/1\s?200/);
    expect(e.message).toMatch(/distance parcourue vient de l'analyse/);
  });
  it("le releve REEL de 25 000 positions est dit simplifie, avec son nombre de positions", () => {
    const e = etatTrace(reel(DETAIL_REEL_ECR3));
    expect(e.genre).toBe("simplifiee");
    expect(e.message).toMatch(/25\s?000 positions/);
  });
  it("une trace complete ne porte aucun message", () => {
    expect(etatTrace({ geometrie: { type: "MultiLineString", coordinates: [ligne] }, simplifiee: false, trace })).toMatchObject({ genre: "complete", message: null });
    expect(etatTrace(reel(DETAIL_REEL_ECR1))).toMatchObject({ genre: "complete", message: null });
  });
  it("dit quand le serveur ne garde pas les positions detaillees (booleen), et se tait quand elles sont la", () => {
    expect(noteSurPositions({ nbPoints: 10, pointsDisponibles: true })).toBeNull();
    expect(noteSurPositions({ nbPoints: 10, pointsDisponibles: false })).toMatch(/pas disponibles/);
    expect(noteSurPositions(reel(DETAIL_REEL_ECR1).trace)).toBeNull();
  });
});

describe("analyse de l'appareil", () => {
  const analyse = (sur: Partial<DetailReleveEnvoye["analyse"]>): DetailReleveEnvoye["analyse"] => ({ compteurs: {}, trous: null, interruptions: null, pauses: null, serveur: null, ...sur });

  it("compte un nombre ou la taille d'une liste, et le reste est inconnu", () => {
    expect(compter(3)).toBe(3);
    expect(compter([{}, {}])).toBe(2);
    expect(compter(null)).toBeNull();
    expect(compter("3")).toBeNull();
    expect(compter(-1)).toBeNull();
  });
  it("lit un compte dans son bloc, sinon dans `compteurs`, sinon `null` (jamais zero)", () => {
    expect(lireCompte(analyse({ trous: [1, 2], interruptions: 0 }), "trous")).toBe(2);
    expect(lireCompte(analyse({ trous: [1, 2], interruptions: 0 }), "interruptions")).toBe(0);
    expect(lireCompte(analyse({ compteurs: { pauses: 4 } }), "pauses")).toBe(4);
    expect(lireCompte(analyse({}), "pauses")).toBeNull();
  });
  it("lit les blocs REELS : listes vides = zero, compteurs reels = zero position ecartee", () => {
    const a = reel(DETAIL_REEL_ECR1).analyse;
    expect(lireCompte(a, "trous")).toBe(0);
    expect(lireCompte(a, "interruptions")).toBe(0);
    expect(lireCompte(a, "pauses")).toBe(0);
    expect(positionsEcartees(a.compteurs)).toBe(0);
  });
  it("additionne les positions ecartees seulement si le serveur les compte", () => {
    expect(positionsEcartees({ rejets: { SAUT: 2, DOUBLON: 3 } })).toBe(5);
    expect(positionsEcartees({ rejets: { SAUT: "2" } })).toBeNull();
    expect(positionsEcartees({})).toBeNull();
  });
});

describe("analyse du serveur (analyse.serveur)", () => {
  it("lit les avertissements REELS tels que le serveur les a ecrits, et les indicateurs du taux", () => {
    const l = lireAnalyseServeur(reel(DETAIL_REEL_ECR1).analyse.serveur);
    expect(l.avertissements).toHaveLength(2);
    expect(l.avertissements[0]).toBe((DETAIL_REEL_ECR1.analyse.serveur.avertissements as string[])[0]);
    expect(l).toMatchObject({ pointsRecus: 281, pointsRetenus: 141, pointsRattaches: 141 });
    const hors = lireAnalyseServeur(reel(DETAIL_REEL_ECR2).analyse.serveur);
    expect(hors.avertissements).toEqual([expect.stringMatching(/^Moins de la moitie des points sont expliques par le reseau choisi/)]);
    expect(hors).toMatchObject({ pointsRetenus: 45, pointsRattaches: 0 });
  });
  it("ne devine rien : absent, d'une autre forme ou vide, il ne donne ni avertissement ni chiffre", () => {
    const vide = { avertissements: [], pointsRecus: null, pointsRetenus: null, pointsRattaches: null };
    expect(lireAnalyseServeur(null)).toEqual(vide);
    expect(lireAnalyseServeur("texte")).toEqual(vide);
    expect(lireAnalyseServeur({ indicateurs: { pointsRetenus: "45" }, avertissements: "oups" })).toEqual(vide);
    expect(lireAnalyseServeur({ avertissements: ["a", "", "  ", 4, "a", "b"] }).avertissements).toEqual(["a", "b"]);
  });
});

function detail(sur: Partial<DetailReleveEnvoye> = {}): DetailReleveEnvoye {
  return {
    id: "s1", debutA: "2026-10-26T12:00:00Z", finA: "2026-10-26T12:20:00Z", dureeS: 1200, nbPoints: 900, nbMarqueurs: 2, nbEvenements: 1,
    tauxRattachement: null, longueurM: null, missionId: null, agent: { id: "a1", nom: "Agent Essai" }, nbTronconsTraverses: 3, creeLe: "2026-10-26T13:00:00Z",
    geometrie: null, simplifiee: false, marqueurs: [], evenements: [],
    analyse: { compteurs: {}, trous: null, interruptions: [1], pauses: [], serveur: null },
    parametres: { provenance: "profil standard", versionContrat: 1, seuils: null }, trace: { nbPoints: 900, pointsDisponibles: true },
    ...sur,
  };
}

describe("resume chiffre", () => {
  it("ne remplace jamais une valeur inconnue par un chiffre", () => {
    const l = Object.fromEntries(lignesResume(detail(), UTC).map((x) => [x.libelle, x.valeur]));
    expect(l["Rattachement au réseau"]).toBe("non évalué");
    expect(l["Distance parcourue"]).toBe("non calculée");
    expect(l["Trous de signal"]).toBe("non communiqué");
    expect(l["Interruptions"]).toBe("1");
    expect(l["Pauses"]).toBe("0");
    expect(l["Durée"]).toBe("20 min 00 s");
    expect(l["Début"]).toBe("26/10/2026 à 12:00");
    expect(l["Tronçons rattachés"]).toBe("3");
    expect(l["Positions retenues par l'analyse"]).toBeUndefined();
  });
  it("ajoute les positions ecartees seulement quand elles sont comptees", () => {
    expect(lignesResume(detail(), UTC).some((x) => x.libelle.startsWith("Positions écartées"))).toBe(false);
    expect(lignesResume(detail({ analyse: { compteurs: { rejets: { A: 4 } }, trous: [], interruptions: [], pauses: [], serveur: null } }), UTC).find((x) => x.libelle.startsWith("Positions écartées"))?.valeur).toBe("4");
  });
  it("le releve REEL ECR-1 : distance parcourue de l'analyse, taux 100 % sur 141 positions retenues toutes rattachees", () => {
    const l = Object.fromEntries(lignesResume(reel(DETAIL_REEL_ECR1), UTC).map((x) => [x.libelle, x.valeur]));
    expect(l["Distance parcourue"]).toBe("2,8 km");
    expect(l["Rattachement au réseau"]).toBe("100 %");
    expect(l["Positions enregistrées"]).toBe("281");
    expect(l["Positions retenues par l'analyse"]).toBe("141");
    expect(l["dont rattachées au réseau"]).toBe("141");
    expect(l["Positions écartées par l'appareil"]).toBe("0");
    expect(l["Tronçons rattachés"]).toBe("2");
    expect(l["Début"]).toBe("24/10/2026 à 08:00");
  });
  it("le releve REEL ECR-2 (hors reseau) : « 0 % » est une VALEUR, avec son denominateur (45 retenues, 0 rattachee)", () => {
    const l = Object.fromEntries(lignesResume(reel(DETAIL_REEL_ECR2), UTC).map((x) => [x.libelle, x.valeur]));
    expect(l["Rattachement au réseau"]).toBe("0 %");
    expect(l["Positions retenues par l'analyse"]).toBe("45");
    expect(l["dont rattachées au réseau"]).toBe("0");
    expect(l["Distance parcourue"]).toBe("878 m");
  });
  it("la provenance reelle est dite en francais ; une provenance inconnue est rendue telle quelle", () => {
    expect(libelleProvenance("PROVISOIRE_NON_CALIBRE")).toBe("seuils provisoires, non calibrés");
    expect(libelleProvenance("CALIBRE_2027")).toBe("CALIBRE_2027");
  });
  it("les seuils reels sont rendus tels quels (nom technique, valeur), sans traduction ni interpretation", () => {
    const l = lignesSeuils(reel(DETAIL_REEL_ECR1).parametres.seuils);
    expect(l).toHaveLength(15);
    expect(l).toContainEqual({ libelle: "trouMs", valeur: "5000" });
    expect(l).toContainEqual({ libelle: "refuserSansPrecision", valeur: "false" });
    expect(lignesSeuils(null)).toEqual([]);
  });
});

describe("reperes et segments", () => {
  const m = (sur: Partial<MarqueurReleve>): MarqueurReleve => ({
    id: "m", code: "POINT_A_VERIFIER", note: null, poseA: "2026-10-26T12:05:00Z", lat: 9.6, lon: -13.6, sourcePosition: "TRACE", precisionM: 8, positionPerimee: false,
    statut: "RATTACHE", motif: null, tronconId: null, tronconCode: null, abscisseM: null, ...sur,
  });

  it("ecrit le code et l'heure de pose", () => {
    expect(etiquetteMarqueur(m({}), UTC)).toBe("POINT_A_VERIFIER à 12:05:00");
  });
  it("separe les reperes places sur la carte de ceux sans position", () => {
    const r = repartirMarqueurs([m({ id: "a" }), m({ id: "b", lat: null, lon: null }), m({ id: "c", lat: 200, lon: 0 })], UTC);
    expect(r.surCarte.map((x) => x.marqueur.id)).toEqual(["a"]);
    expect(r.sansPosition.map((x) => x.id)).toEqual(["b", "c"]);
  });
  it("signale une position perimee du telephone et une position absente, et se tait sinon", () => {
    expect(noteMarqueur(m({}))).toBeNull();
    expect(noteMarqueur(m({ positionPerimee: true, sourcePosition: "APPAREIL" }))).toMatch(/Position périmée/);
    expect(noteMarqueur(m({ lat: null, lon: null, positionPerimee: true, sourcePosition: null }))).toMatch(/Aucune position connue/);
  });
  it("un repere place SUR LA TRACE n'est pas « approximatif » meme si le dernier point du telephone etait ancien : la note le dit autrement", () => {
    const sur = m({ positionPerimee: true, sourcePosition: "TRACE" });
    expect(positionApproximative(sur)).toBe(false);
    expect(positionApproximative(m({ positionPerimee: true, sourcePosition: "APPAREIL" }))).toBe(true);
    expect(positionApproximative(m({ positionPerimee: false, sourcePosition: "APPAREIL" }))).toBe(false);
    expect(noteMarqueur(sur)).toMatch(/position affichée est celle de la trace/);
    expect(noteMarqueur(sur)).not.toMatch(/approximatif/);
    expect(repartirMarqueurs([sur], UTC).surCarte[0].approximative).toBe(false);
    expect(repartirMarqueurs([m({ positionPerimee: true, sourcePosition: "APPAREIL" })], UTC).surCarte[0].approximative).toBe(true);
  });
  it("dit d'ou vient la position, sans rien dire quand le serveur ne le dit pas", () => {
    expect(libelleSourcePosition("TRACE")).toMatch(/sur la trace/);
    expect(libelleSourcePosition("APPAREIL")).toMatch(/téléphone/);
    expect(libelleSourcePosition(null)).toBeNull();
    expect(libelleSourcePosition("AUTRE")).toBeNull();
  });
  it("traduit les statuts connus et rend les autres tels quels", () => {
    expect(libelleStatutMarqueur("RATTACHE")).toBe("rattaché à un tronçon");
    expect(libelleStatutMarqueur("NOUVEAU_STATUT")).toBe("NOUVEAU_STATUT");
    expect(libelleStatutRattachement("PORTIONS_CREEES")).toBe("portions proposées");
    expect(libelleStatutRattachement("AUTRE")).toBe("AUTRE");
    expect(libelleSens("CROISSANT")).toBe("sens croissant");
    expect(libelleSens(null)).toBe("sens non précisé");
    expect(libelleSens("DIAGONAL")).toBe("DIAGONAL");
  });
  it("ecrit la qualification en codes, sans rien ajouter", () => {
    expect(libelleQualification(null)).toBe("aucune qualification");
    expect(libelleQualification({})).toBe("aucune qualification");
    expect(libelleQualification({ revetement: "R_UN", etat: "E_UN", largeurM: 6 })).toBe("revêtement R_UN, état E_UN, largeur 6 m");
    expect(libelleQualification({ praticabilite: "P_UN", etat: null })).toBe("praticabilité P_UN");
    expect(libelleQualification(reel(DETAIL_REEL_ECR1).evenements[0].qualification)).toBe("état MAUVAIS");
  });

  describe("rattachement d'un repere", () => {
    it("REEL, rattache : le troncon et la distance depuis son debut", () => {
      const [a, b] = reel(DETAIL_REEL_ECR1).marqueurs;
      expect(libelleRattachementMarqueur(a)).toBe("rattaché à un tronçon ECR-1, à 600 m du début du tronçon");
      expect(libelleRattachementMarqueur(b)).toBe("rattaché à un tronçon ECR-2, à 1,0 km du début du tronçon");
    });
    it("REEL, non rattache : le motif du serveur, en francais", () => {
      const [h] = reel(DETAIL_REEL_ECR2).marqueurs;
      expect(libelleRattachementMarqueur(h)).toBe("non rattaché à un tronçon (aucun point de la trace n'était rattaché au réseau près de l'instant de pose)");
    });
    it("un motif inconnu est rendu tel quel, un troncon pressenti est nomme comme tel", () => {
      expect(libelleRattachementMarqueur(m({ statut: "NON_RATTACHE", motif: "TROP_LOIN_DU_TRONCON", tronconCode: "RN1-04" })))
        .toBe("non rattaché à un tronçon (trop loin du tronçon pour y être rattaché), tronçon pressenti RN1-04");
      expect(libelleRattachementMarqueur(m({ statut: "NON_RATTACHE", motif: "MOTIF_FUTUR" }))).toBe("non rattaché à un tronçon (MOTIF_FUTUR)");
      expect(libelleRattachementMarqueur(m({ statut: "NON_RATTACHE", motif: null }))).toBe("non rattaché à un tronçon");
    });
    it("sans abscisse ni code, rien n'est invente", () => {
      expect(libelleRattachementMarqueur(m({ statut: "RATTACHE" }))).toBe("rattaché à un tronçon");
      expect(libelleRattachementMarqueur(m({ statut: "STATUT_FUTUR", motif: null }))).toBe("STATUT_FUTUR");
    });
    it("traduit les quatre motifs de repere que le serveur ecrit", () => {
      for (const code of ["AUCUN_POINT_RATTACHE_A_PROXIMITE", "POSITION_INCONNUE", "TRONCON_SANS_GEOMETRIE", "TROP_LOIN_DU_TRONCON"]) {
        expect(libelleMotifMarqueur(code)).not.toBe(code);
      }
    });
  });

  describe("resultat d'un segment", () => {
    const e = (statutRattachement: string, motif: string | null) => ({ statutRattachement, motif });
    it("REEL, portions creees : le statut seul", () => {
      expect(libelleResultatEvenement(reel(DETAIL_REEL_ECR1).evenements[0])).toBe("portions proposées");
    });
    it("REEL, non rattache : le statut et le motif du serveur, en francais", () => {
      expect(libelleResultatEvenement(reel(DETAIL_REEL_ECR2).evenements[0])).toBe("non rattaché au réseau (aucun point de la trace rattaché au réseau au début du segment)");
    });
    it("un segment abandonne cite le texte de l'agent entre guillemets, tel quel", () => {
      expect(libelleResultatEvenement(e("ABANDONNE", "ABANDONNE_PAR_AGENT"))).toBe("abandonné par l'agent (motif écrit par l'agent : « ABANDONNE_PAR_AGENT »)");
    });
    it("un code de referentiel inconnu nomme le champ ; un motif inconnu est rendu tel quel", () => {
      expect(libelleMotifEvenement("CODE_REFERENTIEL_INCONNU:etat")).toBe("code de référentiel inconnu (etat)");
      expect(libelleMotifEvenement("HORS_TERRITOIRE")).toBe("HORS_TERRITOIRE");
      expect(libelleResultatEvenement(e("PORTIONS_REFUSEES", "HORS_TERRITOIRE"))).toBe("portions refusées par le serveur (HORS_TERRITOIRE)");
    });
    it("dit quand des portions refusees ne sont pas listees par la consultation", () => {
      expect(aDesPortionsNonListees([e("PORTIONS_CREEES", null)])).toBe(false);
      expect(aDesPortionsNonListees([e("PORTIONS_CREEES", null), e("PORTIONS_PARTIELLES", null)])).toBe(true);
      expect(aDesPortionsNonListees([e("PORTIONS_REFUSEES", null)])).toBe(true);
      expect(aDesPortionsNonListees(reel(DETAIL_REEL_ECR1).evenements)).toBe(false);
    });
  });
});

describe("troncons rattaches", () => {
  const portion = (rang: number, tronconId: string, debutM: number | null, finM: number | null) =>
    ({ rang, portionId: null, tronconId, tronconCode: `T-${tronconId}`, tronconNom: `Nom ${tronconId}`, debutM, finM, sens: "CROISSANT" });
  const evt = (id: string, portions: ReturnType<typeof portion>[]): EvenementReleve => ({
    id, code: "SEGMENT", note: null, statutAppareil: "CLOS", qualification: null, debutA: "2026-10-26T12:00:00Z", finA: "2026-10-26T12:10:00Z", statutRattachement: "PORTIONS_CREEES", motif: null, portions,
  });
  const repere = (id: string, statut: string, tronconId: string | null, tronconCode: string | null): MarqueurReleve => ({
    id, code: "POINT_A_VERIFIER", note: null, poseA: "2026-10-26T12:05:00Z", lat: 9.6, lon: -13.6, sourcePosition: "TRACE", precisionM: 5, positionPerimee: false, statut, motif: null, tronconId, tronconCode, abscisseM: 10,
  });

  it("regroupe les portions par troncon, dans l'ordre de premiere apparition", () => {
    const l = tronconsRattaches([evt("e1", [portion(2, "B", 0, 100), portion(1, "A", 200, 900)]), evt("e2", [portion(1, "A", 0, 50)])]);
    expect(l.map((t) => t.tronconId)).toEqual(["A", "B"]);
    expect(l[0].passages).toHaveLength(2);
    expect(l[0].reperes).toEqual([]);
  });
  it("ajoute les troncons des reperes RATTACHES (comme le compte du serveur), pas ceux des reperes non rattaches", () => {
    const l = tronconsRattaches([evt("e1", [portion(1, "A", 0, 50)])], [repere("m1", "RATTACHE", "A", "T-A"), repere("m2", "RATTACHE", "C", "T-C"), repere("m3", "NON_RATTACHE", "D", "T-D"), repere("m4", "RATTACHE", null, null)]);
    expect(l.map((t) => t.tronconId)).toEqual(["A", "C"]);
    expect(l[0].reperes.map((r) => r.id)).toEqual(["m1"]);
    expect(l[1]).toMatchObject({ code: "T-C", nom: null, passages: [] });
  });
  it("aucun evenement, aucun troncon", () => {
    expect(tronconsRattaches([])).toEqual([]);
  });
  it("REEL : le nombre de troncons detailles est celui que compte le serveur (ECR-1 : 2, ECR-2 : 0), sans note de manque", () => {
    for (const brut of [DETAIL_REEL_ECR1, DETAIL_REEL_ECR2, DETAIL_REEL_ECR3]) {
      const d = reel(brut);
      const l = tronconsRattaches(d.evenements, d.marqueurs);
      expect(l).toHaveLength(d.nbTronconsTraverses);
      expect(noteTronconsManquants(d.nbTronconsTraverses, l.length)).toBeNull();
    }
    const d = reel(DETAIL_REEL_ECR1);
    const l = tronconsRattaches(d.evenements, d.marqueurs);
    expect(l.map((t) => [t.code, t.nom, t.passages.length, t.reperes.length])).toEqual([["ECR-1", "Route ECR-1", 2, 1], ["ECR-2", "Route ECR-2", 1, 1]]);
  });
  it("dit quand le serveur compte plus de troncons que ceux detailles", () => {
    expect(noteTronconsManquants(5, 2)).toMatch(/5 tronçons rattachés ; 2 seulement/);
    expect(noteTronconsManquants(2, 2)).toBeNull();
    expect(noteTronconsManquants(1, 2)).toBeNull();
  });
  it("ecrit une portion avec ses bornes, et un « ? » quand une borne manque", () => {
    expect(libellePortion({ debutM: 200, finM: 1_500, sens: "CROISSANT" })).toBe("de 200 m à 1,5 km depuis le début du tronçon, sens croissant");
    expect(libellePortion({ debutM: null, finM: 80, sens: null })).toBe("de ? à 80 m depuis le début du tronçon, sens non précisé");
  });
  it("nomme un troncon sans inventer ce qui manque", () => {
    expect(libelleTroncon({ tronconId: "abcdef123", code: "RN1-01", nom: "Coyah" })).toBe("RN1-01 : Coyah");
    expect(libelleTroncon({ tronconId: "abcdef123", code: null, nom: null })).toBe("Tronçon abcdef12");
  });
});
