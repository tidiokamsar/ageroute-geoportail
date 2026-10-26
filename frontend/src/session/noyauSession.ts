/**
 * Noyau PUR de la session locale hors ligne (conception : docs/securite/SESSION-HORS-LIGNE.md, section 2).
 *
 * Comme le noyau de roulage : aucun DOM, aucun stockage, aucun reseau, AUCUNE horloge globale. Le temps
 * arrive dans chaque evenement (`maintenantMs`), de sorte qu'un test rejoue sept jours en quelques
 * millisecondes et qu'une horloge truquee soit un simple argument. Un test de garde
 * (`noyauSession.garde.test.ts`) lit les sources et echoue si l'une de ces dependances y apparait.
 *
 * ---------------------------------------------------------------------------------------------------
 * RESUME DU CONTRAT POUR LES INTEGRATEURS (auth.tsx, route protegee, ecran de deverrouillage)
 * ---------------------------------------------------------------------------------------------------
 *
 *   const r = transition(etat, evenement, contexte, parametres?);   // fonction pure
 *   // r = { etat, contexte, effets, applique }
 *
 * 1. Le noyau ne FAIT rien : il rend le nouvel etat, le nouveau contexte et une liste d'EFFETS que
 *    l'integrateur execute (oublier la cle, rejouer la deconnexion, journaliser). L'integrateur garde
 *    `etat` et `contexte` dans un seul endroit (reducteur React ou objet), et reinjecte la sortie.
 *
 * 2. Etats :
 *      DECONNECTE             aucune session en cours (premier lancement, ou coffre detruit).
 *      EN_LIGNE               session reseau valide (jeton d'acces + cookie de rafraichissement).
 *      HORS_LIGNE_OUVERT      reseau injoignable, coffre local deverrouille (cle en memoire).
 *      HORS_LIGNE_VERROUILLE  reseau injoignable, coffre local present, PIN requis.
 *      EXPIRE                 duree maximale depassee ou horloge reculee : coffre intact mais illisible
 *                             jusqu'a une nouvelle connexion EN LIGNE du meme compte.
 *      FERME                  session fermee (deconnexion, ou refus 401/403 du serveur). Rien n'est efface.
 *
 * 3. Evenements a emettre (tous portent `maintenantMs`, fourni par l'integrateur) :
 *      CONNEXION_REUSSIE       connexion en ligne complete (mot de passe puis TOTP si actif).
 *      REFRAICHISSEMENT        issue de `rafraichirJeton()` (api.ts) : passer `issue: resultat.etat`
 *                              (OK | RESEAU_COUPE | INDISPONIBLE | REFUSE). C'est CET evenement qui
 *                              decide, au demarrage, entre EN_LIGNE, l'ecran PIN et FERME.
 *      COFFRE_CREE             `creerCoffre` a reussi (cle en memoire). Seulement depuis EN_LIGNE.
 *      DEVERROUILLAGE_REUSSI   `coffre.deverrouiller` a rendu ok : passer `valideLeMs` et `expireLeMs`
 *                              du profil dechiffre (le noyau ne les connait qu'apres le PIN).
 *      ECHEC_PIN               PIN_INCORRECT (passer `echecsPersistes` si le coffre le donne).
 *      COFFRE_EXPIRE           le coffre a repondu EXPIRE (PIN juste, validite depassee).
 *      ACTIVITE | ARRIERE_PLAN | PREMIER_PLAN | TICK   horloge d'interface. Emettre TICK au moins une
 *                              fois par seconde tant que l'application est affichee ; ACTIVITE sur
 *                              pointeur, clavier, tactile (interaction REELLE de l'agent).
 *      ACTIVITE_EXTERNE        activite qui n'est PAS une interaction (point GNSS d'un releve en cours,
 *                              pont `activiteExterne.ts`). Ne repousse QUE le verrou d'inactivite, jamais
 *                              le verrou d'arriere-plan, et seulement tant que la derniere interaction
 *                              reelle date de moins de `plafondActiviteExterneMs` (PROVISOIRE, 30 min).
 *      VERROU_MANUEL           l'agent verrouille.
 *      DECONNEXION_DEMANDEE    `serveurJoint: true` si POST /auth/logout a repondu (meme 401), `false`
 *                              si pas de reponse (reseau coupe, 5xx). Hors ligne : verrou + drapeau.
 *      DECONNEXION_REJOUEE     la deconnexion en attente a ete rejouee avec succes au retour du reseau.
 *      DROITS_MODIFIES         GET /auth/me differe du profil du coffre (voir `differencesDeDroits`).
 *      PROFIL_REVALIDE         `coffre.revalider` / `coffre.prolonger` a reecrit le profil (EN_LIGNE).
 *      REINITIALISATION_PIN    `coffre.reinitialiser` a detruit l'enveloppe (PIN oublie).
 *      EFFACEMENT_LOCAL        l'agent a efface les donnees locales (apres `decisionSuppressionLocale`).
 *
 * 4. Effets rendus : OUBLIER_DEK (appeler `coffre.verrouiller()`), REJOUER_DECONNEXION (POST
 *    /auth/logout puis DECONNEXION_REJOUEE), JOURNALISER (evenement local a envoyer au serveur plus tard).
 *
 * 5. Regles temporelles, appliquees AVANT chaque evenement (donc un ACTIVITE tardif ne ressuscite rien) :
 *      - horloge reculee de plus de `toleranceReculHorlogeMs` sous la plus haute valeur observee
 *        (`dernierInstantMs`) : EXPIRE (falsification presumee). Bornes : un recul de exactement 5 min
 *        est toleree, 5 min et 1 ms ne l'est pas ;
 *      - `maintenantMs >= expireLeMs` : EXPIRE. `expireLeMs` est fixee a la validation par le serveur
 *        (`valideLe + dureeMaxMs`) et AUCUN evenement hors ligne ne la repousse ;
 *      - HORS_LIGNE_OUVERT : verrou si inactivite >= `inactiviteMs` ou arriere-plan >= `arrierePlanMs`
 *        (bornes inclusives : on verrouille a exactement la duree, jamais plus tard) ;
 *      - ACTIVITE_EXTERNE repousse l'inactivite tant que (maintenant - derniere interaction reelle) est
 *        STRICTEMENT inferieur au plafond : a exactement le plafond, elle ne repousse plus. Le verrou tombe
 *        donc au plus tard `plafond + inactiviteMs` apres la derniere interaction reelle ;
 *      - EN_LIGNE : les memes durees n'effacent que la cle (effet OUBLIER_DEK), l'etat ne change pas.
 *    Ces controles ne s'appliquent a l'expiration/horloge qu'hors ligne : en ligne, le serveur fait foi.
 *
 * 6. Contexte au demarrage : `contexteInitial({ coffrePresent, dernierInstantMs, echecsPin, pasAvantMs,
 *    deconnexionEnAttente })`. `expireLeMs` y est `null` (inconnue) : elle est chiffree dans le profil et
 *    n'est lue qu'apres le PIN ; `DEVERROUILLAGE_REUSSI` la fournit.
 *
 * 7. Ce que le noyau ne fait PAS : il ne chiffre rien (voir coffreSession.ts), ne decide pas si la
 *    suppression locale est permise (voir politiqueDeconnexion.ts), ne nomme aucune base (voir
 *    compteLocal.ts), et ne dispose d'aucune horloge de confiance : la date du poste est la seule connue.
 *
 * PARAMETRES PROVISOIRES (a arbitrer par la DSI) : tous dans `PARAMETRES_SESSION`, exportes et
 * injectables, jamais codes en dur dans la logique.
 */

