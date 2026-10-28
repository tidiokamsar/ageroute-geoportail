import { describe, expect, it } from "vitest";
import { alimenter, demarrerBanc, echantillon, generateurIds, T0 } from "./aide-test";
import { horlogeSimulee } from "./horloge";
import { JournalMemoire, lireEntree, serialiserEntree, VERSION_JOURNAL } from "./journal";
import { SessionRoulage, couvertureDe } from "./session";
import { PARAMETRES_PROVISOIRES } from "./parametres";

/**
 * Ce que ces tests defendent, et ce qu'ils ne defendent PAS :
 *   - la machine a etats, le filtre, les trous, le marqueur, l'evenement lineaire et la reprise sont
 *     des COMPORTEMENTS LOGIQUES, verifies avec une horloge simulee et des evenements injectes ;
 *   - un appel entrant, une veille ou un redemarrage sont ici des EVENEMENTS INJECTES. Aucun n'a ete
 *     observe sur un telephone : les tests ne prouvent pas que l'hote les detecte ni qu'il les
 *     transmet au noyau (voir docs/roulage/COLLECTE-ROULAGE.md, liste « NON VERIFIE sur appareil »).
 */

describe("machine a etats", () => {
  it("demarre EN_COURS, refuse des parametres incoherents sans rien corriger", () => {
    const b = demarrerBanc();
    expect(b.session.etat.statut).toBe("EN_COURS");
    expect(b.session.etat.parametres).toEqual(PARAMETRES_PROVISOIRES);
    const refus = SessionRoulage.demarrer({ horloge: horlogeSimulee(), genererId: generateurIds(), parametres: { precisionMaxM: -1, couvertureMinEvenement: 2 } });
    expect(refus.ok).toBe(false);
    if (!refus.ok) expect(refus.erreurs.length).toBeGreaterThanOrEqual(2);
  });

  it("pause : les echantillons sont ecartes et comptes, la reprise ouvre un nouveau segment sans fabriquer de trou", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 9);
    expect(b.session.mettreEnPause()).toEqual({ ok: true });
    expect(b.session.mettreEnPause()).toMatchObject({ ok: false, refus: "DEJA_EN_PAUSE" });
    b.horloge.fixer(T0 + 10_000);
    expect(b.session.ajouterEchantillon(echantillon(10))).toEqual({ accepte: false, motif: "SESSION_NON_EN_COURS" });
    b.horloge.fixer(T0 + 120_000);
    expect(b.session.reprendre()).toEqual({ ok: true });
    const r = b.session.ajouterEchantillon(echantillon(121));
    expect(r).toMatchObject({ accepte: true, segment: 1, trou: false });
    expect(b.session.etat.trous).toHaveLength(0);
    expect(b.session.etat.pauses).toEqual([{ debutMs: T0 + 9000, finMs: T0 + 120_000 }]);
    expect(b.session.reprendre()).toMatchObject({ ok: false, refus: "PAS_EN_PAUSE" });
    expect(b.session.resume().rejets.SESSION_NON_EN_COURS).toBe(1);
  });

  it("arret : etat final, plus aucune commande n'est acceptee", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 5);
    expect(b.session.arreter()).toMatchObject({ ok: true, clos: [], abandonnes: [] });
    expect(b.session.etat.statut).toBe("ARRETEE");
    expect(b.session.etat.finMs).toBe(T0 + 5000);
    expect(b.session.arreter()).toMatchObject({ ok: false, refus: "SESSION_ARRETEE" });
    expect(b.session.poserMarqueur("NID_DE_POULE")).toMatchObject({ ok: false, refus: "SESSION_ARRETEE" });
    expect(b.session.debutEvenement("ETAT_CHAUSSEE")).toMatchObject({ ok: false, refus: "SESSION_ARRETEE" });
    expect(b.session.mettreEnPause()).toMatchObject({ ok: false, refus: "SESSION_ARRETEE" });
    expect(b.session.signalerSysteme({ type: "APPEL_ENTRANT" })).toMatchObject({ ok: false, refus: "SESSION_ARRETEE" });
    expect(b.session.ajouterEchantillon(echantillon(6))).toEqual({ accepte: false, motif: "SESSION_NON_EN_COURS" });
  });
});

