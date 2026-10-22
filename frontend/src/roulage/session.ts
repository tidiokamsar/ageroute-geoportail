/**
 * Session de roulage : la machine a etats (demarrer, pause, reprise, arret, reprise apres redemarrage).
 *
 * CE QUE CE MODULE EST, ET CE QU'IL N'EST PAS
 *
 * C'est la LOGIQUE d'une collecte en vehicule, sans aucune dependance a un appareil : positions GNSS
 * injectees par l'hote, horloge injectee, journal injecte. Elle est testee sous Node avec des
 * evenements simules. Elle NE PROUVE PAS ce qui depend du telephone : latence reelle du geste, qualite
 * du GNSS, survie du service de premier plan a la veille, comportement a l'appel entrant, a la
 * batterie. Ces points sont listes dans docs/roulage/COLLECTE-ROULAGE.md avec le statut
 * « NON VERIFIE sur appareil ».
 *
 * MACHINE A ETATS
 *
 *     EN_COURS --pause--> EN_PAUSE --reprise--> EN_COURS
 *     EN_COURS | EN_PAUSE --arret--> ARRETEE        (etat final)
 *
 * Un appel entrant, une veille, une perte du GNSS NE CHANGENT PAS l'etat : le service de premier plan
 * continue (c'est la these de l'ADR-009) ; ils ouvrent une INTERRUPTION datee, et les trous de la trace
 * qui en resultent sont enregistres. Un redemarrage du processus est rejoue depuis le journal.
 */
import { appliquerEntree, dernierEchantillon, etatInitial, interruptionOuverte, type EtatSession } from "./etat";
import { evaluerEchantillon } from "./filtre";
import { distanceM } from "./geodesie";
import type { Horloge } from "./horloge";
import { VERSION_JOURNAL, type CorpsEntree, type EntreeJournal, type SinkJournal } from "./journal";
import { validerParametres, type ParametresRoulage } from "./parametres";
import type {
  CauseInterruption, EchantillonGnss, EvenementLineaire, EvenementSysteme, Marqueur, MotifRejet, Qualification, Repere,
} from "./types";

export const CODE_VALIDE = /^[A-Z0-9_]{1,40}$/;
export const NOTE_MAX = 500;

export type RefusSession =
  | "CODE_INVALIDE"
  | "NOTE_TROP_LONGUE"
  | "SESSION_NON_EN_COURS"
  | "SESSION_ARRETEE"
  | "DEJA_EN_PAUSE"
  | "PAS_EN_PAUSE"
  | "PAUSE_AVEC_EVENEMENT_OUVERT"
  | "EVENEMENT_DEJA_OUVERT"
  | "EVENEMENT_INCONNU"
  | "EVENEMENT_NON_OUVERT"
  | "FIN_AVANT_DEBUT"
  | "DUREE_NULLE"
  | "DUREE_TROP_COURTE"
  | "EVENEMENTS_OUVERTS"
  | "INTERRUPTION_DEJA_OUVERTE"
  | "INTERRUPTION_NON_OUVERTE";

export type Refus = { ok: false; refus: RefusSession; message: string };
const refuser = (refus: RefusSession, message: string): Refus => ({ ok: false, refus, message });

export interface OptionsSession {
  horloge: Horloge;
  /** Identifiants uuid generes par l'hote (`crypto.randomUUID`). Injecte pour des tests deterministes. */
  genererId: () => string;
  parametres?: Partial<ParametresRoulage>;
  journal?: SinkJournal;
  agentRef?: string | null;
}

export type ResultatEchantillon =
  | { accepte: true; segment: number; trou: boolean; alertes: string[] }
  | { accepte: false; motif: MotifRejet };

export type ResultatMarqueur =
  | { ok: true; marqueur: Marqueur; latenceTotaleMs: number; depasseBudget: boolean; journalise: boolean }
  | Refus;

export type PolitiqueEvenementsOuverts = "REFUSER" | "CLORE" | "ABANDONNER";

export type ResultatRejeu =
  | { ok: false; raison: "JOURNAL_VIDE" | "DEMARRAGE_ABSENT" | "VERSION_JOURNAL_INCONNUE" }
  | {
      ok: true;
      session: SessionRoulage;
      /** Numeros de sequence manquants entre 1 et le dernier lu. */
      lacunes: number[];
      ignorees: { seq: number; raison: string }[];
    };