// ---------------------------------------------------------------------------------------------------
// Parametres
// ---------------------------------------------------------------------------------------------------

export interface ParametresSession {
  /** Duree maximale sans validation par le serveur. */
  readonly dureeMaxMs: number;
  /** Verrou apres cette duree sans interaction. */
  readonly inactiviteMs: number;
  /** Verrou apres cette duree passee en arriere-plan. */
  readonly arrierePlanMs: number;
  /** Recul d'horloge toleree (derive normale, changement de fuseau corrige) avant de crier a la falsification. */
  readonly toleranceReculHorlogeMs: number;
  /** Nombre d'echecs de PIN SANS delai : les echecs 1 a `echecsLibres` n'imposent aucune attente. */
  readonly echecsLibres: number;
  /** Delai impose apres l'echec numero `echecsLibres + 1` ; double a chaque echec suivant. */
  readonly delaiInitialMs: number;
  /** Plafond du delai. */
  readonly delaiMaxMs: number;
  /**
   * Duree pendant laquelle une activite EXTERNE (point GNSS d'un releve) peut repousser le verrou d'inactivite, comptee depuis la
   * derniere interaction REELLE de l'agent. Au-dela, plus rien ne le repousse : sans ce plafond, un releve laisse tourner
   * garderait le telephone deverrouille sans limite (constat de la relecture independante).
   */
  readonly plafondActiviteExterneMs: number;
}

