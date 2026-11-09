import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog";
import { toast } from "../../../lib/toast";
import { useInvalidationProjet } from "../../../lib/projetsVoirieHooks";
import { autoriserJeu, rejeterJeu } from "../../../lib/projetsVoirieApi";
import { classerErreur, type ErreurPv } from "../../../lib/projetsVoirie";
import {
  champsLecture, construireDonneesDepot, erreurCrs, erreurFormat, libelleEtape, modeCrs, type IdEtape, type Lecture, type LectureCsv, type OptionsImportApi, type Saisie,
} from "../../../lib/projetsVoirieImport";
import { etapeVoisine, etatInitial, reduire, retourPossible } from "../../../lib/projetsVoirieImportEtat";
import { CODES_LECTURE_TABLEAU } from "../../../lib/projetsVoirieImportErreurs";
import { apercevoirFichier, deposerAvecOptions, inventorierFichier, lireDeltaJeu, revenirEnArriere, revoirSuppressions } from "../../../lib/projetsVoirieImportApi";
import { useEnvoi, useOptionsImport, type IssueEnvoi } from "../../../lib/projetsVoirieImportHooks";
import { EtatChargement, EtatErreur } from "../EtatsPv";
import { Encart, ZoneErreurImport } from "./commun";
import { Stepper } from "./Stepper";
import { EtapeDepot } from "./EtapeDepot";
import { EtapeFormat } from "./EtapeFormat";
import { EtapeCrs } from "./EtapeCrs";
import { EtapeMapping } from "./EtapeMapping";
import { EtapeControles } from "./EtapeControles";
import { EtapeDelta } from "./EtapeDelta";
import { EtapeApprobation } from "./EtapeApprobation";

/**
 * ASSISTANT D'IMPORT du module « Projets de voirie et reseaux » (lot A2). Sept etapes : depot, format et couches, systeme de coordonnees,
 * correspondance des champs, controles et echantillon, comparaison avec la version autorisee, approbation. Contrat : docs/projets-voirie/CONTRAT-IMPORT.md.
 *
 *   - AUCUNE SESSION SERVEUR : le fichier (un objet `File` en memoire) est renvoye a chaque etape avec les memes options ; l'empreinte SHA-256 de l'apercu
 *     est renvoyee a la simulation et au depot (`sha256Attendu`). Rien n'est ecrit avant « Enregistrer en quarantaine ».
 *   - AUCUN STOCKAGE LOCAL : l'etat vit dans un reducteur React ; ni localStorage, ni sessionStorage, ni IndexedDB, ni cache.
 *   - UN SEUL ENVOI A LA FOIS, annulable (AbortController) ; progression de l'envoi ; un 429 ou un 503 avec delai desactive les boutons le temps dit.
 *   - Rien n'est devine : pas de CRS par defaut, pas de couche choisie a la place de l'utilisateur, pas de suppression appliquee sans revue.
 *   - REPRISE : avec `jeuReprise`, seules les etapes « comparaison » et « approbation » sont proposees, sur un jeu deja depose (quarantaine ou autorise).
 *
 * Le serveur reste l'autorite : les controles locaux ne sont que des economies de transfert. Le contenu du fichier (noms, attributs) est rendu en texte.
 */

const OPERATIONS_AVEC_FICHIER = ["inventaire", "apercu", "simulation", "depot"];
const cleInventaire = (l: Lecture) => JSON.stringify([l.entreeKml, l.csv.delimiteur, l.csv.encodage]);