export interface ResumeSession {
  statut: EtatSession["statut"];
  echantillons: number;
  rejetsTotal: number;
  rejets: EtatSession["rejets"];
  trous: number;
  dureeTrousMs: number;
  interruptions: number;
  pauses: number;
  marqueurs: number;
  evenementsOuverts: number;
  evenementsClos: number;
  evenementsAbandonnes: number;
  segments: number;
  distanceM: number;
  alertes: number;
  echecsJournal: number;
}

export class SessionRoulage {
  private seq: number;
  private echecsJournal = 0;

  private constructor(
    private readonly etatInterne: EtatSession,
    private readonly opts: OptionsSession,
    seqDepart: number,
  ) {
    this.seq = seqDepart;
  }

  /** Vue en lecture de l'etat. Ne pas le modifier : seules les commandes ci-dessous le font. */
  get etat(): Readonly<EtatSession> { return this.etatInterne; }

  // ---------------------------------------------------------------- creation

  static demarrer(opts: OptionsSession): { ok: true; session: SessionRoulage } | { ok: false; erreurs: string[] } {
    const v = validerParametres(opts.parametres ?? {});
    if (!v.ok) return { ok: false, erreurs: v.erreurs };
    const tMs = opts.horloge.maintenantMs();
    const sessionId = opts.genererId();
    const etat = etatInitial({ sessionId, parametres: v.parametres, agentRef: opts.agentRef ?? null, debutMs: tMs });
    const session = new SessionRoulage(etat, opts, 0);
    session.ecrire({ type: "DEMARRAGE", tMs, sessionId, parametres: v.parametres, agentRef: opts.agentRef ?? null, versionJournal: VERSION_JOURNAL });
    return { ok: true, session };
  }

  /**
   * Reconstruit une session depuis son journal, apres un redemarrage (ou un crash).
   *
   * Le journal peut etre TRONQUE (le processus est mort avant d'ecrire les dernieres entrees) ou
   * presenter des LACUNES. Les deux sont rapportes. Pour poursuivre la collecte, appeler ensuite
   * `reprendreApresRedemarrage()`.
   */
  static rejouer(entrees: readonly EntreeJournal[], opts: Omit<OptionsSession, "parametres" | "agentRef">): ResultatRejeu {
    if (entrees.length === 0) return { ok: false, raison: "JOURNAL_VIDE" };
    const tries = [...entrees].sort((a, b) => a.seq - b.seq);
    const premier = tries[0];
    if (premier.type !== "DEMARRAGE" || premier.seq !== 1) return { ok: false, raison: "DEMARRAGE_ABSENT" };
    if (premier.versionJournal !== VERSION_JOURNAL) return { ok: false, raison: "VERSION_JOURNAL_INCONNUE" };

    const etat = etatInitial({
      sessionId: premier.sessionId, parametres: premier.parametres, agentRef: premier.agentRef, debutMs: premier.tMs,
    });
    const ignorees: { seq: number; raison: string }[] = [];
    const lacunes: number[] = [];
    let attendu = 2;
    let dernier = 1;
    for (const e of tries.slice(1)) {
      if (e.seq < attendu) { ignorees.push({ seq: e.seq, raison: "SEQ_EN_DOUBLE" }); continue; }
      for (let manquant = attendu; manquant < e.seq; manquant += 1) lacunes.push(manquant);
      attendu = e.seq + 1;
      dernier = e.seq;
      const raison = appliquerEntree(etat, e);
      if (raison) ignorees.push({ seq: e.seq, raison });
    }
    etat.dernierSeq = dernier;
    const session = new SessionRoulage(etat, { ...opts, parametres: premier.parametres, agentRef: premier.agentRef }, dernier);
    return { ok: true, session, lacunes, ignorees };
  }

  // ---------------------------------------------------------------- echantillons