/** PROVISOIRE (a arbitrer par la DSI) : 30 minutes sans interaction reelle de l'agent. */
export const PLAFOND_ACTIVITE_EXTERNE_MS = 30 * 60 * 1000;

/** Valeurs PROVISOIRES de la conception (section 2). Reversibles : aucune n'est supposee ailleurs. */
export const PARAMETRES_SESSION: ParametresSession = Object.freeze({
  dureeMaxMs: 7 * 24 * 60 * 60 * 1000,
  inactiviteMs: 5 * 60 * 1000,
  arrierePlanMs: 2 * 60 * 1000,
  toleranceReculHorlogeMs: 5 * 60 * 1000,
  echecsLibres: 5,
  delaiInitialMs: 30 * 1000,
  delaiMaxMs: 15 * 60 * 1000,
  plafondActiviteExterneMs: PLAFOND_ACTIVITE_EXTERNE_MS,
});

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

export type EtatSession =
  | "DECONNECTE"
  | "EN_LIGNE"
  | "HORS_LIGNE_OUVERT"
  | "HORS_LIGNE_VERROUILLE"
  | "EXPIRE"
  | "FERME";

export const ETATS_SESSION: readonly EtatSession[] = [
  "DECONNECTE", "EN_LIGNE", "HORS_LIGNE_OUVERT", "HORS_LIGNE_VERROUILLE", "EXPIRE", "FERME",
];

/**
 * Issue typee du rafraichissement (api.ts, `rafraichirJeton`). Recopiee ici pour que le noyau
 * n'importe rien hors du dossier ; l'integrateur passe `issue: resultat.etat`, le compilateur verifie.
 */
export type EtatRafraichissement = "OK" | "RESEAU_COUPE" | "INDISPONIBLE" | "REFUSE";

/**
 * Profil de session conserve CHIFFRE dans le coffre. Aucun champ de jeton reseau : la session locale ne
 * parle jamais au serveur (conception, section 1). Les instants sont des millisecondes depuis 1970.
 */
export interface ProfilSession {
  readonly userId: string;
  readonly nom: string;
  readonly role: string;
  readonly modules: readonly string[];
  readonly regions: readonly string[];
  /** Instant de creation de la session locale (premiere connexion en ligne). */
  readonly emisLe: number;
  /** Derniere validation par le serveur (connexion ou rafraichissement reussi). */
  readonly valideLe: number;
  /** Expiration absolue : `valideLe + dureeMaxMs`. Jamais repoussee hors ligne. */
  readonly expireLe: number;
}

export interface ContexteSession {
  /** Un coffre existe pour ce compte sur cet appareil. */
  readonly coffrePresent: boolean;
  /** La cle de donnees est en memoire (coffre deverrouille). Invariant : HORS_LIGNE_OUVERT implique true. */
  readonly cleEnMemoire: boolean;
  /** Derniere validation par le serveur ; `null` = inconnue (profil encore chiffre). */
  readonly valideLeMs: number | null;
  /** Expiration absolue ; `null` = inconnue (profil encore chiffre), PAS « sans limite ». */
  readonly expireLeMs: number | null;
  /** Plus haute valeur d'horloge observee : sert a detecter un recul. */
  readonly dernierInstantMs: number | null;
  readonly derniereActiviteMs: number | null;
  /**
   * Derniere interaction REELLE de l'agent (pointeur, clavier, tactile, deverrouillage). Absente (`undefined`) : inconnue, la
   * premiere activite externe la fixe a `derniereActiviteMs`. Sert uniquement au plafond de l'activite externe.
   */
  readonly derniereInteractionMs?: number | null;
  readonly arrierePlanDepuisMs: number | null;
  /** Echecs de PIN consecutifs depuis le dernier succes. */
  readonly echecsPin: number;
  /** Aucune tentative de PIN avant cet instant ; `null` = libre. */
  readonly pasAvantMs: number | null;
  /** Deconnexion demandee hors ligne, a rejouer au retour du reseau. Persistee par l'integrateur. */
  readonly deconnexionEnAttente: boolean;
}