describe("filtre de precision et derive", () => {
  it("ecarte la precision insuffisante, les coordonnees invalides, les doublons et les retours en arriere, et compte chaque motif", () => {
    const b = demarrerBanc();
    b.horloge.fixer(T0);
    expect(b.session.ajouterEchantillon(echantillon(0, 10, { precisionM: 51 }))).toEqual({ accepte: false, motif: "PRECISION_INSUFFISANTE" });
    expect(b.session.ajouterEchantillon(echantillon(0, 10, { precisionM: 50 }))).toMatchObject({ accepte: true });
    expect(b.session.ajouterEchantillon(echantillon(0, 10, { precisionM: 5 }))).toEqual({ accepte: false, motif: "HORODATAGE_DOUBLON" });
    b.horloge.fixer(T0 + 2000);
    b.session.ajouterEchantillon(echantillon(2));
    expect(b.session.ajouterEchantillon(echantillon(1))).toEqual({ accepte: false, motif: "HORODATAGE_RECULE" });
    expect(b.session.ajouterEchantillon(echantillon(3, 10, { lat: 0, lon: 0 }))).toEqual({ accepte: false, motif: "COORDONNEES_INVALIDES" });
    expect(b.session.ajouterEchantillon(echantillon(3, 10, { lat: Number.NaN }))).toEqual({ accepte: false, motif: "COORDONNEES_INVALIDES" });
    expect(b.session.ajouterEchantillon(echantillon(3, 10, { tMs: -5 }))).toEqual({ accepte: false, motif: "HORODATAGE_INVALIDE" });
    expect(b.session.ajouterEchantillon(echantillon(3, 10, { precisionM: -2 }))).toEqual({ accepte: false, motif: "PRECISION_INSUFFISANTE" });
    expect(b.session.resume().rejets).toMatchObject({
      PRECISION_INSUFFISANTE: 2, HORODATAGE_DOUBLON: 1, HORODATAGE_RECULE: 1, COORDONNEES_INVALIDES: 2, HORODATAGE_INVALIDE: 1,
    });
    expect(b.session.etat.echantillons).toHaveLength(2);
  });

  it("le seuil de precision est parametrable et n'est pas suppose : 20 m refuse, 50 m (defaut) accepte", () => {
    const strict = demarrerBanc({ precisionMaxM: 20 });
    expect(strict.session.ajouterEchantillon(echantillon(0, 10, { precisionM: 30 }))).toMatchObject({ accepte: false });
    const defaut = demarrerBanc();
    expect(defaut.session.ajouterEchantillon(echantillon(0, 10, { precisionM: 30 }))).toMatchObject({ accepte: true });
  });

  it("sans precision annoncee : gardee et comptee par defaut, ecartee si le parametre l'exige. Aucune precision n'est inventee", () => {
    const tolerant = demarrerBanc();
    expect(tolerant.session.ajouterEchantillon(echantillon(0, 10, { precisionM: null }))).toMatchObject({ accepte: true });
    expect(tolerant.session.etat.sansPrecision).toBe(1);
    expect(tolerant.session.etat.echantillons[0].precisionM).toBeNull();
    const exigeant = demarrerBanc({ refuserSansPrecision: true });
    expect(exigeant.session.ajouterEchantillon(echantillon(0, 10, { precisionM: null }))).toEqual({ accepte: false, motif: "PRECISION_ABSENTE" });
  });

  it("saut impossible : ecarte, puis reancrage apres le nombre de rejets consecutifs parametre", () => {
    const b = demarrerBanc({ reancrageApresRejets: 3 });
    alimenter(b, 0, 4);
    // 50 km en une seconde : 180 000 km/h.
    const loin = (s: number) => echantillon(s, 10, { lat: 10.1, lon: -13.1 });
    b.horloge.fixer(T0 + 5000);
    expect(b.session.ajouterEchantillon(loin(5))).toEqual({ accepte: false, motif: "SAUT_IMPOSSIBLE" });
    b.horloge.fixer(T0 + 6000);
    expect(b.session.ajouterEchantillon(loin(6))).toEqual({ accepte: false, motif: "SAUT_IMPOSSIBLE" });
    b.horloge.fixer(T0 + 7000);
    const r = b.session.ajouterEchantillon(loin(7));
    expect(r).toMatchObject({ accepte: true });
    expect(b.session.etat.alertes.map((a) => a.type)).toContain("REANCRAGE");
    expect(b.session.resume().rejets.SAUT_IMPOSSIBLE).toBe(2);
  });

  it("un saut isole n'empeche pas la suite : le compteur de rejets repart de zero apres un echantillon sain", () => {
    const b = demarrerBanc({ reancrageApresRejets: 3 });
    alimenter(b, 0, 4);
    b.horloge.fixer(T0 + 5000);
    expect(b.session.ajouterEchantillon(echantillon(5, 10, { lat: 10.1, lon: -13.1 }))).toMatchObject({ accepte: false });
    b.horloge.fixer(T0 + 6000);
    expect(b.session.ajouterEchantillon(echantillon(6))).toMatchObject({ accepte: true });
    expect(b.session.etat.sautsConsecutifs).toBe(0);
  });

  it("fix fige : meme position avec une vitesse annoncee de deplacement, apres le nombre d'echantillons parametre", () => {
    const b = demarrerBanc({ fixFigeEchantillons: 4 });
    b.horloge.fixer(T0);
    b.session.ajouterEchantillon(echantillon(0));
    const fige = (s: number) => ({ ...echantillon(0), tMs: T0 + s * 1000, vitesseMs: 12 });
    const verdicts = [1, 2, 3, 4, 5].map((s) => { b.horloge.fixer(T0 + s * 1000); return b.session.ajouterEchantillon(fige(s)); });
    expect(verdicts.map((v) => v.accepte)).toEqual([true, true, true, false, false]);
    expect(b.session.resume().rejets.FIX_FIGE).toBe(2);
  });

  it("un vehicule arrete (vitesse annoncee nulle) a la meme position n'est PAS un fix fige", () => {
    const b = demarrerBanc({ fixFigeEchantillons: 4 });
    for (let s = 0; s < 30; s += 1) {
      b.horloge.fixer(T0 + s * 1000);
      expect(b.session.ajouterEchantillon({ ...echantillon(0), tMs: T0 + s * 1000, vitesseMs: 0 })).toMatchObject({ accepte: true });
    }
  });

  it("derive d'horloge : alerte quand l'horodatage GNSS s'ecarte de l'horloge de l'appareil, sauf livraison differee", () => {
    const b = demarrerBanc();
    b.horloge.fixer(T0 + 10_000);
    expect(b.session.ajouterEchantillon(echantillon(0))).toMatchObject({ accepte: true });
    expect(b.session.etat.alertes.map((a) => a.type)).toEqual(["DERIVE_HORLOGE"]);
    expect(b.session.ajouterEchantillon(echantillon(1), { differe: true })).toMatchObject({ accepte: true });
    expect(b.session.etat.alertes).toHaveLength(1);
  });
});