  /**
   * Recoit un echantillon GNSS. `differe` : l'hote livre un lot mis en tampon pendant une veille.
   * Un echantillon ecarte est COMPTE par motif et n'entre jamais dans la trace.
   */
  ajouterEchantillon(e: EchantillonGnss, options: { differe?: boolean } = {}): ResultatEchantillon {
    const etat = this.etatInterne;
    const p = etat.parametres;
    if (etat.statut !== "EN_COURS") {
      this.ecrire({ type: "REJET", tMs: e.tMs, motif: "SESSION_NON_EN_COURS", sautsConsecutifs: etat.sautsConsecutifs, identiquesConsecutifs: etat.identiquesConsecutifs });
      return { accepte: false, motif: "SESSION_NON_EN_COURS" };
    }
    const d = dernierEchantillon(etat);
    const v = evaluerEchantillon(e, { dernier: d, sautsConsecutifs: etat.sautsConsecutifs, identiquesConsecutifs: etat.identiquesConsecutifs }, p, this.opts.horloge.maintenantMs(), options.differe ?? false);
    if (!v.accepte) {
      this.ecrire({ type: "REJET", tMs: Number.isFinite(e.tMs) ? e.tMs : etat.dernierInstantMs, motif: v.motif, sautsConsecutifs: v.sautsConsecutifs, identiquesConsecutifs: v.identiquesConsecutifs });
      return { accepte: false, motif: v.motif };
    }

    let trou = null;
    let segment = d ? d.segment : 0;
    if (d) {
      const ecart = e.tMs - d.tMs;
      // Un ecart situe dans une pause voulue n'est pas un trou : l'agent a arrete d'enregistrer.
      const pause = etat.pauses.some((x) => x.debutMs >= d.tMs && x.debutMs <= e.tMs);
      if (ecart > p.trouMs && !pause) trou = { debutMs: d.tMs, finMs: e.tMs, dureeMs: ecart, coupeSegment: ecart > p.coupureSegmentMs };
      if (etat.nouveauSegmentAuProchain || ecart > p.coupureSegmentMs) segment = d.segment + 1;
    }
    this.ecrire({
      type: "ECHANTILLON", echantillon: e, segment, trou, alertes: v.alertes, ecartHorlogeMs: v.ecartHorlogeMs,
      sautsConsecutifs: v.sautsConsecutifs, identiquesConsecutifs: v.identiquesConsecutifs,
    });
    return { accepte: true, segment, trou: trou !== null, alertes: v.alertes };
  }

  // ---------------------------------------------------------------- marqueur

  /**
   * Pose un marqueur d'evenement ponctuel.
   *
   * L'INSTANT DU GESTE EST LU EN PREMIER, avant toute autre operation : ni la construction du marqueur
   * ni l'ecriture du journal ne le decalent. La position est celle du DERNIER fix recu (lecture O(1)),
   * accompagnee de l'anciennete de ce fix : le serveur peut ainsi retrouver la position exacte dans la
   * trace plutot que de se fier a un fix peut-etre perime.
   *
   * La fonction est SYNCHRONE et ne fait aucun acces reseau ni disque autre que le rappel de journal.
   * Son cout logiciel est mesurable ; la latence percue (du doigt a l'affichage) ne l'est que sur appareil.
   */
  poserMarqueur(code: string, options: { note?: string | null; id?: string } = {}): ResultatMarqueur {
    const t0 = this.opts.horloge.perfMs();
    const tMs = this.opts.horloge.maintenantMs();
    const etat = this.etatInterne;
    if (etat.statut === "ARRETEE") return refuser("SESSION_ARRETEE", "La session est arretee.");
    if (etat.statut !== "EN_COURS") return refuser("SESSION_NON_EN_COURS", "La session est en pause : reprendre avant de poser un marqueur.");
    const invalide = this.verifierCodeEtNote(code, options.note);
    if (invalide) return invalide;

    const marqueur: Marqueur = {
      id: options.id ?? this.opts.genererId(),
      code,
      note: options.note ?? null,
      repere: this.repereA(tMs),
      latenceLogicielleMs: 0,
    };
    marqueur.latenceLogicielleMs = Math.max(0, this.opts.horloge.perfMs() - t0);
    const journalise = this.ecrire({ type: "MARQUEUR", marqueur });
    const latenceTotaleMs = Math.max(0, this.opts.horloge.perfMs() - t0);
    return {
      ok: true, marqueur, latenceTotaleMs, journalise,
      depasseBudget: latenceTotaleMs > etat.parametres.budgetLatenceLogicielleMs,
    };
  }

  // ---------------------------------------------------------------- evenement lineaire