export type MotifJournal =
  | "OUVERTURE_HORS_LIGNE"
  | "DEVERROUILLAGE"
  | "ECHEC_DEVERROUILLAGE"
  | "VERROU_INACTIVITE"
  | "VERROU_ARRIERE_PLAN"
  | "VERROU_MANUEL"
  | "EXPIRATION"
  | "HORLOGE_RECULEE"
  | "FERMETURE_SESSION"
  | "DECONNEXION_HORS_LIGNE"
  | "DROITS_MODIFIES"
  | "REINITIALISATION_PIN"
  | "EFFACEMENT_LOCAL";

export type EffetSession =
  | { readonly type: "OUBLIER_DEK" }
  | { readonly type: "REJOUER_DECONNEXION" }
  | { readonly type: "JOURNALISER"; readonly motif: MotifJournal; readonly detail?: string };

interface Base { readonly maintenantMs: number }

export type EvenementSession =
  | (Base & { readonly type: "CONNEXION_REUSSIE" })
  | (Base & { readonly type: "REFRAICHISSEMENT"; readonly issue: EtatRafraichissement })
  | (Base & { readonly type: "COFFRE_CREE" })
  | (Base & { readonly type: "DEVERROUILLAGE_REUSSI"; readonly valideLeMs: number; readonly expireLeMs: number })
  | (Base & { readonly type: "ECHEC_PIN"; readonly echecsPersistes?: number })
  | (Base & { readonly type: "COFFRE_EXPIRE" })
  | (Base & { readonly type: "ACTIVITE" })
  | (Base & { readonly type: "ACTIVITE_EXTERNE" })
  | (Base & { readonly type: "ARRIERE_PLAN" })
  | (Base & { readonly type: "PREMIER_PLAN" })
  | (Base & { readonly type: "TICK" })
  | (Base & { readonly type: "VERROU_MANUEL" })
  | (Base & { readonly type: "DECONNEXION_DEMANDEE"; readonly serveurJoint: boolean })
  | (Base & { readonly type: "DECONNEXION_REJOUEE" })
  | (Base & { readonly type: "DROITS_MODIFIES" })
  | (Base & { readonly type: "PROFIL_REVALIDE" })
  | (Base & { readonly type: "REINITIALISATION_PIN" })
  | (Base & { readonly type: "EFFACEMENT_LOCAL" });

export interface ResultatTransition {
  readonly etat: EtatSession;
  readonly contexte: ContexteSession;
  readonly effets: readonly EffetSession[];
  /** `false` : l'evenement n'a pas de sens dans cet etat et a ete ignore (les controles temporels, eux, ont tourne). */
  readonly applique: boolean;
}

// ---------------------------------------------------------------------------------------------------
// Fonctions de calcul
// ---------------------------------------------------------------------------------------------------

/** Contexte d'un demarrage a froid : tout ce qui n'est pas fourni est « inconnu » ou « libre ». */
export function contexteInitial(partiel: Partial<ContexteSession> = {}): ContexteSession {
  return {
    coffrePresent: false,
    cleEnMemoire: false,
    valideLeMs: null,
    expireLeMs: null,
    dernierInstantMs: null,
    derniereActiviteMs: null,
    arrierePlanDepuisMs: null,
    echecsPin: 0,
    pasAvantMs: null,
    deconnexionEnAttente: false,
    ...partiel,
  };
}

/**
 * Attente imposee apres `n` echecs consecutifs de PIN (n = nombre d'echecs deja subis, celui qui vient
 * d'arriver compris). Echecs 1 a 5 : 0. Echec 6 : 30 s, puis 1 min, 2 min, 4 min, 8 min, puis 15 min
 * (plafond). Toute valeur non finie ou inferieure a 1 donne 0.
 */
