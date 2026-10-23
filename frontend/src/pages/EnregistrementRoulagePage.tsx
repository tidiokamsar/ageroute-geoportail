import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Download, Flag, MapPin, Pause, Play, Send, Square } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toast } from "../lib/toast";
import { Button } from "../components/ui/Button";
import { MesSessions } from "./roulage/MesSessions";
import { libelleDuree, libelleKm } from "../lib/releve";
import {
  garderEcranAllume, nomFichierGpx, ouvrirStockage, positionVersEchantillon, versGpx,
  type StockageJournal, type VerrouEcran,
} from "../lib/roulageHote";
import {
  construirePayload, horlogeSysteme, interpreterReponse, operationPourSynchronisation, SessionRoulage,
  type EtatSession, type ResumeSession,
} from "../roulage";
import {
  construireQualification, libelleMission, libelleQualification, memeQualification, saisieDepuisQualification, SAISIE_VIDE,
  valeursActives, type MissionListee, type SaisieQualification,
} from "../lib/qualificationSegment";
import { chargerMissionsDeLAgent, chargerVocabulairesQualification, type VocabulairesChargement } from "../lib/referentielsQualification";

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
  const session = useRef<SessionRoulage | null>(null);
  const stockage = useRef<StockageJournal | null>(null);
  const veille = useRef<VerrouEcran | null>(null);
  const suivi = useRef<number | null>(null);
  const [vue, setVue] = useState<Vue>(VUE_VIDE);
  const [note, setNote] = useState("");
  const [choixArret, setChoixArret] = useState(false);
  const [interrompue, setInterrompue] = useState<{ positions: number; arretee: boolean } | null>(null);
  const [envoi, setEnvoi] = useState<"aucun" | "en_cours" | "envoye" | "echec">("aucun");
  const [messageEnvoi, setMessageEnvoi] = useState("");
  const [vocab, setVocab] = useState<VocabulairesChargement | null>(null);
  const [saisie, setSaisie] = useState<SaisieQualification>(SAISIE_VIDE);
  const [missions, setMissions] = useState<MissionListee[] | null | "chargement">("chargement");
  const [missionId, setMissionId] = useState("");

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
      if (!r.ok) return;
      session.current = r.session;
      // Les listes (segment ouvert) et la mission reviennent telles qu'elles etaient a la fermeture de la page.
      const ouvert = r.session.etat.evenements.find((e) => e.statut === "OUVERT" && e.code === CODE_SEGMENT);
      setSaisie(saisieDepuisQualification(ouvert?.qualification));
      setMissionId(lireMissionGardee(r.session.etat.sessionId));
      setInterrompue({ positions: r.session.etat.echantillons.length, arretee: r.session.etat.statut === "ARRETEE" });
      rafraichir();
    }).catch(() => undefined);
    return () => { vivant = false; };
  }, [rafraichir, stockageOuvert]);

  const arreterSuivi = useCallback(() => {
    if (suivi.current !== null) { navigator.geolocation.clearWatch(suivi.current); suivi.current = null; }
    void veille.current?.liberer();
    veille.current = null;
  }, []);

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

  async function demarrer() {
    await stockageOuvert().vider();
    const r = SessionRoulage.demarrer({ horloge: horlogeSysteme(), genererId: () => crypto.randomUUID(), journal: stockageOuvert().ajouter, agentRef: user?.id ?? null });
    if (!r.ok) { toast.error(r.erreurs.join(" ")); return; }
    session.current = r.session;
    setInterrompue(null);
    setEnvoi("aucun");
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
    if (session.current) garderMission(session.current.etat.sessionId, "");
    await stockageOuvert().vider();
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
    arreterSuivi();
    rafraichir();
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
    try {
      const appareilId = await obtenirAppareil(user.id);
      const { data } = await api.post("/v2/sync/push", { appareilId, operations: [operationPourSynchronisation(p.payload)] });
      const suite = interpreterReponse(data?.resultats?.[0]);
      if (suite.action === "RETIRER_DE_LA_FILE") {
        setEnvoi("envoye");
        setMessageEnvoi(suite.rejeu ? "Cette session était déjà enregistrée sur le serveur : rien n'a été dupliqué." : "Session enregistrée sur le serveur.");
      } else {
        setEnvoi("echec");
        setMessageEnvoi(suite.action === "ABANDONNER"
          ? `Refusée par le serveur (${suite.motif}). La session reste sur ce téléphone ; le GPX peut être téléchargé.`
          : `Pas confirmée (${suite.motif}). On peut réessayer ; la session reste sur ce téléphone.`);
      }
    } catch {
      setEnvoi("echec");
      setMessageEnvoi("Envoi impossible (réseau). La session reste sur ce téléphone : réessayer plus tard, ou télécharger le GPX.");
    }
  }

  const r = vue.resume;
  const enCours = vue.phase === "en_cours" || vue.phase === "pause";
  const dureeS = session.current ? Math.max(0, Math.round(((session.current.etat.finMs ?? Date.now()) - session.current.etat.debutMs) / 1000)) : 0;
  const stockageMemoire = stockage.current?.nature === "memoire";
  // Lue dans la SESSION, pas dans les listes : ce qu'on affiche est ce qui sera envoye.
  const qualificationOuverte = session.current?.etat.evenements.find((e) => e.statut === "OUVERT" && e.code === CODE_SEGMENT)?.qualification ?? null;

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

      {interrompue && (
        <section aria-labelledby="reprise" className="rounded-lg border border-gray-300 bg-white p-4 text-sm">
          <h2 id="reprise" className="font-semibold">Une session a été retrouvée sur ce téléphone</h2>
          <p className="mt-1">{interrompue.positions} position(s) enregistrée(s){interrompue.arretee ? ", session terminée mais pas encore envoyée" : ", session interrompue (page fermée ou téléphone redémarré)"}.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {!interrompue.arretee && <Button onClick={() => void reprendreInterrompue()}><Play className="h-4 w-4" aria-hidden="true" />Reprendre l'enregistrement</Button>}
            {interrompue.arretee && <Button onClick={() => setInterrompue(null)}>Voir la session</Button>}
            <Button variant="outline" onClick={() => void oublier()}>Supprimer cette session</Button>
          </div>
          {!interrompue.arretee && <p className="mt-2 text-xs text-gray-600">Le temps écoulé depuis la dernière position sera noté comme une interruption : on ne sait pas où le véhicule est passé.</p>}
        </section>
      )}

      {vue.phase === "repos" && !interrompue && (
        <Button size="lg" onClick={() => void demarrer()}><MapPin className="h-4 w-4" aria-hidden="true" />Démarrer l'enregistrement</Button>
      )}

      {(enCours || vue.phase === "arretee") && r && (
        <section aria-labelledby="etat" className="space-y-4">
          <h2 id="etat" className="text-lg font-semibold">
            {vue.phase === "en_cours" ? "Enregistrement en cours" : vue.phase === "pause" ? "En pause" : "Enregistrement terminé"}
          </h2>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-white p-3"><dt className="text-xs text-gray-600">Durée</dt><dd className="text-lg font-semibold">{libelleDuree(dureeS)}</dd></div>
            <div className="rounded-lg border border-gray-200 bg-white p-3"><dt className="text-xs text-gray-600">Distance</dt><dd className="text-lg font-semibold">{libelleKm(r.distanceM)}</dd></div>
            <div className="rounded-lg border border-gray-200 bg-white p-3"><dt className="text-xs text-gray-600">Positions retenues</dt><dd className="text-lg font-semibold">{r.echantillons}</dd></div>
            <div className="rounded-lg border border-gray-200 bg-white p-3"><dt className="text-xs text-gray-600">Précision actuelle</dt><dd className="text-lg font-semibold">{vue.precisionM === null ? "inconnue" : `${Math.round(vue.precisionM)} m`}</dd></div>
          </dl>
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
              <div className="flex flex-wrap gap-2">
                <Button onClick={poserRepere} disabled={vue.phase !== "en_cours"}><Flag className="h-4 w-4" aria-hidden="true" />Poser un repère ici</Button>
                <Button variant="outline" onClick={basculerSegment} disabled={vue.phase !== "en_cours"}>
                  {vue.segmentOuvert ? "Fin du segment" : "Début d'un segment"}
                </Button>
                {vue.phase === "en_cours"
                  ? <Button variant="outline" onClick={() => { session.current?.mettreEnPause(); rafraichir(); }}><Pause className="h-4 w-4" aria-hidden="true" />Pause</Button>
                  : <Button variant="outline" onClick={() => { session.current?.reprendre(); rafraichir(); }}><Play className="h-4 w-4" aria-hidden="true" />Reprendre</Button>}
                <Button variant="danger" onClick={() => arreter("REFUSER")}><Square className="h-4 w-4" aria-hidden="true" />Arrêter</Button>
              </div>
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

          {vue.phase === "arretee" && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button onClick={telechargerGpx}><Download className="h-4 w-4" aria-hidden="true" />Télécharger le GPX</Button>
                <Button variant="outline" onClick={() => void envoyer()} disabled={envoi === "en_cours" || envoi === "envoye"}><Send className="h-4 w-4" aria-hidden="true" />Envoyer la session au serveur</Button>
                <Button variant="ghost" onClick={() => void oublier()} disabled={envoi !== "envoye" && envoi !== "aucun" && envoi !== "echec"}>
                  {envoi === "envoye" ? "Nouveau relevé" : "Supprimer sans envoyer"}
                </Button>
              </div>
              {envoi !== "aucun" && envoi !== "en_cours" && (
                <p role="status" className={`rounded-lg border p-3 text-sm ${envoi === "envoye" ? "border-green-300 bg-green-50 text-green-900" : "border-red-300 bg-red-50 text-red-900"}`}>{messageEnvoi}</p>
              )}
              <p className="text-xs text-gray-600">Le fichier GPX peut ensuite être analysé dans <Link className="underline" to="/inspections/releve">Relevé en véhicule</Link> : tronçons parcourus, parties hors référentiel, indicateurs de qualité.</p>
            </div>
          )}
        </section>
      )}

      {/* Pas pendant l'enregistrement : rien ne doit distraire du trajet. */}
      {!enCours && <MesSessions />}
    </div>
  );
}