  /** Ouvre un evenement lineaire (« Debut »). Un seul evenement ouvert par code. */
  debutEvenement(code: string, options: { note?: string | null; qualification?: Qualification | null; id?: string } = {}):
    { ok: true; evenement: EvenementLineaire } | Refus {
    const tMs = this.opts.horloge.maintenantMs();
    const etat = this.etatInterne;
    if (etat.statut === "ARRETEE") return refuser("SESSION_ARRETEE", "La session est arretee.");
    if (etat.statut !== "EN_COURS") return refuser("SESSION_NON_EN_COURS", "La session est en pause : reprendre avant d'ouvrir un evenement.");
    const invalide = this.verifierCodeEtNote(code, options.note);
    if (invalide) return invalide;
    if (etat.evenements.some((x) => x.statut === "OUVERT" && x.code === code)) {
      return refuser("EVENEMENT_DEJA_OUVERT", `Un evenement ${code} est deja ouvert : le clore ou l'abandonner d'abord.`);
    }
    const evenement: EvenementLineaire = {
      id: options.id ?? this.opts.genererId(),
      code,
      note: options.note ?? null,
      qualification: options.qualification ?? null,
      statut: "OUVERT",
      debut: this.repereA(tMs),
      fin: null,
      couvertureGnss: null,
      distanceDirecteM: null,
      avertissements: [],
      motifAbandon: null,
    };
    this.ecrire({ type: "EVT_DEBUT", evenement });
    return { ok: true, evenement };
  }

  /**
   * Cloture un evenement lineaire (« Fin »).
   *
   * REFUSES, l'evenement restant OUVERT : fin avant debut (horloge reculee), duree nulle, duree
   * inferieure au minimum. Un evenement valide mais mal couvert par le GNSS, ou immobile, est CLOS avec
   * un avertissement : le serveur en decidera, le noyau ne jette pas une saisie de l'agent.
   */
  finEvenement(id: string): { ok: true; evenement: EvenementLineaire } | Refus {
    const tMs = this.opts.horloge.maintenantMs();
    const etat = this.etatInterne;
    if (etat.statut === "ARRETEE") return refuser("SESSION_ARRETEE", "La session est arretee.");
    if (etat.statut !== "EN_COURS") return refuser("SESSION_NON_EN_COURS", "La session est en pause.");
    const ev = etat.evenements.find((x) => x.id === id);
    if (!ev) return refuser("EVENEMENT_INCONNU", "Evenement inconnu.");
    if (ev.statut !== "OUVERT") return refuser("EVENEMENT_NON_OUVERT", "Cet evenement n'est plus ouvert.");
    const r = this.preparerCloture(ev, tMs, "CLOS");
    if (!r.ok) return r;
    this.ecrire(r.corps);
    return { ok: true, evenement: ev };
  }

  /** Abandonne un evenement ouvert : il est conserve dans la session avec son motif, jamais envoye comme portion. */
  abandonnerEvenement(id: string, motif = "ABANDONNE_PAR_AGENT"): { ok: true } | Refus {
    const etat = this.etatInterne;
    if (etat.statut === "ARRETEE") return refuser("SESSION_ARRETEE", "La session est arretee.");
    const ev = etat.evenements.find((x) => x.id === id);
    if (!ev) return refuser("EVENEMENT_INCONNU", "Evenement inconnu.");
    if (ev.statut !== "OUVERT") return refuser("EVENEMENT_NON_OUVERT", "Cet evenement n'est plus ouvert.");
    this.ecrire({ type: "EVT_ABANDON", id, tMs: this.opts.horloge.maintenantMs(), motif });
    return { ok: true };
  }

  // ---------------------------------------------------------------- cycle de vie

  mettreEnPause(): { ok: true } | Refus {
    const etat = this.etatInterne;
    if (etat.statut === "ARRETEE") return refuser("SESSION_ARRETEE", "La session est arretee.");
    if (etat.statut === "EN_PAUSE") return refuser("DEJA_EN_PAUSE", "La session est deja en pause.");
    // Une pause coupe la trace : un evenement qui la traverserait serait mesure sur un trajet non enregistre.
    if (etat.evenements.some((x) => x.statut === "OUVERT")) {
      return refuser("PAUSE_AVEC_EVENEMENT_OUVERT", "Clore ou abandonner les evenements ouverts avant la pause.");
    }
    this.ecrire({ type: "PAUSE", tMs: this.opts.horloge.maintenantMs() });
    return { ok: true };
  }