export function delaiApresEchecs(n: number, p: ParametresSession = PARAMETRES_SESSION): number {
  if (!Number.isFinite(n) || n <= p.echecsLibres) return 0;
  const palier = Math.floor(n) - p.echecsLibres - 1; // 0 pour le premier echec penalise
  // 2 ** palier deborde en Infinity pour un compteur absurde : Math.min le ramene au plafond.
  return Math.min(p.delaiInitialMs * 2 ** palier, p.delaiMaxMs);
}

/** Expiration absolue d'une validation faite a `valideLeMs`. */
export function expirationApres(valideLeMs: number, p: ParametresSession = PARAMETRES_SESSION): number {
  return valideLeMs + p.dureeMaxMs;
}

/**
 * Vrai si l'horloge est en dessous de la plus haute valeur observee, au-dela de la tolerance.
 * Strict : un recul de exactement `toleranceReculHorlogeMs` est toleree.
 */
export function aReculeHorloge(
  dernierInstantMs: number | null,
  maintenantMs: number,
  p: ParametresSession = PARAMETRES_SESSION,
): boolean {
  return dernierInstantMs !== null && maintenantMs < dernierInstantMs - p.toleranceReculHorlogeMs;
}

/** Vrai si la validite est depassee. Inclusif : a l'instant exact d'expiration, la session est expiree. `null` = inconnue, donc pas expiree. */
export function estExpire(expireLeMs: number | null, maintenantMs: number): boolean {
  return expireLeMs !== null && maintenantMs >= expireLeMs;
}

/** Une tentative de PIN est-elle permise maintenant ? Sinon, combien de millisecondes attendre. */
export function tentativePinPossible(
  c: Pick<ContexteSession, "pasAvantMs">,
  maintenantMs: number,
): { readonly possible: true } | { readonly possible: false; readonly resteMs: number } {
  if (c.pasAvantMs === null || maintenantMs >= c.pasAvantMs) return { possible: true };
  return { possible: false, resteMs: c.pasAvantMs - maintenantMs };
}

/**
 * Champs de droits qui different entre le profil du coffre et celui rendu par le serveur
 * (`GET /auth/me`). Liste vide = inchangee. Modules et regions sont compares comme des ensembles.
 * Tout resultat non vide invalide la session locale (section 8 de la conception).
 */
export function differencesDeDroits(
  avant: Pick<ProfilSession, "userId" | "role" | "modules" | "regions">,
  apres: Pick<ProfilSession, "userId" | "role" | "modules" | "regions">,
): Array<"userId" | "role" | "modules" | "regions"> {
  const memeEnsemble = (a: readonly string[], b: readonly string[]) => {
    const sa = new Set(a);
    const sb = new Set(b);
    return sa.size === sb.size && [...sa].every((x) => sb.has(x));
  };
  const diff: Array<"userId" | "role" | "modules" | "regions"> = [];
  if (avant.userId !== apres.userId) diff.push("userId");
  if (avant.role !== apres.role) diff.push("role");
  if (!memeEnsemble(avant.modules, apres.modules)) diff.push("modules");
  if (!memeEnsemble(avant.regions, apres.regions)) diff.push("regions");
  return diff;
}

// ---------------------------------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------------------------------

type Ctx = { -readonly [K in keyof ContexteSession]: ContexteSession[K] };

const estHorsLigne = (e: EtatSession) => e === "HORS_LIGNE_OUVERT" || e === "HORS_LIGNE_VERROUILLE";

function journaliser(effets: EffetSession[], motif: MotifJournal, detail?: string) {
  effets.push(detail === undefined ? { type: "JOURNALISER", motif } : { type: "JOURNALISER", motif, detail });
}

/** Efface la cle de la memoire : un seul effet, et seulement si elle y etait. */
function oublierCle(c: Ctx, effets: EffetSession[]) {
  if (c.cleEnMemoire) {
    effets.push({ type: "OUBLIER_DEK" });
    c.cleEnMemoire = false;
  }
}

function passerExpire(c: Ctx, effets: EffetSession[], motif: "EXPIRATION" | "HORLOGE_RECULEE"): EtatSession {
  oublierCle(c, effets);
  journaliser(effets, motif);
  return "EXPIRE";
}