const DESCRIPTION: Record<IdEtape, string> = {
  depot: "Choisissez le fichier et décrivez le jeu. Rien n'est enregistré avant l'étape « Comparaison avec la version autorisée ».",
  format: "Le serveur a détecté le format par le contenu du fichier. Choisissez la couche, et pour un tableau la façon de le lire.",
  crs: "Dites dans quel système de coordonnées le fichier est exprimé. Le résultat est contrôlé contre la zone attendue.",
  mapping: "Associez les colonnes du fichier aux champs de l'application (facultatif).",
  controles: "Contrôles du serveur : validation géométrique, doublons, statistiques et échantillon. Rien n'est encore écrit.",
  delta: "Comparaison avec la version autorisée précédente : ajouts, modifications et suppressions à revoir.",
  approbation: "Promotion contrôlée du jeu en « autorisé », avec justification, ou rejet. Retour arrière possible ensuite.",
};

export interface JeuReprise { id: string; version: number }

export function AssistantImport({ projetId, enLigne, onFermer, onVoirJeu, jeuReprise = null }: {
  projetId: string; enLigne: boolean; onFermer: () => void; onVoirJeu?: (jeuId: string) => void; jeuReprise?: JeuReprise | null;
}) {
  const [etat, dispatch] = useReducer(reduire, jeuReprise !== null, etatInitial);
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState<ErreurPv | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [cleInv, setCleInv] = useState<string | null>(null);
  const [chargementDelta, setChargementDelta] = useState(false);
  // Erreur de lecture du tableau a l'inventaire : le panneau des options de lecture reste ouvert, meme quand l'erreur est effacee par une saisie.
  const [tableauForce, setTableauForce] = useState(false);
  const [attenteJusqua, setAttenteJusqua] = useState<number | null>(null);
  const [maintenant, setMaintenant] = useState(() => Date.now());
  const refTitre = useRef<HTMLHeadingElement>(null);
  const premierRendu = useRef(true);

  const optionsQ = useOptionsImport(projetId, jeuReprise === null);
  const envoi = useEnvoi();
  const invalider = useInvalidationProjet();
  const options: OptionsImportApi | undefined = optionsQ.data;

  const attente = attenteJusqua === null ? 0 : Math.max(0, Math.ceil((attenteJusqua - maintenant) / 1000));
  const occupe = envoi.occupe;
  const bloque = occupe || attente > 0;
  const jeuId = etat.depot?.jeu?.id ?? jeuReprise?.id ?? null;
  const { saisie, lecture, inventaire, apercu } = etat;

  // Compte a rebours d'un 429 ou d'un 503 : les boutons restent inactifs le temps que le serveur demande.
  useEffect(() => {
    if (attenteJusqua === null) return;
    const t = setInterval(() => {
      const n = Date.now();
      setMaintenant(n);
      if (n >= attenteJusqua) setAttenteJusqua(null);
    }, 500);
    return () => clearInterval(t);
  }, [attenteJusqua]);

  // Le titre de l'etape prend le focus a chaque changement d'etape : le lecteur d'ecran l'annonce, le clavier repart d'en haut.
  useEffect(() => {
    if (premierRendu.current) { premierRendu.current = false; return; }
    refTitre.current?.focus();
  }, [etat.etape]);

  const traiter = useCallback(<T,>(r: IssueEnvoi<T>, ok: (v: T) => void, surErreur?: (e: ErreurPv) => boolean): boolean => {
    if (r.statut === "ok") { ok(r.valeur); return true; }
    if (r.statut === "erreur") {
      if (surErreur?.(r.erreur) === true) return false;
      setErreur(r.erreur);
      if (r.erreur.retryAfterS) { setMaintenant(Date.now()); setAttenteJusqua(Date.now() + r.erreur.retryAfterS * 1000); }
    }
    return false;
  }, []);

  const aller = useCallback((e: IdEtape) => { setErreur(null); setInfo(null); dispatch({ type: "ALLER", etape: e }); }, []);

  const onSaisie = useCallback((patch: Partial<Saisie>) => {
    dispatch({ type: "SAISIE", patch }); setErreurs({}); setErreur(null);
  }, []);
  const onFichier = useCallback((f: File | null) => { dispatch({ type: "FICHIER", fichier: f }); setErreurs({}); setErreur(null); setCleInv(null); setTableauForce(false); }, []);
  const onLecture = useCallback((patch: Partial<Lecture>) => { dispatch({ type: "LECTURE", patch }); setErreur(null); }, []);
  const onCsv = useCallback((patch: Partial<LectureCsv>) => { dispatch({ type: "LECTURE_CSV", patch }); setErreur(null); }, []);

  // -------------------------------------------------------------------------------------------------- Appels
  const donneesDepot = (l: Lecture, sha: string | undefined) => {
    if (!options) return null;
    return construireDonneesDepot(saisie, options.formats, options.limites.tailleMaxOctets, champsLecture(l, sha), options.formatsGdal).donnees;
  };

  async function lancerInventaire(depuisEtapeDepot: boolean) {
    if (!options) return;
    setInfo(null);
    if (depuisEtapeDepot) {
      const { erreurs: errs, donnees } = construireDonneesDepot(saisie, options.formats, options.limites.tailleMaxOctets, {}, options.formatsGdal);
      setErreurs(errs);
      if (!donnees) return;
    }
    if (!saisie.fichier) return;
    setErreur(null);
    const l = lecture;
    const fichier = saisie.fichier;
    const r = await envoi.lancer("inventaire", (o) => inventorierFichier(projetId, fichier, champsLecture(l), o));
    traiter(r, (inv) => {
      dispatch({ type: "INVENTAIRE", inventaire: inv });
      setCleInv(cleInventaire(l));
      setTableauForce(false);
      if (depuisEtapeDepot) aller("format");
    }, (e) => {
      // Encodage ou delimiteur ambigu : l'utilisateur doit les declarer, dans l'etape « Format et couches » ; la detection y est relancee.
      if (depuisEtapeDepot && e.code !== null && CODES_LECTURE_TABLEAU.includes(e.code)) {
        setErreur(e);
        setTableauForce(true);
        dispatch({ type: "ALLER", etape: "format" });
        return true;
      }
      return false;
    });
  }

  async function lancerApercu(l: Lecture): Promise<boolean> {
    if (!saisie.fichier) return false;
    setErreur(null);
    const fichier = saisie.fichier;
    const r = await envoi.lancer("apercu", (o) => apercevoirFichier(projetId, fichier, champsLecture(l), o));
    return traiter(r, (a) => dispatch({ type: "APERCU", apercu: a }), (e) => {
      if (e.code === "CONFIRMATION_HORS_ZONE_REQUISE") {
        setErreur(null);
        dispatch({ type: "HORS_ZONE", nbElements: e.nbElementsHorsZone ?? 0, nbObjets: e.nbObjets ?? null });
        return true;
      }
      return false;
    });
  }

  async function confirmerHorsZone() {
    const l: Lecture = { ...lecture, confirmerHorsZone: true };
    dispatch({ type: "LECTURE", patch: { confirmerHorsZone: true } });
    await lancerApercu(l);
  }

  async function continuerMapping() {
    setInfo(null);
    if (apercu) { aller("controles"); return; }
    if (await lancerApercu(lecture)) aller("controles");
  }

  async function lancerSimulation() {
    if (!apercu) return;
    const donnees = donneesDepot(lecture, apercu.fichier.sha256);
    if (!donnees) return;
    setInfo(null);
    setErreur(null);
    const r = await envoi.lancer("simulation", (o) => deposerAvecOptions(projetId, donnees, { simuler: true, ...o }));
    traiter(r, (rep) => { dispatch({ type: "SIMULATION", simulation: rep }); aller("delta"); });
  }

  const chargerDelta = useCallback(async (id: string, garderErreur = false): Promise<boolean> => {
    if (!garderErreur) setErreur(null);
    setChargementDelta(true);
    try {
      const r = await envoi.lancer("delta", (o) => lireDeltaJeu(projetId, id, o.signal));
      return traiter(r, (d) => dispatch({ type: "DELTA", delta: d }));
    } finally {
      setChargementDelta(false);
    }
  }, [envoi, projetId, traiter]);

  async function enregistrer() {
    if (!etat.simulation || !apercu) return;
    const donnees = donneesDepot(lecture, apercu.fichier.sha256);
    if (!donnees) return;
    setInfo(null);
    setErreur(null);
    const r = await envoi.lancer("depot", (o) => deposerAvecOptions(projetId, donnees, { simuler: false, ...o }));
    if (r.statut === "annule") {
      setInfo("Envoi interrompu. Le serveur a pu enregistrer le fichier avant l'interruption : ouvrez l'onglet Couches pour le vérifier. Le même fichier ne sera pas chargé deux fois (contrôle par empreinte SHA-256).");
      return;
    }
    let nouveau: string | null = null;
    const ok = traiter(r, (rep) => {
      dispatch({ type: "DEPOT", depot: rep });
      nouveau = rep.jeu?.id ?? null;
      void invalider(projetId);
      toast.success("Fichier reçu : il doit maintenant être autorisé.");
    });
    if (ok && nouveau) await chargerDelta(nouveau, true);
  }

  async function revue(decision: "ACCEPTER" | "REFUSER", justification: string): Promise<boolean> {
    if (!jeuId) return false;
    setInfo(null);
    setErreur(null);
    const r = await envoi.lancer("revue", () => revoirSuppressions(projetId, jeuId, decision, justification));
    const ok = traiter(r, () => { toast.success(decision === "ACCEPTER" ? "Suppressions acceptées, revue consignée." : "Suppressions refusées, revue consignée."); void invalider(projetId); });
    if (ok || (r.statut === "erreur" && r.erreur.genre === "conflit")) await chargerDelta(jeuId, true);
    return ok;
  }

  async function decider(d: "autoriser" | "rejeter", justification: string): Promise<boolean> {
    if (!jeuId) return false;
    setInfo(null);
    setErreur(null);
    const r = await envoi.lancer("decision", () => (d === "autoriser" ? autoriserJeu : rejeterJeu)(projetId, jeuId, justification));
    const ok = traiter(r, () => {
      dispatch({ type: "ISSUE", issue: d === "autoriser" ? "AUTORISE" : "REJETE" });
      void invalider(projetId);
      toast.success(d === "autoriser" ? "Jeu autorisé." : "Jeu rejeté.");
    });
    // Un 409 (suppressions a revoir, statut change entre-temps) : l'ecran se resynchronise sur l'etat reel du serveur.
    if (ok || (r.statut === "erreur" && r.erreur.genre === "conflit")) await chargerDelta(jeuId, true);
    return ok;
  }

  async function retour(justification: string): Promise<boolean> {
    if (!jeuId) return false;
    setInfo(null);
    setErreur(null);
    const r = await envoi.lancer("retour", () => revenirEnArriere(projetId, jeuId, justification));
    return traiter(r, (res) => {
      dispatch({ type: "RETOUR", version: res.restaureVersion });
      void invalider(projetId);
      toast.success(`Version ${res.restaureVersion} remise en service.`);
    });
  }

  // Reprise : le delta du jeu existant se charge a l'ouverture.
  useEffect(() => {
    if (jeuReprise) void chargerDelta(jeuReprise.id);
  }, [jeuReprise?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function demanderFermer() {
    if (envoi.occupe) { envoi.annuler(); return; }
    onFermer();
  }

  // -------------------------------------------------------------------------------------------------- Navigation
  const etape = etat.etape;
  const mode = inventaire && options ? modeCrs(inventaire, options.formats) : null;
  const messageFormat = inventaire ? erreurFormat(inventaire, lecture) : null;
  const perime = inventaire !== null && cleInv !== null && cleInv !== cleInventaire(lecture);
  const messageCrs = mode && options ? erreurCrs(mode, lecture, options.crs.sources) : null;
  const precedent = retourPossible(etat) ? etapeVoisine(etat, -1) : null;
  const opFichier = envoi.etat.nom !== null && OPERATIONS_AVEC_FICHIER.includes(envoi.etat.nom);

  let primaire: { libelle: string; actif: boolean; action: () => void } | null = null;
  if (options || jeuReprise) {
    if (etape === "depot" && options) primaire = { libelle: "Analyser le fichier", actif: !bloque && enLigne, action: () => void lancerInventaire(true) };
    else if (etape === "format" && options) primaire = { libelle: "Continuer", actif: !bloque && inventaire !== null && messageFormat === null && !perime, action: () => aller("crs") };
    else if (etape === "crs" && options) primaire = { libelle: "Continuer", actif: !bloque && apercu !== null && etat.horsZone === null, action: () => aller("mapping") };
    else if (etape === "mapping" && options) primaire = { libelle: apercu ? "Continuer vers les contrôles" : "Contrôler le fichier", actif: !bloque && enLigne, action: () => void continuerMapping() };
    else if (etape === "controles" && options) primaire = { libelle: "Simuler l'enregistrement", actif: !bloque && enLigne && apercu !== null, action: () => void lancerSimulation() };
    else if (etape === "delta" && (etat.depot !== null || jeuReprise !== null)) primaire = { libelle: "Continuer vers l'approbation", actif: !bloque && etat.delta !== null, action: () => aller("approbation") };
  }
  const termine = etape === "approbation";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) demanderFermer(); }}>
      <DialogContent masquerCroix className="max-h-[90vh] max-w-3xl grid-cols-[minmax(0,1fr)] overflow-y-auto" onInteractOutside={(e) => e.preventDefault()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <DialogTitle className="text-base font-semibold text-primary">Ajouter des données au projet</DialogTitle>
            <DialogDescription className="text-sm text-gray-700">{jeuReprise ? "Versions, suppressions à revoir et approbation d'un jeu déjà déposé." : "Assistant d'import en sept étapes. Le fichier est contrôlé par le serveur avant tout enregistrement."}</DialogDescription>
          </div>
          <button type="button" onClick={demanderFermer} aria-label={occupe ? "Annuler l'opération en cours" : "Fermer"} className="shrink-0 rounded-md p-1.5 text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy">
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>

        <Stepper etapes={etat.etapes} courante={etape} />

        <section aria-labelledby="assistant-titre-etape" className="space-y-3">
          <h3 id="assistant-titre-etape" ref={refTitre} tabIndex={-1} className="text-sm font-semibold text-navy focus:outline-none">{libelleEtape(etape)}</h3>
          <p className="text-xs text-gray-700">{DESCRIPTION[etape]}</p>

          {jeuReprise === null && optionsQ.isPending && <EtatChargement libelle="Chargement des formats et des limites autorisés…" />}
          {jeuReprise === null && optionsQ.isError && <EtatErreur erreur={classerErreur(optionsQ.error)} sujet="Assistant d'import" onReessayer={() => void optionsQ.refetch()} enCours={optionsQ.isFetching} />}

          {options && etape === "depot" && (
            <EtapeDepot saisie={saisie} erreurs={erreurs} options={options} occupe={occupe} enLigne={enLigne} onSaisie={onSaisie} onFichier={onFichier} />
          )}
          {options && etape === "format" && (
            <EtapeFormat
              inventaire={inventaire} lecture={lecture} options={options} tableauForce={tableauForce} perime={perime} occupe={bloque}
              onLecture={onLecture} onCsv={onCsv} onRelancer={() => void lancerInventaire(false)}
            />
          )}
          {options && etape === "crs" && inventaire && mode && (
            <EtapeCrs
              inventaire={inventaire} mode={mode} lecture={lecture} options={options} apercu={apercu} horsZone={etat.horsZone}
              erreurChoix={lecture.epsgSource !== "" ? messageCrs : null} choixComplet={messageCrs === null} occupe={bloque} onLecture={onLecture}
              onVerifier={() => void lancerApercu(lecture)} onConfirmer={() => void confirmerHorsZone()}
            />
          )}
          {options && etape === "mapping" && inventaire && (
            <EtapeMapping inventaire={inventaire} lecture={lecture} options={options} apercu={apercu} apercuExemples={etat.apercuPrecedent} occupe={bloque} onMapping={(champ, colonne) => { dispatch({ type: "MAPPING", champ, colonne }); setErreur(null); }} />
          )}
          {options && etape === "controles" && apercu && <EtapeControles apercu={apercu} />}
          {(options || jeuReprise) && etape === "delta" && (
            <EtapeDelta
              simulation={etat.simulation} depot={etat.depot} delta={etat.delta} chargementDelta={chargementDelta} occupe={bloque} enLigne={enLigne}
              onEnregistrer={() => void enregistrer()} onRevue={revue} onRecharger={() => { if (jeuId) void chargerDelta(jeuId); }}
            />
          )}
          {(options || jeuReprise) && etape === "approbation" && (
            <EtapeApprobation delta={etat.delta} issue={etat.issue} retour={etat.retour} occupe={bloque} enLigne={enLigne} onDecider={decider} onRetour={retour} />
          )}
        </section>

        {info && <Encart ton="attention" testid="info-assistant"><p>{info}</p></Encart>}
        {erreur && <ZoneErreurImport erreur={erreur} etapeCourante={etape} onVoirJeu={onVoirJeu} onAller={aller} />}
        {!enLigne && <p role="alert" className="text-sm text-amber-900">Vous êtes hors ligne : l&apos;assistant a besoin du réseau.</p>}
        {Object.keys(erreurs).length > 0 && <p role="alert" className="text-sm text-red-700">Corrigez les champs signalés avant de lancer l&apos;analyse du fichier.</p>}
        {etape === "format" && messageFormat && inventaire && <p className="text-xs text-gray-700" data-testid="blocage-format">{messageFormat}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 pt-3">
          <div className="mr-auto min-w-0 text-sm text-gray-800" aria-live="polite">
            {occupe && opFichier && envoi.etat.progression !== null && !envoi.etat.envoye && (
              <span className="flex items-center gap-2" role="status">
                <progress max={100} value={envoi.etat.progression} aria-label="Avancement de l'envoi du fichier" className="h-2 w-28" />
                Envoi du fichier… {envoi.etat.progression} %
              </span>
            )}
            {occupe && opFichier && (envoi.etat.envoye || envoi.etat.progression === null) && <span role="status">Fichier reçu par le serveur : lecture et contrôles en cours…</span>}
            {occupe && !opFichier && <span role="status">Traitement en cours…</span>}
            {!occupe && attente > 0 && <span role="status" data-testid="attente">Nouvel essai possible dans {attente} s.</span>}
          </div>
          {occupe && opFichier && <Button type="button" variant="outline" onClick={() => envoi.annuler()}>Annuler l&apos;envoi</Button>}
          {precedent && <Button type="button" variant="ghost" disabled={bloque} onClick={() => aller(precedent)}>Précédent</Button>}
          {!termine && primaire && <Button type="button" disabled={!primaire.actif} onClick={primaire.action}>{occupe ? "En cours…" : primaire.libelle}</Button>}
          {termine && <Button type="button" disabled={occupe} onClick={onFermer}>Terminer</Button>}
          {!termine && etape !== "depot" && etat.depot === null && jeuReprise === null && <Button type="button" variant="ghost" disabled={occupe} onClick={onFermer}>Abandonner</Button>}
          {etape === "depot" && <Button type="button" variant="ghost" disabled={occupe} onClick={onFermer}>Annuler</Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