  reprendre(): { ok: true } | Refus {
    const etat = this.etatInterne;
    if (etat.statut === "ARRETEE") return refuser("SESSION_ARRETEE", "La session est arretee.");
    if (etat.statut !== "EN_PAUSE") return refuser("PAS_EN_PAUSE", "La session n'est pas en pause.");
    this.ecrire({ type: "REPRISE", tMs: this.opts.horloge.maintenantMs() });
    return { ok: true };
  }

  /**
   * Arrete la session. Par defaut (`REFUSER`), un evenement lineaire encore ouvert EMPECHE l'arret :
   * le clore a l'instant de l'arret reviendrait a inventer l'endroit ou il s'est termine. L'appelant
   * choisit explicitement `CLORE` (fin = instant d'arret, marque CLOS_PAR_ARRET) ou `ABANDONNER`.
   */
  arreter(politique: PolitiqueEvenementsOuverts = "REFUSER"):
    { ok: true; clos: string[]; abandonnes: string[] } | (Refus & { ouverts?: string[] }) {
    const etat = this.etatInterne;
    if (etat.statut === "ARRETEE") return refuser("SESSION_ARRETEE", "La session est deja arretee.");
    const ouverts = etat.evenements.filter((x) => x.statut === "OUVERT");
    if (ouverts.length > 0 && politique === "REFUSER") {
      return { ...refuser("EVENEMENTS_OUVERTS", `${ouverts.length} evenement(s) lineaire(s) encore ouvert(s) : les clore, les abandonner, ou choisir une politique.`), ouverts: ouverts.map((x) => x.id) };
    }
    const tMs = this.opts.horloge.maintenantMs();
    const clos: string[] = [];
    const abandonnes: string[] = [];
    for (const ev of ouverts) {
      if (politique === "CLORE") {
        const r = this.preparerCloture(ev, tMs, "CLOS_PAR_ARRET");
        if (r.ok) { this.ecrire(r.corps); clos.push(ev.id); continue; }
        this.ecrire({ type: "EVT_ABANDON", id: ev.id, tMs, motif: `ARRET_${r.refus}` });
      } else {
        this.ecrire({ type: "EVT_ABANDON", id: ev.id, tMs, motif: "ABANDONNE_A_L_ARRET" });
      }
      abandonnes.push(ev.id);
    }
    this.ecrire({ type: "ARRET", tMs });
    return { ok: true, clos, abandonnes };
  }

  // ---------------------------------------------------------------- systeme

  /** Appel entrant, veille, perte du GNSS, permission retiree : datees, sans changer l'etat de la session. */
  signalerSysteme(evt: EvenementSysteme): { ok: true } | Refus {
    const etat = this.etatInterne;
    if (etat.statut === "ARRETEE") return refuser("SESSION_ARRETEE", "La session est arretee.");
    const table: Record<EvenementSysteme["type"], { cause: CauseInterruption; debut: boolean }> = {
      APPEL_ENTRANT: { cause: "APPEL", debut: true },
      APPEL_TERMINE: { cause: "APPEL", debut: false },
      VEILLE_DEBUT: { cause: "VEILLE", debut: true },
      VEILLE_FIN: { cause: "VEILLE", debut: false },
      GNSS_INDISPONIBLE: { cause: "GNSS_PERDU", debut: true },
      GNSS_DISPONIBLE: { cause: "GNSS_PERDU", debut: false },
      PERMISSION_RETIREE: { cause: "PERMISSION_RETIREE", debut: true },
      PERMISSION_ACCORDEE: { cause: "PERMISSION_RETIREE", debut: false },
    };
    const { cause, debut } = table[evt.type];
    const ouverte = interruptionOuverte(etat, cause) !== null;
    if (debut && ouverte) return refuser("INTERRUPTION_DEJA_OUVERTE", `Une interruption ${cause} est deja ouverte.`);
    if (!debut && !ouverte) return refuser("INTERRUPTION_NON_OUVERTE", `Aucune interruption ${cause} n'est ouverte.`);
    const tMs = this.opts.horloge.maintenantMs();
    this.ecrire(debut ? { type: "INTERRUPTION_DEBUT", cause, tMs } : { type: "INTERRUPTION_FIN", cause, tMs });
    return { ok: true };
  }