/** Verrou d'inactivite ou d'arriere-plan : le motif, ou `null` si rien a faire. */
function motifVerrou(c: Ctx, now: number, p: ParametresSession): "VERROU_INACTIVITE" | "VERROU_ARRIERE_PLAN" | null {
  if (c.derniereActiviteMs !== null && now - c.derniereActiviteMs >= p.inactiviteMs) return "VERROU_INACTIVITE";
  if (c.arrierePlanDepuisMs !== null && now - c.arrierePlanDepuisMs >= p.arrierePlanMs) return "VERROU_ARRIERE_PLAN";
  return null;
}

/** Controles du temps, executes avant tout evenement. Rend le nouvel etat (peut etre inchange). */
function controlesTemporels(e: EtatSession, c: Ctx, now: number, p: ParametresSession, effets: EffetSession[]): EtatSession {
  if (estHorsLigne(e)) {
    if (aReculeHorloge(c.dernierInstantMs, now, p)) return passerExpire(c, effets, "HORLOGE_RECULEE");
    if (estExpire(c.expireLeMs, now)) return passerExpire(c, effets, "EXPIRATION");
  }
  // Reparation d'un contexte incoherent : « ouvert » sans cle n'existe pas, et une cle ne reste jamais en
  // memoire dans un etat ferme a clef (verrouille, expire, ferme, deconnecte).
  if (e === "HORS_LIGNE_OUVERT" && !c.cleEnMemoire) e = "HORS_LIGNE_VERROUILLE";
  if (e !== "EN_LIGNE" && e !== "HORS_LIGNE_OUVERT") oublierCle(c, effets);

  if ((e === "HORS_LIGNE_OUVERT" || e === "EN_LIGNE") && c.cleEnMemoire) {
    const motif = motifVerrou(c, now, p);
    if (motif !== null) {
      oublierCle(c, effets);
      journaliser(effets, motif);
      // En ligne le serveur fait foi : seule la cle s'efface, l'etat de session ne change pas.
      if (e === "HORS_LIGNE_OUVERT") e = "HORS_LIGNE_VERROUILLE";
    }
  }
  return e;
}

/**
 * Transition pure. `evenement.maintenantMs` est la seule source de temps.
 * Les controles temporels (expiration, recul d'horloge, verrou) passent AVANT l'evenement.
 */
