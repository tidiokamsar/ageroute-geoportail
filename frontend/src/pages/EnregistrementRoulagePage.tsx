import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, Download, Flag, LogOut, MapPin, Pause, Play, RotateCcw, Send, Square, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toast } from "../lib/toast";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { libelleDuree, libelleKm } from "../lib/releve";
import {
  demanderStockagePersistant, estimerStockage, etatPermissionGps, garderEcranAllume, nomFichierGpx, ouvrirStockage, positionVersEchantillon, versGpx,
  type EtatPermissionGps, type StockageJournal, type VerrouEcran,
} from "../lib/roulageHote";
import {
  dureeEffectiveMs, etatSessionVue, LIBELLES_ETAT, lireEnvoiConfirme, noterEnvoiConfirme, oublierEnvoi, PROFILS_PRECISION, profilParCode,
  qualiteTrace, segmentsPourCarte, sessionVide, stockageProche, vitesseKmH,
  type CodeProfil, type EstimationStockage,
} from "../lib/releveVue";
import { ObservationRapideRoulage } from "../components/ObservationRapideRoulage";
import { CapacitesAppareilPanel } from "../components/CapacitesAppareilPanel";
import { CarteTraceRoulage } from "../components/CarteTraceRoulage";
import {
  construirePayload, horlogeSysteme, interpreterReponse, operationPourSynchronisation, SessionRoulage,
  type EtatSession, type ResumeSession,
} from "../roulage";
import {
  construireQualification, libelleMission, libelleQualification, memeQualification, saisieDepuisQualification, SAISIE_VIDE,
  valeursActives, type MissionListee, type SaisieQualification,
} from "../lib/qualificationSegment";
import { chargerMissionsDeLAgent, chargerVocabulairesQualification, type VocabulairesChargement } from "../lib/referentielsQualification";
import { chargerReferentielsDefautsTerrain, etatPackMission, type EtatPack } from "../lib/defautsTerrain";
import { evaluerCompletude } from "../roulage/completude";
import { indiceIrregularite, type EchantillonAccel } from "../roulage/indices";

/**
 * Enregistrer un releve en roulant, DANS LE NAVIGATEUR (paragraphe 7.13).
 *
 * CE QUE CET ECRAN FAIT : il lit la position du telephone, la confie au noyau de roulage (filtre de precision,
 * trous, segments, journal pour reprendre apres un redemarrage), laisse poser des REPERES et des SEGMENTS
 * (debut / fin), puis exporte la trace en GPX ou envoie la session au serveur.
 *
 * QUALIFIER UN SEGMENT : l'agent choisit revetement, etat de chaussee et praticabilite parmi les valeurs ACTIVES du
 * referentiel du serveur (`GET /v2/referentiels`, comme `TerrainPortionsPage`), au debut du segment ou pendant qu'il
 * est ouvert (donc a la fin). Rien n'est pre-rempli, rien n'est reporte d'un segment au suivant, la praticabilite
 * reste desactivee tant que le serveur n'en a pas defini le vocabulaire. Sans qualification, le serveur ne cree
 * aucune portion : l'ecran le dit. C'est ce que l'agent a CHOISI qui est envoye, pas une mesure de l'etat de la route.
 *
 * LIEN A UNE MISSION (facultatif) : parmi les missions assignees a l'agent ou creees par lui (le serveur refuse
 * toute la session pour une autre). Le choix suit la session (il survit a la reprise apres fermeture de la page).
 *
 * SESSION VIDE : une session terminee sans aucune position retenue n'est JAMAIS presentee comme un releve (aucune trace,
 * rien a envoyer) : l'ecran l'explique et propose de recommencer. Un envoi confirme par le serveur est retenu sur
 * l'appareil, pour qu'un rechargement ne le presente plus comme « pas encore envoye ». Aucune suppression d'une session
 * qui porte des positions ne se fait sans confirmation, et un envoi echoue sur reseau est rejoue seul au retour du reseau.
 *
 * CE QU'IL NE FAIT PAS, ET QUE LA PAGE DIT : il ne tourne qu'au PREMIER PLAN avec l'ecran ALLUME (limite du
 * navigateur : l'application native, hors de portee ici, n'a pas cette limite) ; il ne mesure ni l'IRI ni
 * l'etat de la chaussee ; il ne prend pas de photo. Rien n'a ete mesure sur un vrai telephone : la latence du
 * geste, la precision en roulant et la tenue de l'ecran restent a verifier (docs/roulage/COLLECTE-ROULAGE.md).
 */

const CODE_REPERE = "POINT_A_VERIFIER";
const CODE_SEGMENT = "SEGMENT";

const cleMission = (sessionId: string) => `bdri.roulage.mission.${sessionId}`;
function lireMissionGardee(sessionId: string): string {
  try { return localStorage.getItem(cleMission(sessionId)) ?? ""; } catch { return ""; }
}
function garderMission(sessionId: string, missionId: string): void {
  try {
    if (missionId) localStorage.setItem(cleMission(sessionId), missionId); else localStorage.removeItem(cleMission(sessionId));
  } catch { /* le choix reste valable pour cet ecran, pas apres une fermeture */ }
}

const cleIntitule = (sessionId: string) => `bdri.roulage.intitule.${sessionId}`;
function lireIntitule(sessionId: string): string {
  try { return localStorage.getItem(cleIntitule(sessionId)) ?? ""; } catch { return ""; }
}
function garderIntitule(sessionId: string, intitule: string): void {
  try { if (intitule) localStorage.setItem(cleIntitule(sessionId), intitule); else localStorage.removeItem(cleIntitule(sessionId)); } catch { /* sans effet sur la collecte */ }
}

/** Etat du reseau, suivi sans jamais le supposer meilleur qu'il n'est : `navigator.onLine` vrai ne prouve pas l'acces au serveur. */
function useEnLigne(): boolean {
  const [enLigne, setEnLigne] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const monter = () => setEnLigne(true);
    const couper = () => setEnLigne(false);
    window.addEventListener("online", monter);
    window.addEventListener("offline", couper);
    return () => { window.removeEventListener("online", monter); window.removeEventListener("offline", couper); };
  }, []);
  return enLigne;
}

type Phase = "repos" | "en_cours" | "pause" | "arretee";

interface Vue {
  phase: Phase;
  resume: ResumeSession | null;
  precisionM: number | null;
  segmentOuvert: boolean;
  /** Segments clos SANS qualification : le serveur n'en tirera aucune portion. */
  segmentsSansQualification: number;
  ecranMaintenu: boolean | null;
  gnssIndisponible: boolean;
  permissionRefusee: boolean;
}

const VUE_VIDE: Vue = {
  phase: "repos", resume: null, precisionM: null, segmentOuvert: false, segmentsSansQualification: 0, ecranMaintenu: null, gnssIndisponible: false, permissionRefusee: false,
};

function phaseDe(etat: Readonly<EtatSession>): Phase {
  return etat.statut === "EN_COURS" ? "en_cours" : etat.statut === "EN_PAUSE" ? "pause" : "arretee";
}

async function obtenirAppareil(userId: string): Promise<string> {
  const cle = `bdri.sync.device.${userId}`;
  try {
    const connu = localStorage.getItem(cle);
    if (connu) return connu;
  } catch { /* stockage indisponible : on enregistre un appareil pour cette session */ }
  const { data } = await api.post("/v2/devices", { nom: "BDRI — navigateur terrain", plateforme: "web", modele: navigator.userAgent.slice(0, 120) });
  const id = data?.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("L'appareil de synchronisation n'a pas été enregistré.");
  try { localStorage.setItem(cle, id); } catch { /* l'identifiant reste valable pour cet envoi */ }
  return id;
}