  /**
   * A appeler APRES `rejouer`, quand le processus a redemarre. Enregistre l'intervalle entre le dernier
   * instant connu du journal et maintenant comme interruption REDEMARRAGE, et force un nouveau segment :
   * on ne sait pas ce qui s'est passe pendant ce temps, donc on ne relie pas les deux cotes.
   * Une session arretee n'est pas reprise.
   */
  reprendreApresRedemarrage(): { ok: true; applique: boolean; dureeInconnueMs: number } {
    const etat = this.etatInterne;
    if (etat.statut === "ARRETEE") return { ok: true, applique: false, dureeInconnueMs: 0 };
    const tMs = this.opts.horloge.maintenantMs();
    const dernierMs = etat.dernierInstantMs;
    if (tMs < dernierMs) {
      this.ecrire({ type: "ALERTE", alerte: { type: "DERIVE_HORLOGE", tMs, detail: "horloge en arriere du journal au redemarrage" } });
    }
    this.ecrire({ type: "REDEMARRAGE", tMs, dernierMs });
    return { ok: true, applique: true, dureeInconnueMs: Math.max(0, tMs - dernierMs) };
  }

  // ---------------------------------------------------------------- lecture

  resume(): ResumeSession {
    const etat = this.etatInterne;
    let dureeTrousMs = 0;
    for (const t of etat.trous) dureeTrousMs += t.dureeMs;
    let dist = 0;
    for (let i = 1; i < etat.echantillons.length; i += 1) {
      const a = etat.echantillons[i - 1];
      const b = etat.echantillons[i];
      if (a.segment === b.segment) dist += distanceM(a, b);
    }
    const segments = etat.echantillons.length === 0 ? 0 : etat.echantillons[etat.echantillons.length - 1].segment + 1;
    const nb = (s: EvenementLineaire["statut"][]) => etat.evenements.filter((x) => s.includes(x.statut)).length;
    return {
      statut: etat.statut,
      echantillons: etat.echantillons.length,
      rejetsTotal: Object.values(etat.rejets).reduce((a, b) => a + b, 0),
      rejets: { ...etat.rejets },
      trous: etat.trous.length,
      dureeTrousMs,
      interruptions: etat.interruptions.length,
      pauses: etat.pauses.length,
      marqueurs: etat.marqueurs.length,
      evenementsOuverts: nb(["OUVERT"]),
      evenementsClos: nb(["CLOS", "CLOS_PAR_ARRET"]),
      evenementsAbandonnes: nb(["ABANDONNE"]),
      segments,
      distanceM: Math.round(dist),
      alertes: etat.alertesTotal,
      echecsJournal: this.echecsJournal,
    };
  }

  // ---------------------------------------------------------------- interne

  private verifierCodeEtNote(code: string, note: string | null | undefined): Refus | null {
    if (!CODE_VALIDE.test(code)) return refuser("CODE_INVALIDE", "Le code doit etre en majuscules, chiffres et _ (1 a 40 caracteres), issu d'un referentiel.");
    if (note != null && note.length > NOTE_MAX) return refuser("NOTE_TROP_LONGUE", `La note depasse ${NOTE_MAX} caracteres.`);
    return null;
  }

  /** Position connue a l'instant `tMs` : dernier fix et son anciennete. O(1). */
  private repereA(tMs: number): Repere {
    const etat = this.etatInterne;
    const f = dernierEchantillon(etat);
    const sansPosition = interruptionOuverte(etat, "GNSS_PERDU") !== null || interruptionOuverte(etat, "PERMISSION_RETIREE") !== null;
    if (!f) {
      return { tMs, lat: null, lon: null, precisionM: null, ageFixMs: null, vitesseMs: null, positionPerimee: true };
    }
    const age = Math.max(0, tMs - f.tMs);
    return {
      tMs, lat: f.lat, lon: f.lon, precisionM: f.precisionM, ageFixMs: age, vitesseMs: f.vitesseMs,
      positionPerimee: sansPosition || age > etat.parametres.ageFixMaxMarqueurMs,
    };
  }