export function transition(
  etat: EtatSession,
  evenement: EvenementSession,
  contexte: ContexteSession,
  parametres: ParametresSession = PARAMETRES_SESSION,
): ResultatTransition {
  const p = parametres;
  const now = evenement.maintenantMs;
  const effets: EffetSession[] = [];
  const c: Ctx = { ...contexte };
  let e = controlesTemporels(etat, c, now, p, effets);
  let applique = true;
  // Une validation reussie par le serveur reinitialise la marque haute d'horloge (un poste dont la date a
  // ete corrigee ne doit pas rester bloque) ; sinon la marque ne fait que monter.
  let reinitialiserMarque = false;

  const ouvertureHorsLigne = (depuis: EtatSession) => {
    if (!c.coffrePresent) return depuis; // sans coffre, aucun mode hors ligne n'existe
    const cible: EtatSession = c.cleEnMemoire ? "HORS_LIGNE_OUVERT" : "HORS_LIGNE_VERROUILLE";
    journaliser(effets, "OUVERTURE_HORS_LIGNE");
    return cible;
  };

  switch (evenement.type) {
    case "CONNEXION_REUSSIE": {
      e = "EN_LIGNE";
      c.valideLeMs = now;
      c.expireLeMs = expirationApres(now, p);
      c.deconnexionEnAttente = false; // une connexion neuve remplace le cookie : rejouer l'ancienne deconnexion fermerait la neuve
      reinitialiserMarque = true;
      break;
    }

    case "REFRAICHISSEMENT": {
      switch (evenement.issue) {
        case "OK": {
          reinitialiserMarque = true;
          if (c.deconnexionEnAttente) {
            // L'agent s'est deconnecte hors ligne : le reseau revient, mais la session ne doit pas se rouvrir.
            oublierCle(c, effets);
            effets.push({ type: "REJOUER_DECONNEXION" });
            journaliser(effets, "FERMETURE_SESSION", "deconnexion en attente rejouee");
            e = "FERME";
          } else {
            e = "EN_LIGNE";
            c.valideLeMs = now;
            c.expireLeMs = expirationApres(now, p);
          }
          break;
        }
        case "RESEAU_COUPE":
        case "INDISPONIBLE": {
          // Un serveur qui repond 5xx ne dit rien des droits : meme conduite qu'un reseau coupe.
          if (e === "DECONNECTE" || e === "EN_LIGNE") {
            const cible = ouvertureHorsLigne(e);
            if (cible !== e) {
              e = cible;
              // Les controles du temps valent des l'entree dans un etat hors ligne.
              e = controlesTemporels(e, c, now, p, effets);
            } else {
              applique = false;
            }
          } else {
            applique = false; // deja hors ligne, expire ou ferme : rien ne change
          }
          break;
        }
        case "REFUSE": {
          // 401 ou 403 : le serveur dit non. La session se ferme ; la file chiffree reste (conception, section 7).
          c.deconnexionEnAttente = false; // plus de cookie valide a revoquer
          oublierCle(c, effets);
          if (c.coffrePresent) {
            if (e !== "FERME") journaliser(effets, "FERMETURE_SESSION", "refus du serveur");
            e = "FERME";
          } else {
            e = "DECONNECTE";
          }
          break;
        }
      }
      break;
    }

    case "COFFRE_CREE": {
      if (e !== "EN_LIGNE") { applique = false; break; }
      c.coffrePresent = true;
      c.cleEnMemoire = true;
      c.derniereActiviteMs = now;
      c.derniereInteractionMs = now;
      c.arrierePlanDepuisMs = null;
      c.echecsPin = 0;
      c.pasAvantMs = null;
      break;
    }

    case "DEVERROUILLAGE_REUSSI": {
      if (!c.coffrePresent || (e !== "HORS_LIGNE_VERROUILLE" && e !== "EN_LIGNE")) { applique = false; break; }
      // En ligne, la validite du contexte vient des evenements en ligne (et DROITS_MODIFIES l'a peut-etre
      // invalidee) : un profil persiste plus ancien ne doit ni la raccourcir ni la ressusciter.
      // Hors ligne, le profil persiste fait foi : c'est lui que le coffre applique a chaque lecture.
      if (e === "HORS_LIGNE_VERROUILLE") {
        c.valideLeMs = evenement.valideLeMs;
        c.expireLeMs = evenement.expireLeMs;
      }
      if (e === "HORS_LIGNE_VERROUILLE" && estExpire(c.expireLeMs, now)) {
        e = passerExpire(c, effets, "EXPIRATION");
        break;
      }
      c.cleEnMemoire = true;
      c.derniereActiviteMs = now;
      c.derniereInteractionMs = now;
      c.arrierePlanDepuisMs = null;
      c.echecsPin = 0;
      c.pasAvantMs = null;
      if (e === "HORS_LIGNE_VERROUILLE") e = "HORS_LIGNE_OUVERT";
      journaliser(effets, "DEVERROUILLAGE");
      break;
    }

    case "ECHEC_PIN": {
      if (!c.coffrePresent) { applique = false; break; }
      c.echecsPin = evenement.echecsPersistes ?? c.echecsPin + 1;
      const delai = delaiApresEchecs(c.echecsPin, p);
      c.pasAvantMs = delai > 0 ? now + delai : null;
      journaliser(effets, "ECHEC_DEVERROUILLAGE", String(c.echecsPin));
      break;
    }

    case "COFFRE_EXPIRE": {
      if (e === "HORS_LIGNE_VERROUILLE" || e === "HORS_LIGNE_OUVERT") {
        e = passerExpire(c, effets, "EXPIRATION");
      } else {
        applique = false;
      }
      break;
    }

    case "ACTIVITE": {
      c.derniereActiviteMs = now;
      c.derniereInteractionMs = now;
      c.arrierePlanDepuisMs = null; // une interaction prouve que l'application est au premier plan
      break;
    }

    case "ACTIVITE_EXTERNE": {
      // Sans cle en memoire, il n'y a rien a differer. Et jamais `arrierePlanDepuisMs` : un point GNSS n'est pas une interaction
      // et ne prouve pas que l'application est au premier plan (constat : 30 min en arriere-plan restaient deverrouillees).
      const reference = c.derniereInteractionMs ?? c.derniereActiviteMs;
      if (!c.cleEnMemoire || reference === null) { applique = false; break; }
      c.derniereInteractionMs = reference;
      const derniere = reference;
      // Strict : a exactement le plafond, l'activite externe ne repousse plus.
      if (now - derniere < p.plafondActiviteExterneMs) c.derniereActiviteMs = now;
      break;
    }

    case "ARRIERE_PLAN": {
      if (c.arrierePlanDepuisMs === null) c.arrierePlanDepuisMs = now;
      break;
    }

    case "PREMIER_PLAN": {
      c.arrierePlanDepuisMs = null; // le verrou eventuel est deja passe dans les controles ci-dessus
      break;
    }

    case "TICK": {
      break; // les controles temporels ont tout fait
    }

    case "VERROU_MANUEL": {
      if (e === "HORS_LIGNE_OUVERT") {
        oublierCle(c, effets);
        journaliser(effets, "VERROU_MANUEL");
        e = "HORS_LIGNE_VERROUILLE";
      } else if (e === "EN_LIGNE" && c.cleEnMemoire) {
        oublierCle(c, effets);
        journaliser(effets, "VERROU_MANUEL");
      } else {
        applique = false;
      }
      break;
    }

    case "DECONNEXION_DEMANDEE": {
      if (e === "DECONNECTE" || e === "FERME") { applique = false; break; }
      if (evenement.serveurJoint) {
        oublierCle(c, effets);
        c.deconnexionEnAttente = false;
        journaliser(effets, "FERMETURE_SESSION", "deconnexion");
        e = "FERME";
      } else {
        // Le serveur n'a pas repondu : on verrouille tout de suite et on se souvient de revoquer plus tard.
        oublierCle(c, effets);
        c.deconnexionEnAttente = true;
        journaliser(effets, "DECONNEXION_HORS_LIGNE");
        if (e === "EN_LIGNE") e = c.coffrePresent ? "HORS_LIGNE_VERROUILLE" : "FERME";
        else if (e === "HORS_LIGNE_OUVERT") e = "HORS_LIGNE_VERROUILLE";
        // HORS_LIGNE_VERROUILLE et EXPIRE : l'etat reste, le drapeau est pose.
      }
      break;
    }

    case "DECONNEXION_REJOUEE": {
      if (!c.deconnexionEnAttente) { applique = false; break; }
      c.deconnexionEnAttente = false;
      oublierCle(c, effets);
      if (e !== "DECONNECTE" && e !== "FERME") {
        journaliser(effets, "FERMETURE_SESSION", "deconnexion rejouee");
        e = "FERME";
      }
      break;
    }

    case "DROITS_MODIFIES": {
      if (e !== "EN_LIGNE") { applique = false; break; }
      // La validite du profil du coffre ne vaut plus rien : elle ne revient qu'avec PROFIL_REVALIDE.
      c.expireLeMs = now;
      journaliser(effets, "DROITS_MODIFIES");
      break;
    }

    case "PROFIL_REVALIDE": {
      if (e !== "EN_LIGNE") { applique = false; break; }
      c.valideLeMs = now;
      c.expireLeMs = expirationApres(now, p);
      reinitialiserMarque = true;
      break;
    }

    case "REINITIALISATION_PIN":
    case "EFFACEMENT_LOCAL": {
      oublierCle(c, effets);
      c.coffrePresent = false;
      c.valideLeMs = null;
      c.expireLeMs = null;
      c.derniereActiviteMs = null;
      c.derniereInteractionMs = null;
      c.arrierePlanDepuisMs = null;
      c.echecsPin = 0;
      c.pasAvantMs = null;
      journaliser(effets, evenement.type === "REINITIALISATION_PIN" ? "REINITIALISATION_PIN" : "EFFACEMENT_LOCAL");
      // En ligne l'agent reste connecte (il peut recreer un coffre) ; sinon il n'y a plus rien a ouvrir.
      if (e !== "EN_LIGNE") e = "DECONNECTE";
      break;
    }
  }

  c.dernierInstantMs = reinitialiserMarque ? now : Math.max(c.dernierInstantMs ?? now, now);
  return { etat: e, contexte: c, effets, applique };
}