describe("trous et segments", () => {
  it("un ecart superieur au seuil est un trou, dans le meme segment ; au-dela du seuil de coupure, un nouveau segment", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 9);
    b.horloge.fixer(T0 + 18_000);
    const petit = b.session.ajouterEchantillon(echantillon(18));
    expect(petit).toMatchObject({ accepte: true, trou: true, segment: 0 });
    b.horloge.fixer(T0 + 70_000);
    const grand = b.session.ajouterEchantillon(echantillon(70));
    expect(grand).toMatchObject({ accepte: true, trou: true, segment: 1 });
    expect(b.session.etat.trous).toEqual([
      { debutMs: T0 + 9000, finMs: T0 + 18_000, dureeMs: 9000, coupeSegment: false },
      { debutMs: T0 + 18_000, finMs: T0 + 70_000, dureeMs: 52_000, coupeSegment: true },
    ]);
    expect(b.session.resume()).toMatchObject({ trous: 2, dureeTrousMs: 61_000, segments: 2 });
  });
});

describe("marqueur (A16, partie logicielle)", () => {
  it("porte l'instant du geste, la position du dernier fix et son anciennete", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    b.horloge.avancer(400);
    const r = b.session.poserMarqueur("NID_DE_POULE", { note: "devant l'ecole" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.marqueur.repere.tMs).toBe(T0 + 10_400);
    expect(r.marqueur.repere.ageFixMs).toBe(400);
    expect(r.marqueur.repere.positionPerimee).toBe(false);
    expect(r.marqueur.repere.lat).toBeCloseTo(echantillon(10).lat, 9);
    expect(r.marqueur.note).toBe("devant l'ecole");
    expect(r.journalise).toBe(true);
    expect(b.session.etat.marqueurs).toHaveLength(1);
  });

  it("un fix trop ancien, ou aucun fix, rend la position perimee : le marqueur est pose quand meme", () => {
    const b = demarrerBanc();
    const sansFix = b.session.poserMarqueur("OUVRAGE");
    expect(sansFix.ok && sansFix.marqueur.repere).toMatchObject({ lat: null, lon: null, ageFixMs: null, positionPerimee: true });
    alimenter(b, 0, 5);
    b.horloge.avancer(3000);
    const vieux = b.session.poserMarqueur("OUVRAGE");
    expect(vieux.ok && vieux.marqueur.repere).toMatchObject({ ageFixMs: 3000, positionPerimee: true });
  });

  it("pendant une perte du GNSS signalee, la position est perimee meme si le dernier fix est recent", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 5);
    b.session.signalerSysteme({ type: "GNSS_INDISPONIBLE" });
    b.horloge.avancer(500);
    const r = b.session.poserMarqueur("INCIDENT");
    expect(r.ok && r.marqueur.repere.positionPerimee).toBe(true);
  });

  it("refuse un code hors referentiel de forme, une note trop longue, une session en pause", () => {
    const b = demarrerBanc();
    expect(b.session.poserMarqueur("nid de poule")).toMatchObject({ ok: false, refus: "CODE_INVALIDE" });
    expect(b.session.poserMarqueur("OK", { note: "x".repeat(501) })).toMatchObject({ ok: false, refus: "NOTE_TROP_LONGUE" });
    b.session.mettreEnPause();
    expect(b.session.poserMarqueur("OK")).toMatchObject({ ok: false, refus: "SESSION_NON_EN_COURS" });
  });

  it("l'instant du geste n'est pas decale par un journal lent ; le depassement du budget est signale", () => {
    const horloge = horlogeSimulee(T0);
    const journalLent = (cpu: number) => () => horloge.consommerCpu(cpu);
    // Premiere entree (demarrage) : journal rapide. Puis on remplace le comportement par un journal lent.
    let cpu = 0;
    const r = SessionRoulage.demarrer({ horloge, genererId: generateurIds(), journal: () => journalLent(cpu)() });
    if (!r.ok) throw new Error("demarrage");
    const session = r.session;
    horloge.fixer(T0 + 1000);
    session.ajouterEchantillon(echantillon(1));

    cpu = 10;
    const rapide = session.poserMarqueur("A");
    expect(rapide.ok && rapide.depasseBudget).toBe(false);

    cpu = 250;
    const lent = session.poserMarqueur("B");
    expect(lent.ok).toBe(true);
    if (!lent.ok) return;
    expect(lent.depasseBudget).toBe(true);
    expect(lent.latenceTotaleMs).toBe(250);
    // Le marqueur porte l'instant du geste, pas l'instant de la fin de l'ecriture.
    expect(lent.marqueur.repere.tMs).toBe(T0 + 1000);
    // Le cout du marqueur lui-meme (avant le journal) reste sous le budget.
    expect(lent.marqueur.latenceLogicielleMs).toBeLessThan(PARAMETRES_PROVISOIRES.budgetLatenceLogicielleMs);
  });

  it("un journal qui echoue ne fait pas perdre le marqueur : il reste en memoire, l'echec est compte et date", () => {
    const horloge = horlogeSimulee(T0);
    let casse = false;
    const r = SessionRoulage.demarrer({
      horloge, genererId: generateurIds(),
      journal: () => { if (casse) throw new Error("disque plein"); },
    });
    if (!r.ok) throw new Error("demarrage");
    casse = true;
    const m = r.session.poserMarqueur("PERTE");
    expect(m).toMatchObject({ ok: true, journalise: false });
    expect(r.session.etat.marqueurs).toHaveLength(1);
    expect(r.session.resume().echecsJournal).toBe(1);
    expect(r.session.etat.alertes.at(-1)).toMatchObject({ type: "JOURNAL_ECHEC", detail: "disque plein" });
  });

  it("MESURE DE BUREAU (Node, pas un telephone) : poser un marqueur reste sous le budget avec 7 200 echantillons et 500 marqueurs", () => {
    const banc = demarrerBanc();
    for (let i = 0; i < 7200; i += 1) { banc.horloge.fixer(T0 + i * 1000); banc.session.ajouterEchantillon(echantillon(i)); }
    expect(banc.session.etat.echantillons).toHaveLength(7200);

    const durees: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      const t0 = performance.now();
      const m = banc.session.poserMarqueur("MESURE", { id: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}` });
      durees.push(performance.now() - t0);
      expect(m.ok).toBe(true);
    }
    durees.sort((a, b) => a - b);
    const pire = durees[durees.length - 1];
    const mediane = durees[Math.floor(durees.length / 2)];
    // 200 ms est le budget de l'exigence : il borne le PIRE cas. Une regression en O(n) (balayage de la
    // trace a chaque marqueur) decale TOUTE la serie, pas un seul point : c'est la MEDIANE, stricte, qui
    // l'attrape. Le pire cas d'une serie de 500 mesures est domine par les pauses de la machine (ramasse-
    // miettes, autres processus) : le borner a 50 ms le faisait echouer par intermittence quand la suite
    // complete tourne en parallele (constate le 22/10/2026). Cette mesure est celle de Node sur le poste
    // de developpement : elle ne dit RIEN de la latence sur un telephone.
    expect(mediane).toBeLessThan(20);
    expect(pire).toBeLessThan(200);
    expect(banc.session.etat.marqueurs).toHaveLength(500);
  });
});

describe("evenement lineaire Debut/Fin (A17)", () => {
  it("un evenement valide est clos avec ses deux reperes, sa couverture et sa distance directe", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    const d = b.session.debutEvenement("ETAT_CHAUSSEE", { qualification: { etat: "MAUVAIS" } });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    alimenter(b, 11, 40);
    const f = b.session.finEvenement(d.evenement.id);
    expect(f.ok).toBe(true);
    const ev = b.session.etat.evenements[0];
    expect(ev.statut).toBe("CLOS");
    expect(ev.debut.tMs).toBe(T0 + 10_000);
    expect(ev.fin?.tMs).toBe(T0 + 40_000);
    expect(ev.couvertureGnss).toBeCloseTo(1, 6);
    expect(ev.distanceDirecteM).toBeCloseTo(300, 0);
    expect(ev.avertissements).toEqual([]);
    expect(ev.qualification).toEqual({ etat: "MAUVAIS" });
  });

  it("refuse un second evenement ouvert pour le meme code, mais accepte un autre code", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 3);
    expect(b.session.debutEvenement("ETAT_CHAUSSEE").ok).toBe(true);
    expect(b.session.debutEvenement("ETAT_CHAUSSEE")).toMatchObject({ ok: false, refus: "EVENEMENT_DEJA_OUVERT" });
    expect(b.session.debutEvenement("PRATICABILITE").ok).toBe(true);
  });

  it("Fin avant Debut (horloge reculee) : refuse, l'evenement reste ouvert", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    const d = b.session.debutEvenement("ETAT_CHAUSSEE");
    if (!d.ok) throw new Error("debut");
    b.horloge.fixer(T0 + 5000);
    expect(b.session.finEvenement(d.evenement.id)).toMatchObject({ ok: false, refus: "FIN_AVANT_DEBUT" });
    expect(b.session.etat.evenements[0].statut).toBe("OUVERT");
  });

  it("duree nulle : refuse ; duree inferieure au minimum : refuse ; l'evenement reste ouvert et se cloture ensuite", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    const d = b.session.debutEvenement("ETAT_CHAUSSEE");
    if (!d.ok) throw new Error("debut");
    expect(b.session.finEvenement(d.evenement.id)).toMatchObject({ ok: false, refus: "DUREE_NULLE" });
    b.horloge.avancer(500);
    expect(b.session.finEvenement(d.evenement.id)).toMatchObject({ ok: false, refus: "DUREE_TROP_COURTE" });
    b.horloge.avancer(600);
    expect(b.session.finEvenement(d.evenement.id).ok).toBe(true);
  });

  it("fin sur un evenement inconnu ou deja clos : refusee", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    expect(b.session.finEvenement("inconnu")).toMatchObject({ ok: false, refus: "EVENEMENT_INCONNU" });
    const d = b.session.debutEvenement("X");
    if (!d.ok) throw new Error("debut");
    b.horloge.avancer(5000);
    b.session.finEvenement(d.evenement.id);
    expect(b.session.finEvenement(d.evenement.id)).toMatchObject({ ok: false, refus: "EVENEMENT_NON_OUVERT" });
  });

  it("couverture GNSS faible : l'evenement est clos AVEC un avertissement, il n'est pas jete", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    const d = b.session.debutEvenement("ETAT_CHAUSSEE");
    if (!d.ok) throw new Error("debut");
    // 30 s sans echantillon (tunnel, perte du signal), puis la fin.
    b.horloge.fixer(T0 + 40_000);
    b.session.finEvenement(d.evenement.id);
    const ev = b.session.etat.evenements[0];
    expect(ev.statut).toBe("CLOS");
    expect(ev.couvertureGnss).toBeLessThan(0.8);
    expect(ev.avertissements).toContain("COUVERTURE_GNSS_FAIBLE");
  });

  it("evenement immobile (debut et fin au meme endroit) : avertissement EVENEMENT_IMMOBILE", () => {
    const b = demarrerBanc();
    for (let s = 0; s <= 20; s += 1) { b.horloge.fixer(T0 + s * 1000); b.session.ajouterEchantillon(echantillon(0, 0, { tMs: T0 + s * 1000, vitesseMs: 0 })); }
    b.horloge.fixer(T0 + 5000);
    const d = b.session.debutEvenement("ETAT_CHAUSSEE");
    if (!d.ok) throw new Error("debut");
    b.horloge.fixer(T0 + 20_000);
    b.session.finEvenement(d.evenement.id);
    expect(b.session.etat.evenements[0].avertissements).toContain("EVENEMENT_IMMOBILE");
  });

  it("l'arret avec un evenement ouvert est REFUSE par defaut, avec la liste des ouverts, et l'etat n'a pas bouge", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    const d = b.session.debutEvenement("ETAT_CHAUSSEE");
    if (!d.ok) throw new Error("debut");
    const r = b.session.arreter();
    expect(r).toMatchObject({ ok: false, refus: "EVENEMENTS_OUVERTS", ouverts: [d.evenement.id] });
    expect(b.session.etat.statut).toBe("EN_COURS");
    expect(b.session.etat.finMs).toBeNull();
  });

  it("arret avec la politique CLORE : fin = instant d'arret, statut CLOS_PAR_ARRET ; un evenement invalide est abandonne avec son motif", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    const bon = b.session.debutEvenement("ETAT_CHAUSSEE");
    alimenter(b, 11, 30);
    const nul = b.session.debutEvenement("PRATICABILITE");
    if (!bon.ok || !nul.ok) throw new Error("debut");
    const r = b.session.arreter("CLORE");
    expect(r).toMatchObject({ ok: true, clos: [bon.evenement.id], abandonnes: [nul.evenement.id] });
    const [e1, e2] = b.session.etat.evenements;
    expect(e1.statut).toBe("CLOS_PAR_ARRET");
    expect(e1.fin?.tMs).toBe(T0 + 30_000);
    expect(e2.statut).toBe("ABANDONNE");
    expect(e2.motifAbandon).toBe("ARRET_DUREE_NULLE");
  });

  it("arret avec la politique ABANDONNER : aucun evenement n'est clos", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    const d = b.session.debutEvenement("ETAT_CHAUSSEE");
    if (!d.ok) throw new Error("debut");
    alimenter(b, 11, 20);
    expect(b.session.arreter("ABANDONNER")).toMatchObject({ ok: true, clos: [], abandonnes: [d.evenement.id] });
    expect(b.session.etat.evenements[0]).toMatchObject({ statut: "ABANDONNE", motifAbandon: "ABANDONNE_A_L_ARRET" });
  });

  it("la pause est refusee tant qu'un evenement est ouvert ; un evenement abandonne libere la pause", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    const d = b.session.debutEvenement("ETAT_CHAUSSEE");
    if (!d.ok) throw new Error("debut");
    expect(b.session.mettreEnPause()).toMatchObject({ ok: false, refus: "PAUSE_AVEC_EVENEMENT_OUVERT" });
    expect(b.session.abandonnerEvenement(d.evenement.id)).toEqual({ ok: true });
    expect(b.session.abandonnerEvenement(d.evenement.id)).toMatchObject({ ok: false, refus: "EVENEMENT_NON_OUVERT" });
    expect(b.session.mettreEnPause()).toEqual({ ok: true });
  });
});

describe("robustesse (A19) : appel, veille, GNSS, permission, par evenements INJECTES", () => {
  it("appel entrant : la session continue EN_COURS, l'interruption est datee, le trou de trace est enregistre", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 19);
    b.horloge.fixer(T0 + 20_000);
    expect(b.session.signalerSysteme({ type: "APPEL_ENTRANT" })).toEqual({ ok: true });
    expect(b.session.signalerSysteme({ type: "APPEL_ENTRANT" })).toMatchObject({ ok: false, refus: "INTERRUPTION_DEJA_OUVERTE" });
    expect(b.session.etat.statut).toBe("EN_COURS");
    // L'appel dure 45 s, pendant lesquelles le recepteur ne livre rien.
    b.horloge.fixer(T0 + 65_000);
    expect(b.session.signalerSysteme({ type: "APPEL_TERMINE" })).toEqual({ ok: true });
    expect(b.session.signalerSysteme({ type: "APPEL_TERMINE" })).toMatchObject({ ok: false, refus: "INTERRUPTION_NON_OUVERTE" });
    expect(b.session.ajouterEchantillon(echantillon(65))).toMatchObject({ accepte: true, trou: true });
    expect(b.session.etat.interruptions).toEqual([{ cause: "APPEL", debutMs: T0 + 20_000, finMs: T0 + 65_000 }]);
    expect(b.session.etat.trous[0]).toMatchObject({ debutMs: T0 + 19_000, finMs: T0 + 65_000 });
  });

  it("veille : le lot d'echantillons mis en tampon livre au reveil comble le trou, sans fausse alerte d'horloge", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 9);
    b.horloge.fixer(T0 + 10_000);
    b.session.signalerSysteme({ type: "VEILLE_DEBUT" });
    // L'appareil dort 60 s. Au reveil, le recepteur livre les 60 positions accumulees d'un coup.
    b.horloge.fixer(T0 + 70_000);
    b.session.signalerSysteme({ type: "VEILLE_FIN" });
    for (let s = 10; s <= 69; s += 1) {
      expect(b.session.ajouterEchantillon(echantillon(s), { differe: true })).toMatchObject({ accepte: true, trou: false });
    }
    expect(b.session.etat.trous).toHaveLength(0);
    expect(b.session.etat.alertes.filter((a) => a.type === "DERIVE_HORLOGE")).toHaveLength(0);
    expect(b.session.etat.echantillons).toHaveLength(70);
    expect(b.session.etat.interruptions).toEqual([{ cause: "VEILLE", debutMs: T0 + 10_000, finMs: T0 + 70_000 }]);
  });

  it("veille SANS tampon : les 60 s sont un trou qui coupe la trace, et l'interruption l'explique", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 9);
    b.horloge.fixer(T0 + 10_000);
    b.session.signalerSysteme({ type: "VEILLE_DEBUT" });
    b.horloge.fixer(T0 + 70_000);
    b.session.signalerSysteme({ type: "VEILLE_FIN" });
    expect(b.session.ajouterEchantillon(echantillon(70))).toMatchObject({ accepte: true, trou: true, segment: 1 });
    expect(b.session.etat.trous[0]).toMatchObject({ dureeMs: 61_000, coupeSegment: true });
  });

  it("perte de GNSS et permission retiree : interruptions distinctes, closes par leur evenement", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 5);
    b.session.signalerSysteme({ type: "GNSS_INDISPONIBLE" });
    b.session.signalerSysteme({ type: "PERMISSION_RETIREE" });
    b.horloge.avancer(8000);
    b.session.signalerSysteme({ type: "PERMISSION_ACCORDEE" });
    b.session.signalerSysteme({ type: "GNSS_DISPONIBLE" });
    expect(b.session.etat.interruptions.map((i) => [i.cause, i.finMs !== null])).toEqual([["GNSS_PERDU", true], ["PERMISSION_RETIREE", true]]);
  });

  it("un arret pendant une interruption la cloture et le dit (closePar ARRET)", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 5);
    b.session.signalerSysteme({ type: "APPEL_ENTRANT" });
    b.horloge.avancer(3000);
    b.session.arreter();
    expect(b.session.etat.interruptions[0]).toMatchObject({ cause: "APPEL", finMs: T0 + 8000, closePar: "ARRET" });
  });
});

describe("redemarrage : reprise depuis le journal", () => {
  /** Une session riche : echantillons, un marqueur, un evenement clos, un evenement ouvert, une pause, un appel. */
  function sessionRiche() {
    const b = demarrerBanc();
    alimenter(b, 0, 59);
    b.session.poserMarqueur("NID_DE_POULE", { note: "km 12" });
    const clos = b.session.debutEvenement("ETAT_CHAUSSEE");
    alimenter(b, 60, 99);
    if (clos.ok) b.session.finEvenement(clos.evenement.id);
    b.session.mettreEnPause();
    b.horloge.fixer(T0 + 200_000);
    b.session.reprendre();
    alimenter(b, 201, 230);
    b.session.signalerSysteme({ type: "APPEL_ENTRANT" });
    b.horloge.avancer(10_000);
    b.session.signalerSysteme({ type: "APPEL_TERMINE" });
    alimenter(b, 241, 260);
    b.session.debutEvenement("PRATICABILITE");
    alimenter(b, 261, 280);
    return b;
  }

  const empreinte = (s: SessionRoulage) => JSON.stringify({
    statut: s.etat.statut, e: s.etat.echantillons, r: s.etat.rejets, t: s.etat.trous, i: s.etat.interruptions,
    p: s.etat.pauses, m: s.etat.marqueurs, v: s.etat.evenements, a: s.etat.alertes, d: s.etat.dernierInstantMs,
  });

  it("rejouer le journal complet reconstruit EXACTEMENT l'etat (rien ne se perd, rien ne se duplique)", () => {
    const b = sessionRiche();
    const r = SessionRoulage.rejouer(b.journal.entrees, { horloge: b.horloge, genererId: generateurIds(2) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lacunes).toEqual([]);
    expect(r.ignorees).toEqual([]);
    expect(empreinte(r.session)).toBe(empreinte(b.session));
    expect(r.session.etat.sessionId).toBe(b.session.etat.sessionId);
  });

  it("le processus meurt : le journal tronque donne l'etat au dernier ecrit, les entrees perdues sont celles de la fin", () => {
    const b = sessionRiche();
    const total = b.journal.entrees.length;
    const garde = b.journal.tronque(total - 25);
    const r = SessionRoulage.rejouer(garde, { horloge: b.horloge, genererId: generateurIds(2) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lacunes).toEqual([]);
    expect(r.session.etat.echantillons.length).toBeLessThan(b.session.etat.echantillons.length);
    // Tout ce qui est present etait ecrit dans l'ordre : c'est un prefixe de l'etat d'origine.
    expect(b.session.etat.echantillons.slice(0, r.session.etat.echantillons.length)).toEqual(r.session.etat.echantillons);
  });

  it("une lacune de numerotation dans le journal est RAPPORTEE", () => {
    const b = sessionRiche();
    const sans = b.journal.entrees.filter((e) => e.seq !== 50 && e.seq !== 51);
    const r = SessionRoulage.rejouer(sans, { horloge: b.horloge, genererId: generateurIds(2) });
    expect(r.ok && r.lacunes).toEqual([50, 51]);
  });

  it("une entree orpheline (fin d'un evenement dont le debut est perdu) est ignoree en etant dite, pas appliquee", () => {
    const b = sessionRiche();
    const debut = b.journal.entrees.find((e) => e.type === "EVT_DEBUT");
    const sans = b.journal.entrees.filter((e) => e !== debut);
    const r = SessionRoulage.rejouer(sans, { horloge: b.horloge, genererId: generateurIds(2) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ignorees.map((x) => x.raison)).toContain("EVENEMENT_INCONNU");
    expect(r.session.etat.evenements.map((e) => e.code)).toEqual(["PRATICABILITE"]);
  });

  it("reprise : l'intervalle perdu devient une interruption REDEMARRAGE, un nouveau segment s'ouvre, les doublons sont refuses", () => {
    const b = sessionRiche();
    const dernierConnu = b.session.etat.dernierInstantMs;
    // Le processus est tue ; 90 s plus tard l'application redemarre.
    const horloge2 = horlogeSimulee(dernierConnu + 90_000);
    const journal2 = new JournalMemoire();
    const r = SessionRoulage.rejouer(b.journal.entrees, { horloge: horloge2, genererId: generateurIds(3), journal: journal2.sink });
    if (!r.ok) throw new Error("rejeu");
    const s = r.session;
    const reprise = s.reprendreApresRedemarrage();
    expect(reprise).toEqual({ ok: true, applique: true, dureeInconnueMs: 90_000 });
    expect(s.etat.interruptions.at(-1)).toEqual({ cause: "REDEMARRAGE", debutMs: dernierConnu, finMs: dernierConnu + 90_000 });
    expect(s.etat.statut).toBe("EN_COURS");

    // Le recepteur livre a nouveau les derniers echantillons deja ecrits : ils sont refuses, pas dupliques.
    const avant = s.etat.echantillons.length;
    expect(s.ajouterEchantillon(echantillon(280), { differe: true })).toEqual({ accepte: false, motif: "HORODATAGE_DOUBLON" });
    expect(s.ajouterEchantillon(echantillon(270), { differe: true })).toEqual({ accepte: false, motif: "HORODATAGE_RECULE" });
    expect(s.etat.echantillons).toHaveLength(avant);

    // Le premier echantillon neuf ouvre un nouveau segment : les deux cotes de l'inconnu ne sont pas relies.
    horloge2.fixer(T0 + 370_000);
    expect(s.ajouterEchantillon(echantillon(370))).toMatchObject({ accepte: true, segment: b.session.etat.segmentCourant + 1, trou: true });
    expect(s.etat.echantillons.at(-1)!.segment).toBe(b.session.etat.segmentCourant + 1);

    // La numerotation continue sans collision : un second rejeu du journal cumule redonne le meme etat.
    const cumul = [...b.journal.entrees, ...journal2.entrees];
    expect(new Set(cumul.map((e) => e.seq)).size).toBe(cumul.length);
    const r2 = SessionRoulage.rejouer(cumul, { horloge: horloge2, genererId: generateurIds(4) });
    expect(r2.ok && empreinte(r2.session)).toBe(empreinte(s));
  });

  it("un evenement ouvert au moment du crash reste ouvert apres la reprise, se cloture, et signale avoir traverse le redemarrage", () => {
    const b = sessionRiche();
    const ouvert = b.session.etat.evenements.find((e) => e.statut === "OUVERT")!;
    const horloge2 = horlogeSimulee(b.session.etat.dernierInstantMs + 30_000);
    const r = SessionRoulage.rejouer(b.journal.entrees, { horloge: horloge2, genererId: generateurIds(3) });
    if (!r.ok) throw new Error("rejeu");
    r.session.reprendreApresRedemarrage();
    expect(r.session.etat.evenements.find((e) => e.id === ouvert.id)?.statut).toBe("OUVERT");
    horloge2.avancer(20_000);
    expect(r.session.finEvenement(ouvert.id).ok).toBe(true);
    expect(r.session.etat.evenements.find((e) => e.id === ouvert.id)?.avertissements).toContain("TRAVERSE_REDEMARRAGE");
  });

  it("les interruptions du systeme encore ouvertes au crash sont closes au redemarrage (closePar REDEMARRAGE)", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 20);
    b.session.signalerSysteme({ type: "VEILLE_DEBUT" });
    const horloge2 = horlogeSimulee(T0 + 300_000);
    const r = SessionRoulage.rejouer(b.journal.entrees, { horloge: horloge2, genererId: generateurIds(3) });
    if (!r.ok) throw new Error("rejeu");
    r.session.reprendreApresRedemarrage();
    expect(r.session.etat.interruptions[0]).toMatchObject({ cause: "VEILLE", finMs: T0 + 300_000, closePar: "REDEMARRAGE" });
  });

  it("session EN_PAUSE au crash : elle reste en pause apres la reprise ; session arretee : rien n'est applique", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    b.session.mettreEnPause();
    const h = horlogeSimulee(T0 + 100_000);
    const r = SessionRoulage.rejouer(b.journal.entrees, { horloge: h, genererId: generateurIds(3) });
    if (!r.ok) throw new Error("rejeu");
    r.session.reprendreApresRedemarrage();
    expect(r.session.etat.statut).toBe("EN_PAUSE");

    const c = demarrerBanc();
    alimenter(c, 0, 10);
    c.session.arreter();
    const r3 = SessionRoulage.rejouer(c.journal.entrees, { horloge: h, genererId: generateurIds(3) });
    if (!r3.ok) throw new Error("rejeu");
    expect(r3.session.reprendreApresRedemarrage()).toEqual({ ok: true, applique: false, dureeInconnueMs: 0 });
    expect(r3.session.etat.statut).toBe("ARRETEE");
  });

  it("redemarrage avec un trou COURT (20 s, sous le seuil de coupure de 30 s) : la trace est coupee quand meme, et des echantillons redonnes AVANT le trou ne coupent rien", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 100);
    const h = horlogeSimulee(T0 + 120_000);
    const r = SessionRoulage.rejouer(b.journal.tronque(b.journal.entrees.length - 2), { horloge: h, genererId: generateurIds(3) });
    if (!r.ok) throw new Error("rejeu");
    const s = r.session;
    s.reprendreApresRedemarrage();
    // Le plugin redonne les 5 derniers echantillons : trois sont deja au journal, deux avaient ete perdus.
    const redonnes = [96, 97, 98, 99, 100].map((i) => s.ajouterEchantillon(echantillon(i), { differe: true }));
    expect(redonnes.map((x) => x.accepte)).toEqual([false, false, false, true, true]);
    expect(redonnes.filter((x) => x.accepte).every((x) => x.accepte && x.segment === 0 && !x.trou)).toBe(true);
    // Puis rien pendant 20 s : le premier echantillon qui suit ouvre un nouveau segment.
    expect(s.ajouterEchantillon(echantillon(120))).toMatchObject({ accepte: true, segment: 1, trou: true });
    expect(s.etat.trous.at(-1)).toMatchObject({ dureeMs: 20_000, coupeSegment: true });
    expect(s.etat.echantillons).toHaveLength(102);
  });

  it("pause courte (8 s, sous le seuil de coupure) : la trace est coupee, sans trou enregistre", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    b.session.mettreEnPause();
    b.horloge.fixer(T0 + 18_000);
    b.session.reprendre();
    expect(b.session.ajouterEchantillon(echantillon(18))).toMatchObject({ accepte: true, segment: 1, trou: false });
    expect(b.session.etat.trous).toHaveLength(0);
  });

  it("horloge en arriere au redemarrage : alerte, et la duree inconnue n'est jamais negative", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 20);
    const h = horlogeSimulee(T0 + 5000);
    const r = SessionRoulage.rejouer(b.journal.entrees, { horloge: h, genererId: generateurIds(3) });
    if (!r.ok) throw new Error("rejeu");
    expect(r.session.reprendreApresRedemarrage()).toMatchObject({ applique: true, dureeInconnueMs: 0 });
    expect(r.session.etat.alertes.map((a) => a.type)).toContain("DERIVE_HORLOGE");
    expect(r.session.etat.interruptions.at(-1)!.finMs! >= r.session.etat.interruptions.at(-1)!.debutMs).toBe(true);
  });

  it("refuse de rejouer un journal vide, sans demarrage, ou d'une version inconnue", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 3);
    const opts = { horloge: b.horloge, genererId: generateurIds(2) };
    expect(SessionRoulage.rejouer([], opts)).toEqual({ ok: false, raison: "JOURNAL_VIDE" });
    expect(SessionRoulage.rejouer(b.journal.entrees.slice(1), opts)).toEqual({ ok: false, raison: "DEMARRAGE_ABSENT" });
    const autre = b.journal.entrees.map((e) => (e.type === "DEMARRAGE" ? { ...e, versionJournal: VERSION_JOURNAL + 1 } : e));
    expect(SessionRoulage.rejouer(autre, opts)).toEqual({ ok: false, raison: "VERSION_JOURNAL_INCONNUE" });
  });

  it("le journal NDJSON se relit ; une derniere ligne coupee en pleine ecriture est detectee, jamais ignoree", () => {
    const b = sessionRiche();
    const lignes = b.journal.entrees.map(serialiserEntree);
    const relues = lignes.map(lireEntree);
    expect(relues.every((l) => l.ok)).toBe(true);
    const coupee = lignes[lignes.length - 1].slice(0, 20);
    expect(lireEntree(coupee)).toEqual({ ok: false, raison: "JSON_ILLISIBLE" });
    expect(lireEntree('{"type":"X"}')).toEqual({ ok: false, raison: "SEQ_INVALIDE" });
    expect(lireEntree("[]")).toMatchObject({ ok: false });
    const rejoue = SessionRoulage.rejouer(relues.flatMap((l) => (l.ok ? [l.entree] : [])), { horloge: b.horloge, genererId: generateurIds(2) });
    expect(rejoue.ok && empreinte(rejoue.session)).toBe(empreinte(b.session));
  });
});

describe("couvertureDe", () => {
  const etat = (instants: number[], segment = 0) => ({
    parametres: PARAMETRES_PROVISOIRES as typeof PARAMETRES_PROVISOIRES,
    echantillons: instants.map((s) => ({ ...echantillon(s), segment })),
  });
  it("1 quand la trace est continue, 0 sur une duree nulle", () => {
    expect(couvertureDe(etat([0, 1, 2, 3, 4, 5]), T0 + 1000, T0 + 5000)).toBeCloseTo(1, 9);
    expect(couvertureDe(etat([0, 1, 2]), T0 + 1000, T0 + 1000)).toBe(0);
  });
  it("un trou plus long que le seuil n'est pas couvert", () => {
    expect(couvertureDe(etat([0, 1, 2, 30, 31]), T0, T0 + 31_000)).toBeCloseTo(3 / 31, 6);
  });
  it("deux segments differents ne se couvrent pas l'un l'autre", () => {
    const e = etat([0, 1, 2]);
    e.echantillons.push({ ...echantillon(3), segment: 1 }, { ...echantillon(4), segment: 1 });
    expect(couvertureDe(e, T0, T0 + 4000)).toBeCloseTo(3 / 4, 6);
  });
});