export function EnregistrementRoulagePage() {
  const { user } = useAuth();
  const userId = user?.id;
  const navigate = useNavigate();
  const enLigne = useEnLigne();
  const session = useRef<SessionRoulage | null>(null);
  const stockage = useRef<StockageJournal | null>(null);
  const veille = useRef<VerrouEcran | null>(null);
  const suivi = useRef<number | null>(null);
  const [vue, setVue] = useState<Vue>(VUE_VIDE);
  const [note, setNote] = useState("");
  const [choixArret, setChoixArret] = useState(false);
  const [interrompue, setInterrompue] = useState<{ positions: number; arretee: boolean; envoyeLe: string | null } | null>(null);
  const [profil, setProfil] = useState<CodeProfil>("standard");
  const [intitule, setIntitule] = useState("");
  const [permissionGps, setPermissionGps] = useState<EtatPermissionGps>("inconnue");
  const [stockageEstime, setStockageEstime] = useState<EstimationStockage | null>(null);
  const [suivreCarte, setSuivreCarte] = useState(true);
  const [confirmerSuppression, setConfirmerSuppression] = useState(false);
  const [envoiRetentable, setEnvoiRetentable] = useState(false);
  const [envoi, setEnvoi] = useState<"aucun" | "en_cours" | "envoye" | "echec">("aucun");
  const [messageEnvoi, setMessageEnvoi] = useState("");
  const [vocab, setVocab] = useState<VocabulairesChargement | null>(null);
  const [saisie, setSaisie] = useState<SaisieQualification>(SAISIE_VIDE);
  const [missions, setMissions] = useState<MissionListee[] | null | "chargement">("chargement");
  // Un journal retrouve mais INREJOUABLE (version incompatible, debut absent) n'est jamais
  // ignore en silence (phase 1 SMART FIELD) : la raison est dite, les donnees restent sur
  // l'appareil, et l'agent choisit en connaissance de cause.
  const [repriseRefusee, setRepriseRefusee] = useState<string | null>(null);
  const [confirmerEffacementJournal, setConfirmerEffacementJournal] = useState(false);
  const [missionId, setMissionId] = useState("");
  // Pack de mission (phase 2 SMART FIELD) : ce qui est sur le telephone AVANT de partir.
  const [pack, setPack] = useState<EtatPack>(() => etatPackMission());
  const [packEnCours, setPackEnCours] = useState(false);
  // Phase 3 : l'accelerometre est un module OPTIONNEL que l'agent active avant de partir.
  // Les echantillons ne quittent jamais le telephone. L'INDICE agrege n'est QUE AFFICHE en fin de session : il n'est
  // pas dans la charge envoyee au serveur (le contrat de session n'a pas de champ pour lui). Il porte le mot « experimental ».
  const [accelActif, setAccelActif] = useState(false);
  const accelEchantillons = useRef<EchantillonAccel[]>([]);
  // Calcule a l'ARRET, AVANT que les echantillons soient liberes avec le GPS : calcule apres, il serait toujours vide.
  const [indiceAccel, setIndiceAccel] = useState<ReturnType<typeof indiceIrregularite> | null>(null);

  // Vocabulaires de qualification et missions : demandes a l'ouverture (en ligne, avant de partir). Un echec n'empeche
  // pas d'enregistrer : les segments partent alors sans qualification, et l'ecran le dit.
  useEffect(() => {
    let vivant = true;
    void chargerVocabulairesQualification().then((v) => { if (vivant) setVocab(v); });
    return () => { vivant = false; };
  }, []);
  useEffect(() => {
    let vivant = true;
    if (!userId) return undefined;
    void chargerMissionsDeLAgent(userId).then((m) => { if (vivant) setMissions(m); });
    return () => { vivant = false; };
  }, [userId]);

  // Controle prealable : autorisation de position et place disponible. Lecture seule, rien n'est demande ici.
  useEffect(() => {
    let vivant = true;
    void etatPermissionGps().then((e) => { if (vivant) setPermissionGps(e); });
    void estimerStockage().then((e) => { if (vivant) setStockageEstime(e); });
    return () => { vivant = false; };
  }, []);

  const rafraichir = useCallback((surcharge: Partial<Vue> = {}) => {
    const s = session.current;
    if (!s) { setVue((v) => ({ ...v, ...surcharge })); return; }
    const etat = s.etat;
    const dernier = etat.echantillons[etat.echantillons.length - 1];
    setVue((v) => ({
      ...v,
      phase: phaseDe(etat),
      resume: s.resume(),
      precisionM: dernier?.precisionM ?? null,
      segmentOuvert: etat.evenements.some((e) => e.statut === "OUVERT" && e.code === CODE_SEGMENT),
      segmentsSansQualification: etat.evenements.filter((e) => e.code === CODE_SEGMENT && (e.statut === "CLOS" || e.statut === "CLOS_PAR_ARRET") && !e.qualification).length,
      ...surcharge,
    }));
  }, []);

  const stockageOuvert = useCallback((): StockageJournal => (stockage.current ??= ouvrirStockage()), []);

  // Au chargement : une session interrompue (page fermee, telephone redemarre) est proposee a la reprise.
  useEffect(() => {
    let vivant = true;
    void stockageOuvert().toutes().then((entrees) => {
      if (!vivant || entrees.length === 0) return;
      const r = SessionRoulage.rejouer(entrees, { horloge: horlogeSysteme(), genererId: () => crypto.randomUUID(), journal: stockageOuvert().ajouter });
      if (!r.ok) { if (vivant) setRepriseRefusee(r.raison); return; }
      session.current = r.session;
      // Les listes (segment ouvert) et la mission reviennent telles qu'elles etaient a la fermeture de la page.
      const ouvert = r.session.etat.evenements.find((e) => e.statut === "OUVERT" && e.code === CODE_SEGMENT);
      setSaisie(saisieDepuisQualification(ouvert?.qualification));
      setMissionId(lireMissionGardee(r.session.etat.sessionId));
      setIntitule(lireIntitule(r.session.etat.sessionId));
      const envoyeLe = lireEnvoiConfirme(r.session.etat.sessionId);
      if (envoyeLe) setEnvoi("envoye");
      setInterrompue({ positions: r.session.etat.echantillons.length, arretee: r.session.etat.statut === "ARRETEE", envoyeLe });
      rafraichir();
    }).catch(() => undefined);
    return () => { vivant = false; };
  }, [rafraichir, stockageOuvert]);

  const arreterSuivi = useCallback(() => {
    if (suivi.current !== null) { navigator.geolocation.clearWatch(suivi.current); suivi.current = null; }
    void veille.current?.liberer();
    veille.current = null;
    accelEchantillons.current = [];
  }, []);

  /** Phase 3 : lecture de l'accelerometre vertical, ACTIF seulement si l'agent l'a
   *  active. Chaque echantillon reste local ; l'indice agrege seul est affiche. */
  useEffect(() => {
    if (!accelActif || typeof window === "undefined" || !("DeviceMotionEvent" in window)) return undefined;
    const ecouter = (e: DeviceMotionEvent) => {
      const acc = e.accelerationIncludingGravity;
      if (acc && typeof acc.z === "number" && Number.isFinite(acc.z)) {
        // gravite ~9.81 soustraite : le pic est ce qui reste.
        accelEchantillons.current.push({ tMs: Date.now(), zMs2: acc.z - 9.81 });
        // Plafond memoire : 30 min a 10 Hz = 18 000 ; on garde la fin.
        if (accelEchantillons.current.length > 18_000) accelEchantillons.current = accelEchantillons.current.slice(-9_000);
      }
    };
    window.addEventListener("devicemotion", ecouter);
    return () => window.removeEventListener("devicemotion", ecouter);
  }, [accelActif]);

  const demarrerSuivi = useCallback(async () => {
    if (!("geolocation" in navigator)) { toast.error("Ce navigateur ne donne pas la position."); return; }
    veille.current = await garderEcranAllume();
    rafraichir({ ecranMaintenu: veille.current.actif });
    suivi.current = navigator.geolocation.watchPosition(
      (p) => {
        const s = session.current;
        if (!s) return;
        const r = s.ajouterEchantillon(positionVersEchantillon(p));
        if (r.accepte) {
          if (s.etat.interruptions.some((i) => i.cause === "GNSS_PERDU" && i.finMs === null)) s.signalerSysteme({ type: "GNSS_DISPONIBLE" });
          if (s.etat.interruptions.some((i) => i.cause === "PERMISSION_RETIREE" && i.finMs === null)) s.signalerSysteme({ type: "PERMISSION_ACCORDEE" });
        }
        rafraichir({ gnssIndisponible: false, permissionRefusee: false });
      },
      (e) => {
        const s = session.current;
        if (e.code === 1) { s?.signalerSysteme({ type: "PERMISSION_RETIREE" }); rafraichir({ permissionRefusee: true }); }
        else { s?.signalerSysteme({ type: "GNSS_INDISPONIBLE" }); rafraichir({ gnssIndisponible: true }); }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  }, [rafraichir]);

  // Ecran verrouille ou onglet cache : le navigateur coupe la position. On l'ENREGISTRE (interruption), on ne le cache pas.
  useEffect(() => {
    function auChangement() {
      const s = session.current;
      if (!s || s.etat.statut === "ARRETEE") return;
      if (document.visibilityState === "hidden") {
        s.signalerSysteme({ type: "VEILLE_DEBUT" });
      } else {
        s.signalerSysteme({ type: "VEILLE_FIN" });
        void garderEcranAllume().then((v) => { veille.current = v; rafraichir({ ecranMaintenu: v.actif }); });
      }
      rafraichir();
    }
    document.addEventListener("visibilitychange", auChangement);
    return () => document.removeEventListener("visibilitychange", auChangement);
  }, [rafraichir]);

  useEffect(() => {
    const t = window.setInterval(() => { if (session.current?.etat.statut !== "ARRETEE") rafraichir(); }, 1000);
    return () => { window.clearInterval(t); arreterSuivi(); };
  }, [rafraichir, arreterSuivi]);

  // Une session qui enregistre ne doit pas se perdre par un geste malheureux (fermeture de l'onglet, retour arriere) :
  // le navigateur demande confirmation. La session est de toute facon gardee sur l'appareil ; ceci evite le trou de trace.
  useEffect(() => {
    function avantFermeture(e: BeforeUnloadEvent) {
      if (session.current?.etat.statut !== "EN_COURS") return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", avantFermeture);
    return () => window.removeEventListener("beforeunload", avantFermeture);
  }, []);

  // Retour du reseau : une session terminee dont l'envoi a echoue FAUTE DE RESEAU est renvoyee une fois, sans geste. Un
  // renvoi est sans danger (meme operationId : le serveur repond « deja enregistree »). Un refus definitif n'est pas rejoue.
  const envoiAutoPour = useRef<string | null>(null);
  useEffect(() => {
    // Un nouveau passage hors ligne ré-arme la reprise automatique : une seule tentative par retour du réseau.
    if (!enLigne) { envoiAutoPour.current = null; return; }
    const s = session.current;
    if (!s || s.etat.statut !== "ARRETEE" || envoi !== "echec" || !envoiRetentable) return;
    if (envoiAutoPour.current === s.etat.sessionId) return;
    envoiAutoPour.current = s.etat.sessionId;
    void envoyer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enLigne, envoi, envoiRetentable]);

  async function telechargerPack() {
    setPackEnCours(true);
    try {
      const refs = await chargerReferentielsDefautsTerrain();
      await chargerVocabulairesQualification();
      await demanderStockagePersistant();
      const etat = etatPackMission();
      setPack(etat);
      if (!navigator.onLine) toast.error("Hors ligne : rien n'a pu être téléchargé.");
      else if (refs.tronconsIncomplets) toast.error(`Pack INCOMPLET : ${refs.troncons.length} tronçon(s) sur ${refs.tronconsTotal ?? "un total inconnu"}. Réessayer en ligne ; ne pas partir hors réseau avec ce pack.`);
      else toast.success(`Mission prête : ${refs.troncons.length} tronçons, ${refs.catalogue.length} types de défauts en cache.`);
    } catch {
      toast.error("Téléchargement du pack impossible : réessayez en ligne.");
    } finally {
      setPackEnCours(false);
    }
  }

  async function demarrer() {
    await stockageOuvert().vider();
    const r = SessionRoulage.demarrer({
      horloge: horlogeSysteme(), genererId: () => crypto.randomUUID(), journal: stockageOuvert().ajouter, agentRef: user?.id ?? null,
      parametres: profilParCode(profil).parametres,
    });
    if (!r.ok) { toast.error(r.erreurs.join(" ")); return; }
    session.current = r.session;
    garderIntitule(r.session.etat.sessionId, intitule.trim());
    // Demande au navigateur de ne pas purger la session si l'appareil manque de place ; sans effet garanti, rien n'est promis.
    void demanderStockagePersistant();
    void estimerStockage().then(setStockageEstime);
    setInterrompue(null);
    setEnvoi("aucun");
    setConfirmerSuppression(false);
    setSuivreCarte(true);
    // Rien ne vient de la session precedente : ni qualification, ni mission.
    setSaisie(SAISIE_VIDE);
    setMissionId("");
    rafraichir();
    await demarrerSuivi();
  }

  async function reprendreInterrompue() {
    const s = session.current;
    if (!s) return;
    s.reprendreApresRedemarrage();
    setInterrompue(null);
    rafraichir();
    await demarrerSuivi();
  }

  async function oublier() {
    arreterSuivi();
    if (session.current) {
      const id = session.current.etat.sessionId;
      garderMission(id, "");
      garderIntitule(id, "");
      oublierEnvoi(id);
    }
    await stockageOuvert().vider();
    setIndiceAccel(null);
    setRepriseRefusee(null);
    setConfirmerSuppression(false);
    setIntitule("");
    session.current = null;
    setInterrompue(null);
    setEnvoi("aucun");
    setSaisie(SAISIE_VIDE);
    setMissionId("");
    setVue(VUE_VIDE);
  }

  function choisirMission(id: string) {
    setMissionId(id);
    if (session.current) garderMission(session.current.etat.sessionId, id);
  }

  /**
   * Une liste de qualification change. Segment OUVERT : la qualification de ce segment est mise a jour tout de suite
   * (saisie a la fin du segment, ou changement d'avis), et journalisee. Pas de segment ouvert : elle servira au
   * PROCHAIN segment. Un champ remis sur « Non relevé » efface cette part de la qualification : aucune valeur ne reste.
   */
  function changerQualification(champ: keyof SaisieQualification, valeur: string) {
    const suivante = { ...saisie, [champ]: valeur };
    setSaisie(suivante);
    const s = session.current;
    const ouvert = s?.etat.evenements.find((e) => e.statut === "OUVERT" && e.code === CODE_SEGMENT);
    if (!s || !ouvert) return;
    const q = construireQualification(suivante, vocab?.refs ?? null);
    if (memeQualification(q, ouvert.qualification)) return;
    const r = s.qualifierEvenement(ouvert.id, q);
    if (!r.ok) toast.error(r.message);
    rafraichir();
  }

  function poserRepere() {
    const r = session.current?.poserMarqueur(CODE_REPERE, { note: note.trim() || null });
    if (!r) return;
    if (!r.ok) toast.error(r.message); else { toast.success("Repère posé."); setNote(""); }
    rafraichir();
  }

  function basculerSegment() {
    const s = session.current;
    if (!s) return;
    if (vue.segmentOuvert) {
      const ouvert = s.etat.evenements.find((e) => e.statut === "OUVERT" && e.code === CODE_SEGMENT);
      const r = ouvert ? s.finEvenement(ouvert.id) : null;
      if (r && !r.ok) toast.error(r.message);
      // Segment clos : la qualification ne se reporte pas sur le suivant, l'agent la rechoisit.
      else setSaisie(SAISIE_VIDE);
    } else {
      const r = s.debutEvenement(CODE_SEGMENT, { note: note.trim() || null, qualification: construireQualification(saisie, vocab?.refs ?? null) });
      if (!r.ok) toast.error(r.message); else setNote("");
    }
    rafraichir();
  }

  function arreter(politique: "REFUSER" | "CLORE" | "ABANDONNER") {
    const s = session.current;
    if (!s) return;
    const r = s.arreter(politique);
    if (!r.ok) {
      if (r.refus === "EVENEMENTS_OUVERTS") { setChoixArret(true); return; }
      toast.error(r.message);
      return;
    }
    setChoixArret(false);
    if (accelActif) setIndiceAccel(indiceIrregularite(accelEchantillons.current));
    arreterSuivi();
    rafraichir();
  }

  /** Pose la session en pause (journalisee, donc retrouvee), libere le GPS et quitte l'ecran : aucune position n'est perdue. */
  function enregistrerEtQuitter() {
    const s = session.current;
    if (s && s.etat.statut === "EN_COURS") s.mettreEnPause();
    arreterSuivi();
    rafraichir();
    navigate("/inspections/releve");
  }

  function telechargerGpx() {
    const s = session.current;
    if (!s) return;
    const blob = new Blob([versGpx(s.etat)], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nomFichierGpx(s.etat.debutMs);
    a.click();
    URL.revokeObjectURL(url);
  }

  async function envoyer() {
    const s = session.current;
    if (!s || !user) return;
    const p = construirePayload(s.etat, { missionId: missionId || null });
    if (!p.ok) {
      setEnvoi("echec");
      setMessageEnvoi(p.refus === "TROP_PEU_DE_POINTS" ? "Moins de deux positions retenues : rien à envoyer." : "La session n'est pas terminée.");
      return;
    }
    setEnvoi("en_cours");
    setEnvoiRetentable(false);
    try {
      const appareilId = await obtenirAppareil(user.id);
      const { data } = await api.post("/v2/sync/push", { appareilId, operations: [operationPourSynchronisation(p.payload)] });
      const suite = interpreterReponse(data?.resultats?.[0]);
      if (suite.action === "RETIRER_DE_LA_FILE") {
        // Retenu sur l'appareil SEULEMENT apres la confirmation du serveur.
        noterEnvoiConfirme(s.etat.sessionId);
        setEnvoi("envoye");
        setMessageEnvoi(suite.rejeu ? "Cette session était déjà enregistrée sur le serveur : rien n'a été dupliqué." : "Session enregistrée sur le serveur.");
      } else {
        setEnvoi("echec");
        setEnvoiRetentable(suite.action !== "ABANDONNER");
        setMessageEnvoi(suite.action === "ABANDONNER"
          ? `Refusée par le serveur (${suite.motif}). La session reste sur ce téléphone ; le GPX peut être téléchargé.`
          : `Pas confirmée (${suite.motif}). On peut réessayer ; la session reste sur ce téléphone.`);
      }
    } catch {
      setEnvoi("echec");
      setEnvoiRetentable(true);
      setMessageEnvoi("Envoi impossible (réseau). La session reste sur ce téléphone : réessayer plus tard, ou télécharger le GPX.");
    }
  }

  const r = vue.resume;
  const enCours = vue.phase === "en_cours" || vue.phase === "pause";
  const dureeS = session.current ? Math.max(0, Math.round(((session.current.etat.finMs ?? Date.now()) - session.current.etat.debutMs) / 1000)) : 0;
  const stockageMemoire = stockage.current?.nature === "memoire";
  // Lue dans la SESSION, pas dans les listes : ce qu'on affiche est ce qui sera envoye.
  const qualificationOuverte = session.current?.etat.evenements.find((e) => e.statut === "OUVERT" && e.code === CODE_SEGMENT)?.qualification ?? null;
  const etatBrut = session.current?.etat ?? null;
  const dernierEchantillon = etatBrut?.echantillons[etatBrut.echantillons.length - 1] ?? null;
  const vide = r ? sessionVide(r) : false;
  const finOuMaintenant = etatBrut ? (etatBrut.finMs ?? Date.now()) : 0;
  const dureeTotaleMs = etatBrut ? Math.max(0, finOuMaintenant - etatBrut.debutMs) : 0;
  const dureePausesMs = etatBrut ? etatBrut.pauses.reduce((n, p) => n + Math.max(0, (p.finMs ?? finOuMaintenant) - p.debutMs), 0) : 0;
  const qualite = r ? qualiteTrace(r, dureeTotaleMs) : null;
  // Phase 5 : profil de completude, calcule sur l'ETAT courant de la session, et seulement une fois arretee. Il ne doit PAS
  // etre memoise sur l'identite de l'etat : le noyau le mute en place, un `useMemo([etat])` garderait pour toujours le profil
  // du premier rendu (0 position, « pas de trace exploitable »).
  const profilCompletude = vue.phase === "arretee" && etatBrut ? evaluerCompletude({
    echantillons: etatBrut.echantillons, trous: etatBrut.trous, interruptions: etatBrut.interruptions,
    pauses: etatBrut.pauses, debutMs: etatBrut.debutMs, finMs: etatBrut.finMs, maintenantMs: Date.now(), precisionFiableM: 15,
  }) : null;
  const etatVue = etatSessionVue({ phase: vue.phase, vide, gpsInterrompu: vue.gnssIndisponible || vue.permissionRefusee, envoi });
  const libelleEtat = LIBELLES_ETAT[etatVue];
  // La trace n'est reconstruite que lorsqu'une position est ajoutee, pas a chaque rafraichissement d'une seconde.
  const nombreEchantillons = r?.echantillons ?? 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const segmentsCarte = useMemo(() => segmentsPourCarte(session.current?.etat.echantillons ?? []), [nombreEchantillons, vue.phase]);
  const positionCarte: [number, number] | null = dernierEchantillon ? [dernierEchantillon.lat, dernierEchantillon.lon] : null;
  const vitesse = vitesseKmH(dernierEchantillon?.vitesseMs);
  const ageDernierMs = dernierEchantillon && vue.phase !== "arretee" ? Math.max(0, Date.now() - dernierEchantillon.tMs) : null;
  const tonClasse = { neutre: "border-gray-300 bg-white text-gray-900", ok: "border-green-300 bg-green-50 text-green-900", attention: "border-amber-300 bg-amber-50 text-amber-950", erreur: "border-red-300 bg-red-50 text-red-900" }[libelleEtat.ton];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Enregistrer un relevé en roulant</h1>
        <p className="mt-1 text-sm text-gray-700">
          Le téléphone enregistre sa position pendant le trajet. Pour analyser un fichier déjà enregistré, utiliser{" "}
          <Link className="underline" to="/inspections/releve">Relevé en véhicule</Link>.
        </p>
      </header>

      <section aria-labelledby="limites" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <h2 id="limites" className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" aria-hidden="true" />À savoir avant de partir</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><strong>Page ouverte au premier plan, écran allumé.</strong> Si l'écran s'éteint ou si vous changez d'application, le navigateur peut arrêter la position : le trou est noté dans la trace, jamais comblé.</li>
          <li><strong>Un passager manipule le téléphone, pas le conducteur.</strong></li>
          <li>Fixer le téléphone, activer le GPS en haute précision et brancher le chargeur.</li>
          <li>Cette fonction ne mesure ni l'IRI ni l'état de la chaussée, et ne prend pas de photo.</li>
          <li>Elle n'a pas encore été essayée sur un téléphone en roulant : la précision et la tenue de l'écran sont à vérifier lors d'un premier essai.</li>
        </ul>
      </section>

      {vue.permissionRefusee && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          La position est refusée pour ce site. L'autoriser dans les réglages du navigateur ; l'enregistrement reprend alors tout seul.
        </p>
      )}
      {vue.gnssIndisponible && (
        <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          Le signal GPS est perdu. La trace reprendra au prochain signal, sans relier les deux côtés.
        </p>
      )}
      {stockageMemoire && (
        <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          Ce navigateur ne permet pas de garder la session en mémoire locale : si la page se ferme, la session est perdue.
        </p>
      )}

      {/* Phase 1 SMART FIELD : un journal retrouve mais injouable est DIT — raison, donnees
          gardees sur l'appareil, choix explicite. Jamais un ecran vide qui ressemble a une perte. */}
      {repriseRefusee && !session.current && !interrompue && (
        <section aria-labelledby="reprise-refusee" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <h2 id="reprise-refusee" className="font-semibold">Une session est sur ce téléphone, mais elle ne peut pas être rouverte</h2>
          <p className="mt-1 text-gray-700">
            {repriseRefusee === "VERSION_JOURNAL_INCONNUE"
              ? "Le journal a été écrit par une version de l'application incompatible avec celle d'aujourd'hui."
              : "Le journal est incomplet : son début n'a pas été retrouvé."}{" "}
            Les données sont <strong>toujours sur cet appareil</strong>, rien n'a été envoyé ni supprimé.
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Si ces données comptent, ne les effacez pas : contactez la DSI avec la mention « journal de roulage {repriseRefusee === "VERSION_JOURNAL_INCONNUE" ? "version incompatible" : "début absent"} ».
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="danger" onClick={() => setConfirmerEffacementJournal(true)}>
              Effacer ce journal (données perdues)
            </Button>
            <Button type="button" variant="secondary" onClick={() => { setConfirmerEffacementJournal(false); setRepriseRefusee(null); }}>
              Décider plus tard
            </Button>
          </div>
          {confirmerEffacementJournal && (
            <div role="alertdialog" aria-labelledby="conf-journal" className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-red-950">
              <p id="conf-journal" className="font-semibold">Effacer définitivement ce journal ?</p>
              <p className="mt-1">Ses positions n'ont jamais été envoyées et ne peuvent plus être relues par cette version : elles seront perdues de ce téléphone, sans retour possible.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" variant="danger" onClick={() => { setConfirmerEffacementJournal(false); void oublier(); }}>Oui, effacer</Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmerEffacementJournal(false)}>Non, le garder</Button>
              </div>
            </div>
          )}
        </section>
      )}
      {!session.current && !interrompue && (
        <Card>
          <h2 className="font-semibold flex items-center gap-2"><Download className="h-4 w-4" aria-hidden="true" /> Préparer la mission (avant de partir)</h2>
          <p className="mt-1 text-xs text-gray-500">En ligne, ici : téléchargez ce dont la session aura besoin hors réseau. Ce qui est sur le téléphone :</p>
          <ul className="mt-2 space-y-1 text-sm" aria-label="État de la préparation">
            <li>{pack.troncons > 0 && !pack.tronconsIncomplets ? "✅" : pack.tronconsIncomplets ? "⚠️" : "⬜"} Référentiel des tronçons : <strong>{pack.troncons}</strong>{pack.tronconsTotal !== null ? ` sur ${pack.tronconsTotal}` : ""}{pack.tronconsLe ? ` (copie du ${new Date(pack.tronconsLe).toLocaleString("fr-FR")})` : " — aucun"}{pack.tronconsIncomplets && <strong className="ml-1 text-amber-900"> : INCOMPLET, le pack n'a pas tout le référentiel</strong>}</li>
            <li>{pack.catalogue > 0 ? "✅" : "⬜"} Catalogue des défauts : <strong>{pack.catalogue}</strong> type(s)</li>
            <li>{vocab ? "✅" : "⬜"} Vocabulaires de qualification {vocab?.copieDuLe ? `(copie du ${new Date(vocab.copieDuLe).toLocaleString("fr-FR")})` : vocab?.refs ? "" : " — absents"}</li>
            <li>{stockageEstime ? `✅ Place occupée sur l'appareil : ${stockageEstime.usageMo.toFixed(0)} Mo` : "⬜ Place sur l'appareil : inconnue"}</li>
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" disabled={packEnCours} onClick={() => void telechargerPack()}>
              <Download className="h-4 w-4" aria-hidden="true" /> {packEnCours ? "Téléchargement…" : (pack.troncons > 0 ? "Actualiser le pack" : "Télécharger le pack de mission")}
            </Button>
            <label className="flex items-center gap-2 text-sm text-gray-700" title="Module optionnel : les pics d'accélération deviennent un indice expérimental, jamais un défaut confirmé. Les mesures ne quittent pas le téléphone.">
              <input
                type="checkbox" checked={accelActif}
                onChange={(e) => setAccelActif(e.target.checked)}
              />
              Mesurer les irrégularités (accéléromètre)
            </label>
            <p className="basis-full text-xs text-gray-600">
              Indice expérimental : il suppose le téléphone posé à plat, écran vers le haut. Fixé à la verticale, il n'a pas de sens. Il n'est qu'affiché, jamais envoyé au serveur.
            </p>
          </div>
          <CapacitesAppareilPanel />
        </Card>
      )}
      {interrompue && (
        <section aria-labelledby="reprise" className="rounded-lg border border-gray-300 bg-white p-4 text-sm">
          <h2 id="reprise" className="font-semibold">Une session a été retrouvée sur ce téléphone</h2>
          {interrompue.positions === 0 ? (
            <>
              <p className="mt-1" role="status">
                Cette session ne contient <strong>aucune position</strong> : le GPS n'a rien enregistré avant l'arrêt ou la fermeture de la page. Ce n'est pas un relevé, il n'y a rien à envoyer.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => void oublier()}><RotateCcw className="h-4 w-4" aria-hidden="true" />Recommencer</Button>
              </div>
            </>
          ) : (
            <>
              <p className="mt-1">
                {interrompue.positions} position(s) enregistrée(s)
                {interrompue.arretee
                  ? interrompue.envoyeLe ? `, session terminée et déjà confirmée par le serveur le ${new Date(interrompue.envoyeLe).toLocaleString("fr-FR")}` : ", session terminée mais pas encore envoyée"
                  : ", session interrompue (page fermée ou téléphone redémarré)"}.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {!interrompue.arretee && <Button onClick={() => void reprendreInterrompue()}><Play className="h-4 w-4" aria-hidden="true" />Reprendre l'enregistrement</Button>}
                {interrompue.arretee && <Button onClick={() => setInterrompue(null)}>Voir la session</Button>}
                {interrompue.envoyeLe
                  ? <Button variant="outline" onClick={() => void oublier()}><RotateCcw className="h-4 w-4" aria-hidden="true" />Nouveau relevé</Button>
                  : <Button variant="outline" onClick={() => setConfirmerSuppression(true)}><Trash2 className="h-4 w-4" aria-hidden="true" />Supprimer cette session</Button>}
              </div>
              {!interrompue.arretee && <p className="mt-2 text-xs text-gray-600">Le temps écoulé depuis la dernière position sera noté comme une interruption : on ne sait pas où le véhicule est passé.</p>}
              {confirmerSuppression && (
                <div role="alertdialog" aria-labelledby="conf-titre" className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-950">
                  <p id="conf-titre" className="font-semibold">Supprimer cette session ?</p>
                  <p className="mt-1">{interrompue.positions} position(s) {interrompue.envoyeLe ? "" : "qui n'ont pas été envoyées au serveur "}seront perdues de ce téléphone. Cette action est définitive.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="danger" onClick={() => void oublier()}>Oui, supprimer</Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirmerSuppression(false)}>Non, la garder</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {vue.phase === "repos" && !interrompue && (
        <section aria-labelledby="preparation" className="max-w-xl space-y-4 rounded-lg border border-gray-300 bg-white p-4">
          <h2 id="preparation" className="text-lg font-semibold">Préparer le relevé</h2>
          <div>
            <label htmlFor="intitule" className="block text-sm font-medium">Intitulé (facultatif)</label>
            <input id="intitule" value={intitule} maxLength={120} onChange={(e) => setIntitule(e.target.value)} placeholder="Ex. : RN1 Coyah – Kindia, reconnaissance"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
            <p className="mt-1 text-xs text-gray-600">Gardé sur ce téléphone avec la session ; la route et le tronçon sont retrouvés par le serveur à partir de la trace, la mission se choisit ci-dessous.</p>
          </div>
          <fieldset>
            <legend className="text-sm font-medium">Profil de précision</legend>
            <div className="mt-1 space-y-1">
              {PROFILS_PRECISION.map((pr) => (
                <label key={pr.code} className="flex items-start gap-2 text-sm">
                  <input type="radio" name="profil" value={pr.code} checked={profil === pr.code} onChange={() => setProfil(pr.code)} className="mt-1" />
                  <span><strong>{pr.libelle}</strong> : {pr.explication}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-600">Seuils de départ provisoires, non calibrés sur un téléphone. Le profil choisi est enregistré avec la session.</p>
          </fieldset>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3" aria-label="Contrôles avant le départ">
            <div className="rounded-md border border-gray-200 p-2">
              <dt className="text-xs text-gray-600">Position (GPS)</dt>
              <dd className={permissionGps === "refusee" ? "font-semibold text-red-800" : ""}>
                {permissionGps === "accordee" ? "Autorisée" : permissionGps === "refusee" ? "Refusée : l'autoriser dans le navigateur" : permissionGps === "a_demander" ? "Sera demandée au démarrage" : "Sera demandée au démarrage"}
              </dd>
            </div>
            <div className="rounded-md border border-gray-200 p-2">
              <dt className="text-xs text-gray-600">Réseau</dt>
              <dd className={enLigne ? "" : "font-semibold text-amber-900"}>{enLigne ? "En ligne" : "Hors ligne : la session sera gardée sur le téléphone"}</dd>
            </div>
            <div className="rounded-md border border-gray-200 p-2">
              <dt className="text-xs text-gray-600">Stockage du téléphone</dt>
              <dd className={stockageProche(stockageEstime) ? "font-semibold text-red-800" : ""}>
                {stockageEstime === null ? "Non communiqué par le navigateur" : stockageProche(stockageEstime) ? `Presque plein (${Math.round(stockageEstime.part * 100)} %) : libérer de la place avant de partir` : `${Math.round(stockageEstime.part * 100)} % utilisé`}
              </dd>
            </div>
          </dl>
          <Button size="lg" onClick={() => void demarrer()}><MapPin className="h-4 w-4" aria-hidden="true" />Démarrer l'enregistrement</Button>
        </section>
      )}

      {/* Tant qu'une session retrouvee attend le choix de l'agent (reprendre, voir, supprimer), son ecran n'est pas montre : il laisserait croire qu'elle enregistre. */}
      {!interrompue && (enCours || vue.phase === "arretee") && r && (
        <section aria-labelledby="etat" className="space-y-4">
          <h2 id="etat" className={`rounded-lg border px-3 py-2 text-lg font-semibold ${tonClasse}`}>{libelleEtat.libelle}</h2>
          {intitule.trim() !== "" && <p className="text-sm text-gray-700">{intitule.trim()}</p>}
          <ul className="flex flex-wrap gap-2 text-xs" aria-label="États du GPS, du réseau et de la conservation">
            <li className={`rounded-full border px-2 py-1 ${vue.permissionRefusee || vue.gnssIndisponible ? "border-red-300 bg-red-50 text-red-900" : "border-gray-300 bg-white"}`}>
              GPS : {vue.permissionRefusee ? "refusé" : vue.gnssIndisponible ? "signal perdu" : vue.phase === "arretee" ? "arrêté" : dernierEchantillon ? "signal reçu" : "en attente du premier signal"}
            </li>
            <li className={`rounded-full border px-2 py-1 ${enLigne ? "border-gray-300 bg-white" : "border-amber-300 bg-amber-50 text-amber-950"}`}>Réseau : {enLigne ? "en ligne" : "hors ligne"}</li>
            <li className="rounded-full border border-gray-300 bg-white px-2 py-1">
              Conservation : {envoi === "envoye" ? "confirmée par le serveur" : stockageMemoire ? "mémoire de la page seulement" : "sur ce téléphone, pas encore envoyée"}
            </li>
            {stockageProche(stockageEstime) && <li className="rounded-full border border-red-300 bg-red-50 px-2 py-1 text-red-900">Stockage presque plein</li>}
          </ul>
          {vue.phase !== "arretee" && (
            <>
              <CarteTraceRoulage segments={segmentsCarte} position={positionCarte} precisionM={vue.precisionM} suivre={suivreCarte} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={suivreCarte} onChange={(e) => setSuivreCarte(e.target.checked)} />
                Centrer la carte sur ma position
              </label>
            </>
          )}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-white p-3"><dt className="text-xs text-gray-600">Durée</dt><dd className="text-lg font-semibold">{libelleDuree(dureeS)}</dd></div>
            <div className="rounded-lg border border-gray-200 bg-white p-3"><dt className="text-xs text-gray-600">Distance estimée</dt><dd className="text-lg font-semibold">{libelleKm(r.distanceM)}</dd></div>
            <div className="rounded-lg border border-gray-200 bg-white p-3"><dt className="text-xs text-gray-600">Positions retenues</dt><dd className="text-lg font-semibold">{r.echantillons}</dd></div>
            <div className="rounded-lg border border-gray-200 bg-white p-3"><dt className="text-xs text-gray-600">Précision actuelle</dt><dd className="text-lg font-semibold">{vue.precisionM === null ? "inconnue" : `${Math.round(vue.precisionM)} m`}</dd></div>
            {vue.phase !== "arretee" && (
              <>
                <div className="rounded-lg border border-gray-200 bg-white p-3"><dt className="text-xs text-gray-600">Vitesse GPS</dt><dd className="text-lg font-semibold">{vitesse === null ? "non communiquée" : `${Math.round(vitesse)} km/h`}</dd></div>
                <div className="rounded-lg border border-gray-200 bg-white p-3"><dt className="text-xs text-gray-600">Dernière position valide</dt><dd className="text-lg font-semibold">{ageDernierMs === null ? "aucune" : ageDernierMs < 2000 ? "à l'instant" : `il y a ${libelleDuree(Math.round(ageDernierMs / 1000))}`}</dd></div>
              </>
            )}
          </dl>
          {vue.phase === "arretee" && profilCompletude && (
            <section aria-labelledby="completude" className="rounded-lg border border-gray-200 bg-white p-3">
              <h3 id="completude" className="text-sm font-semibold text-navy">Complétude du relevé</h3>
              <dl className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                <div><dt className="text-xs text-gray-600">Positions fiables (≤ 15 m, seuil provisoire)</dt><dd className="font-semibold">{profilCompletude.fiables}/{profilCompletude.echantillons}</dd></div>
                <div><dt className="text-xs text-gray-600">Temps avec signal</dt><dd className="font-semibold">{Math.round(profilCompletude.partTempsAvecSignal * 100)} %</dd></div>
                <div><dt className="text-xs text-gray-600">Interruptions</dt><dd className="font-semibold">{profilCompletude.interruptions} · {Math.round(profilCompletude.interruptionsMs / 60_000)} min</dd></div>
              </dl>
              <ul className="mt-2 space-y-1 text-xs text-amber-800">
                {profilCompletude.avertissements.map((a) => <li key={a}>· {a}</li>)}
              </ul>
            </section>
          )}
          {vue.phase === "arretee" && indiceAccel && !indiceAccel.capteurAbsent && indiceAccel.totalPics > 0 && (
            <section aria-labelledby="indice" className="rounded-lg border border-gray-200 bg-white p-3">
              <h3 id="indice" className="text-sm font-semibold text-navy">Indice d'irrégularité ({indiceAccel.version})</h3>
              <p className="mt-1 text-sm">{indiceAccel.totalPics} pic(s) d'accélération sur {indiceAccel.fenetres.length} fenêtre(s) de 30 s.</p>
              <p className="mt-1 text-xs text-amber-800">{indiceAccel.avertissement}</p>
            </section>
          )}
          <p className="text-xs text-gray-600">La distance est une estimation faite sur les positions retenues, sans rapprochement au réseau routier : ce n'est pas une mesure exacte.</p>
          <p className="text-xs text-gray-600">
            {r.rejetsTotal} position(s) écartée(s) (précision insuffisante, saut ou doublon) · {r.trous} trou(s) de signal · {r.marqueurs} repère(s) · {r.evenementsClos} segment(s) clos
            {vue.ecranMaintenu === false && enCours ? " · l'écran n'est PAS maintenu allumé par ce navigateur : le garder allumé à la main" : ""}
          </p>
          {vue.segmentsSansQualification > 0 && (
            <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              {vue.segmentsSansQualification} segment(s) clos sans qualification : le serveur n'en tirera aucune portion (rien n'est deviné). Seuls les segments qualifiés deviennent des portions proposées, à valider par un tiers.
            </p>
          )}

          {(enCours || vue.phase === "arretee") && (
            <div className="max-w-xl">
              <label htmlFor="mission" className="block text-sm font-medium">Mission (facultative)</label>
              <select
                id="mission" value={missionId} onChange={(e) => choisirMission(e.target.value)}
                disabled={envoi === "en_cours" || envoi === "envoye"}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">Aucune mission</option>
                {missionId && !(Array.isArray(missions) && missions.some((m) => m.id === missionId)) && <option value={missionId}>Mission déjà choisie (hors liste)</option>}
                {Array.isArray(missions) && missions.map((m) => <option key={m.id} value={m.id}>{libelleMission(m)}</option>)}
              </select>
              <p className="mt-1 text-xs text-gray-600">
                {missions === "chargement" ? "Chargement des missions…"
                  : missions === null ? "Missions indisponibles (hors ligne ou serveur injoignable) : la session partira sans lien à une mission."
                  : missions.length === 0 ? "Aucune mission assignée à votre compte ou créée par vous : la session partira sans lien à une mission."
                  : "Seules les missions qui vous sont assignées ou que vous avez créées sont proposées : le serveur refuse tout le relevé pour une autre."}
              </p>
            </div>
          )}

          {enCours && (
            <>
              <div>
                <label htmlFor="note" className="block text-sm font-medium">Note (facultative, pour le prochain repère ou segment)</label>
                <input id="note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full max-w-xl rounded-md border border-gray-300 px-3 py-2 text-sm" />
              </div>
              <fieldset className="max-w-xl rounded-lg border border-gray-300 bg-white p-3">
                <legend className="px-1 text-sm font-medium">Qualification du segment</legend>
                <p className="text-xs text-gray-600">
                  {vue.segmentOuvert
                    ? "Segment ouvert : ce que vous choisissez ici qualifie CE segment, à tout moment jusqu'à sa fin."
                    : "À choisir avant le début du segment, ou pendant qu'il est ouvert. Rien n'est reporté d'un segment au suivant."}
                  {" "}Ce sont des choix de l'agent, pas des mesures : chaque portion reste une proposition à valider.
                </p>
                {vocab && vocab.refs === null && (
                  <p role="status" className="mt-2 text-xs text-amber-800">
                    Les vocabulaires du serveur n'ont pas pu être chargés et aucune copie n'est gardée sur ce téléphone : les segments seront enregistrés sans qualification. Ouvrir cet écran avec du réseau avant de partir.
                  </p>
                )}
                {vocab?.enCache && vocab.copieDuLe && (
                  <p role="status" className="mt-2 text-xs text-gray-600">
                    Listes gardées sur ce téléphone depuis le {new Date(vocab.copieDuLe).toLocaleString("fr-FR")} (réseau indisponible à l'ouverture). Un code retiré depuis ferait refuser la portion par le serveur, avec le motif.
                  </p>
                )}
                {[
                  { champ: "revetement" as const, id: "q-revetement", libelle: "Revêtement", valeurs: vocab?.refs?.revetements, desactive: !vocab?.refs },
                  { champ: "etat" as const, id: "q-etat", libelle: "État de chaussée", valeurs: vocab?.refs?.etats, desactive: !vocab?.refs },
                  { champ: "praticabilite" as const, id: "q-praticabilite", libelle: "Praticabilité", valeurs: vocab?.refs?.praticabilites, desactive: !vocab?.refs || vocab.refs.praticabiliteNonDefinie },
                ].map((c) => (
                  <div key={c.champ} className="mt-2">
                    <label htmlFor={c.id} className="block text-sm">{c.libelle}</label>
                    <select
                      id={c.id} value={saisie[c.champ]} onChange={(e) => changerQualification(c.champ, e.target.value)}
                      disabled={c.desactive}
                      className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                    >
                      <option value="">Non relevé</option>
                      {valeursActives(c.valeurs).map((v) => <option key={v.code} value={v.code}>{v.libelle}</option>)}
                    </select>
                    {c.champ === "praticabilite" && vocab?.refs?.praticabiliteNonDefinie && (
                      <p className="mt-1 text-xs text-amber-800">Vocabulaire non défini par AGEROUTE : ce champ reste indisponible, et aucune valeur n'a été inventée.</p>
                    )}
                  </div>
                ))}
                {vue.segmentOuvert && (
                  <p className="mt-2 text-xs text-gray-700" aria-live="polite">
                    Qualification enregistrée pour ce segment : {libelleQualification(qualificationOuverte, vocab?.refs ?? null)}.
                  </p>
                )}
              </fieldset>
              {vue.phase === "en_cours" && user && etatBrut && (
                <ObservationRapideRoulage
                  position={dernierEchantillon ? { lat: dernierEchantillon.lat, lon: dernierEchantillon.lon, precisionM: dernierEchantillon.precisionM, ageMs: ageDernierMs ?? 0 } : null}
                  userId={user.id}
                  sessionId={etatBrut.sessionId}
                  missionId={missionId || null}
                />
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={poserRepere} disabled={vue.phase !== "en_cours"}><Flag className="h-4 w-4" aria-hidden="true" />Poser un repère ici</Button>
                <Button variant="outline" onClick={basculerSegment} disabled={vue.phase !== "en_cours"}>
                  {vue.segmentOuvert ? "Fin du segment" : "Début d'un segment"}
                </Button>
                {vue.phase === "en_cours"
                  ? <Button variant="outline" onClick={() => { session.current?.mettreEnPause(); rafraichir(); }}><Pause className="h-4 w-4" aria-hidden="true" />Pause</Button>
                  : <Button variant="outline" onClick={() => { session.current?.reprendre(); rafraichir(); }}><Play className="h-4 w-4" aria-hidden="true" />Reprendre</Button>}
                <Button variant="danger" onClick={() => arreter("REFUSER")}><Square className="h-4 w-4" aria-hidden="true" />Arrêter</Button>
                <Button variant="ghost" onClick={enregistrerEtQuitter}><LogOut className="h-4 w-4" aria-hidden="true" />Mettre en pause et quitter</Button>
              </div>
              <p className="text-xs text-gray-600">« Mettre en pause et quitter » garde la session sur ce téléphone : au retour sur cet écran, elle est proposée à la reprise, le temps écoulé étant noté comme une interruption.</p>
              {choixArret && (
                <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  <p>Un segment est encore ouvert. Le clore à l'instant de l'arrêt revient à décider où il se termine : à vous de choisir.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => arreter("CLORE")}>Le clore à l'instant de l'arrêt</Button>
                    <Button size="sm" variant="outline" onClick={() => arreter("ABANDONNER")}>L'abandonner</Button>
                    <Button size="sm" variant="ghost" onClick={() => setChoixArret(false)}>Continuer l'enregistrement</Button>
                  </div>
                </div>
              )}
            </>
          )}

          {vue.phase === "arretee" && vide && (
            <div className="space-y-3">
              <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
                <strong>Aucune position valide n'a été enregistrée.</strong> Ce n'est pas un relevé : il n'y a ni trace, ni distance, et rien à envoyer. Causes fréquentes : l'autorisation de position a été refusée, le signal GPS n'est pas arrivé (intérieur, tunnel, GPS coupé), ou l'enregistrement a été arrêté trop tôt. Sortir à l'air libre, vérifier que le GPS est activé en haute précision, puis recommencer.
              </p>
              <Button onClick={() => void oublier()}><RotateCcw className="h-4 w-4" aria-hidden="true" />Recommencer</Button>
            </div>
          )}

          {vue.phase === "arretee" && !vide && r && qualite && (
            <div className="space-y-3">
              <section aria-labelledby="resume" className="rounded-lg border border-gray-300 bg-white p-4 text-sm">
                <h3 id="resume" className="font-semibold">Résumé du relevé</h3>
                <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                  <div className="flex justify-between gap-2"><dt className="text-gray-600">Distance estimée</dt><dd>{libelleKm(r.distanceM)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-gray-600">Durée totale</dt><dd>{libelleDuree(Math.round(dureeTotaleMs / 1000))}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-gray-600">Durée effective d'enregistrement</dt><dd>{libelleDuree(Math.round(dureeEffectiveMs(dureeTotaleMs, r, dureePausesMs) / 1000))}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-gray-600">Positions valides</dt><dd>{r.echantillons}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-gray-600">Interruptions et trous de signal</dt><dd>{r.interruptions} · {r.trous}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-gray-600">Pauses</dt><dd>{r.pauses}</dd></div>
                </dl>
                <p className={`mt-3 rounded-md border px-3 py-2 ${qualite.niveau === "bonne" ? "border-green-300 bg-green-50 text-green-900" : qualite.niveau === "moyenne" ? "border-amber-300 bg-amber-50 text-amber-950" : "border-red-300 bg-red-50 text-red-900"}`}>
                  <strong>{qualite.libelle}.</strong> {qualite.raisons.join(" ")} <span className="text-xs">(Indicatif : seuils provisoires, non calibrés ; ce n'est pas une mesure de l'exactitude de la position.)</span>
                </p>
                <div className="mt-3">
                  <CarteTraceRoulage segments={segmentsCarte} position={null} precisionM={null} suivre={false} />
                </div>
              </section>
              <div className="flex flex-wrap gap-2">
                <Button onClick={telechargerGpx}><Download className="h-4 w-4" aria-hidden="true" />Télécharger le GPX</Button>
                <Button variant="outline" onClick={() => void envoyer()} disabled={envoi === "en_cours" || envoi === "envoye"}>
                  <Send className="h-4 w-4" aria-hidden="true" />{envoi === "echec" ? "Renvoyer la session" : "Envoyer la session au serveur"}
                </Button>
                {envoi === "envoye"
                  ? <Button variant="ghost" onClick={() => void oublier()}><RotateCcw className="h-4 w-4" aria-hidden="true" />Nouveau relevé</Button>
                  : <Button variant="ghost" onClick={() => setConfirmerSuppression(true)} disabled={envoi === "en_cours"}><Trash2 className="h-4 w-4" aria-hidden="true" />Supprimer sans envoyer</Button>}
              </div>
              {confirmerSuppression && envoi !== "envoye" && (
                <div role="alertdialog" aria-labelledby="conf-titre-2" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-950">
                  <p id="conf-titre-2" className="font-semibold">Supprimer cette session sans l'envoyer ?</p>
                  <p className="mt-1">{r.echantillons} position(s) n'ont pas été confirmées par le serveur et seront perdues de ce téléphone. Cette action est définitive. Télécharger le GPX d'abord permet d'en garder une copie.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="danger" onClick={() => void oublier()}>Oui, supprimer</Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirmerSuppression(false)}>Non, la garder</Button>
                  </div>
                </div>
              )}
              {envoi === "en_cours" && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">Envoi en cours : la session reste sur ce téléphone jusqu'à la confirmation du serveur.</p>}
              {envoi !== "aucun" && envoi !== "en_cours" && (
                <p role="status" className={`rounded-lg border p-3 text-sm ${envoi === "envoye" ? "border-green-300 bg-green-50 text-green-900" : "border-red-300 bg-red-50 text-red-900"}`}>
                  {messageEnvoi}{envoi === "echec" && envoiRetentable && !enLigne ? " Un nouvel envoi sera tenté automatiquement au retour du réseau." : ""}
                </p>
              )}
              <p className="text-xs text-gray-600">Le fichier GPX peut ensuite être analysé dans <Link className="underline" to="/inspections/releve">Relevé en véhicule</Link> : tronçons parcourus, parties hors référentiel, indicateurs de qualité. Une trace GPS n'est pas une inspection validée.</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