  private preparerCloture(
    ev: EvenementLineaire, tMs: number, statut: "CLOS" | "CLOS_PAR_ARRET",
  ): { ok: true; corps: CorpsEntree } | Refus {
    const etat = this.etatInterne;
    const p = etat.parametres;
    const duree = tMs - ev.debut.tMs;
    if (duree < 0) return refuser("FIN_AVANT_DEBUT", "La fin precede le debut : l'horloge a recule. L'evenement reste ouvert.");
    if (duree === 0) return refuser("DUREE_NULLE", "Debut et fin au meme instant : evenement de duree nulle.");
    if (duree < p.dureeMinEvenementMs) return refuser("DUREE_TROP_COURTE", `Duree inferieure au minimum de ${p.dureeMinEvenementMs} ms.`);

    const fin = this.repereA(tMs);
    const couvertureGnss = couvertureDe(etat, ev.debut.tMs, tMs);
    const avertissements: string[] = [];
    if (couvertureGnss < p.couvertureMinEvenement) avertissements.push("COUVERTURE_GNSS_FAIBLE");
    if (ev.debut.positionPerimee || fin.positionPerimee) avertissements.push("POSITION_PERIMEE");
    let distanceDirecteM: number | null = null;
    if (ev.debut.lat !== null && ev.debut.lon !== null && fin.lat !== null && fin.lon !== null) {
      distanceDirecteM = Math.round(distanceM({ lat: ev.debut.lat, lon: ev.debut.lon }, { lat: fin.lat, lon: fin.lon }) * 10) / 10;
      if (distanceDirecteM < p.distanceMinEvenementM) avertissements.push("EVENEMENT_IMMOBILE");
    }
    const traverse = etat.interruptions.some((x) => x.debutMs < tMs && (x.finMs ?? Infinity) > ev.debut.tMs && x.cause === "REDEMARRAGE");
    if (traverse) avertissements.push("TRAVERSE_REDEMARRAGE");
    return { ok: true, corps: { type: "EVT_FIN", id: ev.id, fin, statut, couvertureGnss, distanceDirecteM, avertissements } };
  }

  /** Numerote, applique a l'etat, puis tente le journal. Rend vrai si le journal a ecrit. */
  private ecrire(corps: CorpsEntree): boolean {
    this.seq += 1;
    const entree = { ...corps, seq: this.seq } as EntreeJournal;
    appliquerEntree(this.etatInterne, entree);
    this.etatInterne.dernierSeq = this.seq;
    if (!this.opts.journal) return true;
    try {
      this.opts.journal(entree);
      return true;
    } catch (err) {
      // Le journal ne peut pas faire perdre la saisie en cours : elle reste en memoire. L'echec est
      // compte, daté, et le numero de sequence manquant dans le journal le rendra visible au rejeu.
      this.echecsJournal += 1;
      this.seq += 1;
      appliquerEntree(this.etatInterne, {
        type: "ALERTE", alerte: { type: "JOURNAL_ECHEC", tMs: this.opts.horloge.maintenantMs(), detail: err instanceof Error ? err.message : "echec" }, seq: this.seq,
      });
      return false;
    }
  }
}

/**
 * Part de [debutMs, finMs] couverte par des echantillons : deux echantillons consecutifs d'un MEME
 * segment separes d'au plus `trouMs` couvrent l'intervalle qui les separe ; au-dela, rien.
 * L'extremite finale compte comme un echantillon virtuel a `finMs`.
 */
export function couvertureDe(etat: Pick<EtatSession, "echantillons" | "parametres">, debutMs: number, finMs: number): number {
  const duree = finMs - debutMs;
  if (duree <= 0) return 0;
  const { echantillons, parametres } = etat;
  let couvert = 0;
  let suivant = finMs;
  let segmentSuivant: number | null = null;
  for (let i = echantillons.length - 1; i >= 0; i -= 1) {
    const s = echantillons[i];
    if (s.tMs > finMs) continue;
    const ecart = suivant - s.tMs;
    const memeSegment = segmentSuivant === null || segmentSuivant === s.segment;
    if (memeSegment && ecart <= parametres.trouMs) {
      couvert += Math.max(0, Math.min(suivant, finMs) - Math.max(s.tMs, debutMs));
    }
    suivant = s.tMs;
    segmentSuivant = s.segment;
    if (s.tMs <= debutMs) break;
  }
  return Math.min(1, couvert / duree);
}
