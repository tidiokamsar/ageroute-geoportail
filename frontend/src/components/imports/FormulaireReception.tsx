import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { AlertTriangle, CheckCircle2, Clock, FileUp, Info, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "../ui/Button";
import { Input, Select } from "../ui/Input";
import { ZoneDepot } from "./ZoneDepot";
import type { MetaImport, ReceptionReponse, SourceConnue, StatutLot } from "./types";
import {
  LIBELLE_CHAMP, LIBELLE_STATUT_RECEPTION, ORDRE_CHAMPS, VALEURS_PAR_DEFAUT,
  classerEchec, diagnostiquerBouton, libelleChampServeur, natureResultat, preparerDonnees, validerReception,
  type ChampReception, type DonneesReception, type EchecReception, type ValeursReception,
} from "./receptionFormulaire.noyau";

/**
 * Formulaire de réception d'un lot : les informations obligatoires, le fichier, l'envoi et son résultat.
 *
 * CE QUE CE FORMULAIRE S'INTERDIT
 *
 * - Prétendre qu'un fichier est valide : il affiche ce que la personne a choisi et dit que le serveur
 *   contrôle. Le statut, les compteurs et les motifs affichés au retour sont ceux du serveur.
 * - Perdre une saisie : après un échec, les informations ET le fichier restent. Après un succès, le
 *   fichier est vidé et les informations restent (on enchaîne souvent plusieurs lots de la même source).
 * - Confondre trois situations : « le serveur a refusé » (rien n'est enregistré, on corrige), « le lot
 *   est rejeté » (un RÉSULTAT : le fichier est reçu, contrôlé et conservé avec son motif) et « la
 *   réception n'a pas pu être confirmée » (réseau, délai : le lot a peut-être été enregistré).
 * - Envoyer deux fois : un verrou (ref) bloque la deuxième soumission avant même que l'état ne change.
 *
 * Il n'appelle pas l'API lui-même : le parent fournit `onSoumettre`, qui construit la requête
 * multipart, rapporte la progression et rend la réponse du contrat.
 */

export interface ProgressionEnvoi {
  /** Octets déjà transmis. */
  envoye: number;
  /** Octets à transmettre ; `null` si le navigateur ne le sait pas (barre indéterminée). */
  total: number | null;
}

export interface OptionsEnvoi { onProgression: (progression: ProgressionEnvoi) => void }

export type SoumettreReception = (donnees: DonneesReception, fichier: File, options: OptionsEnvoi) => Promise<ReceptionReponse>;

export interface FormulaireReceptionProps {
  /** Formats et plafonds du serveur (route /meta). */
  meta: MetaImport;
  /** Sources déjà reçues, proposées en suggestions (la source reste un texte libre). */
  sourcesConnues: SourceConnue[];
  onSoumettre: SoumettreReception;
  /** Désactive tout le formulaire (le parent peut avoir besoin de /meta, d'une session valide...). */
  desactive?: boolean;
  /** Phrase affichée près du bouton quand `desactive` est vrai. */
  raisonDesactive?: string;
  valeursInitiales?: Partial<ValeursReception>;
  /** Appelé après toute réponse de réception (nouveau lot, rejeté ou déjà reçu) : toasts, sélection du lot, rechargement de la liste. */
  onRecu?: (reponse: ReceptionReponse, nomFichier: string) => void;
  /** Appelé après un refus ou un résultat incertain. */
  onEchec?: (echec: EchecReception) => void;
}

// ---------------------------------------------------------------------------------------------

interface BlocErreurs {
  origine: "client" | "serveur";
  incertain: boolean;
  titre: string;
  message: string | null;
  liens: Array<{ champ: ChampReception; message: string }>;
  autres: string[];
}

type CibleFocus = "resultat" | "bloc" | ChampReception;

const STYLE_STATUT: Record<StatutLot, { classe: string; Icone: LucideIcon }> = {
  RECU: { classe: "border-etat-inconnu-trait bg-etat-inconnu-fond text-etat-inconnu", Icone: Clock },
  // « En attente » n'est pas une réussite : couleur d'attention, pas de vert.
  VALIDE_SCHEMA: { classe: "border-etat-moyen-trait bg-etat-moyen-fond text-etat-moyen", Icone: Clock },
  IMPORTE_TEST: { classe: "border-etat-moyen-trait bg-etat-moyen-fond text-etat-moyen", Icone: Clock },
  IMPORTE: { classe: "border-etat-bon-trait bg-etat-bon-fond text-etat-bon", Icone: CheckCircle2 },
  REJETE: { classe: "border-etat-mauvais-trait bg-etat-mauvais-fond text-etat-mauvais", Icone: XCircle },
};

function BadgeStatut({ statut }: { statut: StatutLot }) {
  const { classe, Icone } = STYLE_STATUT[statut] ?? STYLE_STATUT.RECU;
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-sm font-medium ${classe}`}>
      <Icone aria-hidden="true" className="h-4 w-4" />
      {LIBELLE_STATUT_RECEPTION[statut] ?? statut}
    </span>
  );
}

function formatParDefaut(meta: MetaImport): string {
  return meta.formats.some((f) => f.code === VALEURS_PAR_DEFAUT.format) ? VALEURS_PAR_DEFAUT.format : (meta.formats[0]?.code ?? "");
}

function sans<T extends object>(objet: T, cle: keyof T): T {
  const copie = { ...objet };
  delete copie[cle];
  return copie;
}

interface ChampProps {
  id: string;
  libelle: string;
  aide: ReactNode;
  erreur?: string | null;
  children: (p: { id: string; "aria-describedby": string; "aria-invalid"?: true; "aria-required": true }) => ReactNode;
}

/** Libellé visible, contrôle, aide (reliée par aria-describedby) et erreur proche du champ. */
function Champ({ id, libelle, aide, erreur, children }: ChampProps) {
  const idAide = `${id}-aide`;
  const idErreur = `${id}-erreur`;
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {libelle} <span aria-hidden="true" className="text-danger">*</span>
      </label>
      {children({
        id,
        "aria-describedby": erreur ? `${idAide} ${idErreur}` : idAide,
        "aria-invalid": erreur ? true : undefined,
        "aria-required": true,
      })}
      <p id={idAide} className="text-sm text-muted-foreground">{aide}</p>
      {erreur && (
        <p id={idErreur} className="flex items-start gap-2 text-sm text-danger">
          <XCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span><span className="font-medium">Erreur : </span>{erreur}</span>
        </p>
      )}
    </div>
  );
}

const CLASSE_CHAMP = "h-11";

export function FormulaireReception({
  meta, sourcesConnues, onSoumettre, desactive = false, raisonDesactive, valeursInitiales, onRecu, onEchec,
}: FormulaireReceptionProps) {
  const base = useId();
  const idChamp = useCallback((c: ChampReception) => `${base}-${c}`, [base]);
  const idListe = `${base}-sources`;
  const idPhrase = `${base}-raison`;
  const idGarantie = `${base}-garantie`;
  const idTitreResultat = `${base}-resultat`;

  const [valeurs, setValeurs] = useState<ValeursReception>(() => ({
    ...VALEURS_PAR_DEFAUT, format: formatParDefaut(meta), ...valeursInitiales,
  }));
  const [fichier, setFichier] = useState<File | null>(null);
  const [touches, setTouches] = useState<Partial<Record<ChampReception, boolean>>>({});
  const [soumisInvalide, setSoumisInvalide] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [progression, setProgression] = useState<ProgressionEnvoi | null>(null);
  const [resultat, setResultat] = useState<{ reponse: ReceptionReponse; nomFichier: string } | null>(null);
  const [bloc, setBloc] = useState<BlocErreurs | null>(null);
  const [erreursServeur, setErreursServeur] = useState<Partial<Record<ChampReception, string>>>({});
  const [demandeFocus, setDemandeFocus] = useState<{ cible: CibleFocus; n: number } | null>(null);

  const verrou = useRef(false);
  const jeton = useRef(0);
  const refResultat = useRef<HTMLElement>(null);
  const refBloc = useRef<HTMLDivElement>(null);

  const info = useMemo(() => (fichier ? { nom: fichier.name, taille: fichier.size } : null), [fichier]);
  const validation = useMemo(() => validerReception({ valeurs, fichier: info, meta }), [valeurs, info, meta]);
  const diagnostic = useMemo(
    () => diagnostiquerBouton({ valeurs, fichier: info, meta, envoiEnCours: enCours, desactive, raisonDesactive }),
    [valeurs, info, meta, enCours, desactive, raisonDesactive],
  );
  const bloque = enCours || desactive;

  // Le focus ne peut aller sur un champ qu'une fois le fieldset réactivé : on attend la fin de l'envoi.
  useEffect(() => {
    if (!demandeFocus || enCours) return;
    const { cible } = demandeFocus;
    if (cible === "resultat") refResultat.current?.focus();
    else if (cible === "bloc") refBloc.current?.focus();
    else document.getElementById(idChamp(cible))?.focus();
    setDemandeFocus(null);
  }, [demandeFocus, enCours, idChamp]);

  function demanderFocus(cible: CibleFocus) {
    setDemandeFocus((precedent) => ({ cible, n: (precedent?.n ?? 0) + 1 }));
  }

  function changer<K extends Exclude<ChampReception, "fichier">>(champ: K, valeur: string) {
    setValeurs((v) => ({ ...v, [champ]: valeur }));
    setErreursServeur((e) => (e[champ] ? sans(e, champ) : e));
    // Un résumé d'erreurs issu de la validation locale se périme dès qu'on corrige ; celui du serveur reste.
    setBloc((b) => (b?.origine === "client" ? null : b));
  }

  function erreurVisible(champ: Exclude<ChampReception, "fichier">): string | undefined {
    return erreursServeur[champ] ?? (touches[champ] || soumisInvalide ? validation.erreurs[champ] : undefined);
  }

  const toucher = (champ: ChampReception) => () => setTouches((t) => (t[champ] ? t : { ...t, [champ]: true }));

  function choisirFichier(f: File) {
    setFichier(f);
    setErreursServeur((e) => (e.fichier ? sans(e, "fichier") : e));
    setBloc((b) => (b?.origine === "client" ? null : b));
  }

  function retirerFichier() {
    setFichier(null);
    setErreursServeur((e) => (e.fichier ? sans(e, "fichier") : e));
  }

  function aller(champ: ChampReception) {
    document.getElementById(idChamp(champ))?.focus();
  }

  async function soumettre() {
    if (verrou.current || bloque) return;
    if (!validation.valide || !fichier) {
      // Le bouton est inactif dans ce cas : on n'arrive ici que par une soumission programmatique ou un
      // formulaire dont l'état a changé entre-temps. On dit alors ce qui ne va pas, sans rien envoyer.
      const liens = ORDRE_CHAMPS.filter((c) => validation.erreurs[c]).map((champ) => ({ champ, message: validation.erreurs[champ] as string }));
      setSoumisInvalide(true);
      setBloc({
        origine: "client", incertain: false, message: null, autres: [], liens,
        titre: liens.length > 1 ? `Le formulaire contient ${liens.length} erreurs à corriger avant l'envoi.` : "Le formulaire contient une erreur à corriger avant l'envoi.",
      });
      if (liens[0]) demanderFocus(liens[0].champ);
      return;
    }

    verrou.current = true;
    const monJeton = ++jeton.current;
    const nomFichier = fichier.name;
    setEnCours(true);
    setProgression(null);
    setResultat(null);
    setBloc(null);
    setErreursServeur({});
    try {
      const reponse = await onSoumettre(preparerDonnees(valeurs), fichier, {
        onProgression: (p) => { if (verrou.current && jeton.current === monJeton) setProgression(p); },
      });
      setResultat({ reponse, nomFichier });
      // Succès : le fichier est vidé (un même fichier renvoyé serait « déjà reçu »), les informations restent.
      setFichier(null);
      setSoumisInvalide(false);
      setTouches({});
      demanderFocus("resultat");
      onRecu?.(reponse, nomFichier);
    } catch (e) {
      const echec = classerEchec(e, meta);
      setErreursServeur(echec.champs);
      const liens = ORDRE_CHAMPS.filter((c) => echec.champs[c]).map((champ) => ({ champ, message: echec.champs[champ] as string }));
      setBloc({
        origine: "serveur", incertain: echec.nature === "incertain", titre: echec.titre,
        // Quand chaque message est déjà rattaché à un champ, on ne le répète pas en tête.
        message: liens.length > 0 ? null : echec.message, liens, autres: echec.autres,
      });
      demanderFocus(liens[0]?.champ ?? "bloc");
      onEchec?.(echec);
    } finally {
      verrou.current = false;
      setEnCours(false);
    }
  }

  const pourcentage = progression && progression.total && progression.total > 0
    ? Math.min(100, Math.floor((progression.envoye / progression.total) * 100))
    : null;
  const envoiTermine = pourcentage === 100;
  const formatChoisi = meta.formats.find((f) => f.code === valeurs.format);

  return (
    <form
      noValidate
      aria-label="Recevoir un lot"
      aria-busy={enCours}
      onSubmit={(e) => { e.preventDefault(); void soumettre(); }}
      className="min-w-0 space-y-4 rounded-lg border bg-card p-4 text-card-foreground sm:p-6"
    >
      <div>
        <h2 className="text-section font-semibold text-foreground">Recevoir un lot de données</h2>
        <p className="text-sm text-muted-foreground">
          Renseignez les informations sur le fichier. Recevoir un lot n'écrit rien dans le référentiel. Les champs marqués d'un * sont obligatoires.
        </p>
      </div>

      {resultat && (
        <ResultatReception
          reponse={resultat.reponse} nomFichier={resultat.nomFichier}
          refSection={refResultat} idTitre={idTitreResultat}
        />
      )}

      {bloc && (
        <div
          ref={refBloc}
          tabIndex={-1}
          // Un résumé avec des liens vers les champs reçoit le focus sur le premier champ ; sans lien, c'est
          // lui qui reçoit le focus et il s'annonce.
          role={bloc.liens.length > 0 ? undefined : "alert"}
          className={`space-y-2 rounded-md border p-3 text-sm ${bloc.incertain ? "border-etat-moyen-trait bg-etat-moyen-fond text-foreground" : "border-etat-mauvais-trait bg-etat-mauvais-fond text-foreground"}`}
        >
          <p className="flex items-start gap-2 font-medium">
            {bloc.incertain
              ? <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              : <XCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{bloc.titre}</span>
          </p>
          {bloc.message && <p>{bloc.message}</p>}
          {bloc.liens.length > 0 && (
            <ul className="list-disc space-y-1 pl-6">
              {bloc.liens.map((l) => (
                <li key={l.champ}>
                  <a
                    href={`#${idChamp(l.champ)}`}
                    className="font-medium underline"
                    onClick={(e) => { e.preventDefault(); aller(l.champ); }}
                  >
                    {LIBELLE_CHAMP[l.champ]}
                  </a>
                  {" : "}{l.message}
                </li>
              ))}
            </ul>
          )}
          {bloc.autres.length > 0 && (
            <ul className="list-disc space-y-1 pl-6">
              {bloc.autres.map((a) => <li key={a}>Autre information refusée par le serveur, {a}</li>)}
            </ul>
          )}
        </div>
      )}

      <fieldset disabled={bloque} className="min-w-0 space-y-4 border-0 p-0">
        <legend className="sr-only">Informations sur le lot et fichier</legend>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-2">
          <Champ
            id={idChamp("systemeSource")} libelle={LIBELLE_CHAMP.systemeSource} erreur={erreurVisible("systemeSource")}
            aide={sourcesConnues.length > 0
              ? "Texte libre. Choisissez une source déjà utilisée dans les suggestions, ou saisissez-en une nouvelle."
              : "Texte libre : nom du système ou de l'organisme qui fournit le fichier. Aucune source n'a encore été reçue."}
          >
            {(p) => (
              <>
                <Input
                  {...p} type="text" list={idListe} autoComplete="off" className={CLASSE_CHAMP}
                  value={valeurs.systemeSource} onChange={(e) => changer("systemeSource", e.target.value)} onBlur={toucher("systemeSource")}
                />
                <datalist id={idListe}>
                  {sourcesConnues.map((s) => (
                    <option key={s.valeur} value={s.valeur}>{`${s.nombreLots} lot${s.nombreLots > 1 ? "s" : ""} déjà reçu${s.nombreLots > 1 ? "s" : ""}`}</option>
                  ))}
                </datalist>
              </>
            )}
          </Champ>

          <Champ
            id={idChamp("format")} libelle={LIBELLE_CHAMP.format} erreur={erreurVisible("format")}
            aide={formatChoisi
              ? `${formatChoisi.aide} Seuls les formats de cette liste sont pris en charge.`
              : "Seuls les formats de cette liste sont pris en charge."}
          >
            {(p) => (
              <Select
                {...p} className={CLASSE_CHAMP} value={valeurs.format}
                onChange={(e) => changer("format", e.target.value)} onBlur={toucher("format")}
              >
                {!meta.formats.some((f) => f.code === valeurs.format) && <option value="">Choisir un format</option>}
                {meta.formats.map((f) => <option key={f.code} value={f.code}>{f.libelle}</option>)}
              </Select>
            )}
          </Champ>

          <Champ
            id={idChamp("methodeSource")} libelle={LIBELLE_CHAMP.methodeSource} erreur={erreurVisible("methodeSource")}
            aide="Comment les données ont été produites : export d'un logiciel, relevé tablette, saisie manuelle, etc."
          >
            {(p) => (
              <Input
                {...p} type="text" autoComplete="off" className={CLASSE_CHAMP} placeholder="export L²R Mesure, relevé tablette…"
                value={valeurs.methodeSource} onChange={(e) => changer("methodeSource", e.target.value)} onBlur={toucher("methodeSource")}
              />
            )}
          </Champ>

          <Champ
            id={idChamp("versionMapping")} libelle={LIBELLE_CHAMP.versionMapping} erreur={erreurVisible("versionMapping")}
            aide="Version des correspondances de colonnes utilisées pour ce fichier ; elle est conservée avec le lot. Exemple : v0."
          >
            {(p) => (
              <Input
                {...p} type="text" autoComplete="off" className={CLASSE_CHAMP}
                value={valeurs.versionMapping} onChange={(e) => changer("versionMapping", e.target.value)} onBlur={toucher("versionMapping")}
              />
            )}
          </Champ>

          <Champ
            id={idChamp("autorisationRef")} libelle={LIBELLE_CHAMP.autorisationRef} erreur={erreurVisible("autorisationRef")}
            aide="Obligatoire (§ B.4). Texte libre, 5 caractères au moins, sur une seule ligne : contrat, courrier, numéro de référence de l'autorisation écrite. Elle est conservée avec le lot."
          >
            {(p) => (
              <Input
                {...p} type="text" autoComplete="off" className={CLASSE_CHAMP} placeholder="Contrat, courrier, référence…"
                value={valeurs.autorisationRef} onChange={(e) => changer("autorisationRef", e.target.value)} onBlur={toucher("autorisationRef")}
              />
            )}
          </Champ>
        </div>

        <ZoneDepot
          id={idChamp("fichier")}
          meta={meta}
          formatDeclare={valeurs.format}
          fichier={fichier}
          onChoisir={choisirFichier}
          onRetirer={retirerFichier}
          desactive={bloque}
          erreurServeur={erreursServeur.fichier ?? null}
          afficherErreurAbsence={soumisInvalide}
        />
      </fieldset>

      <div className="space-y-2">
        <Button
          type="submit"
          size="lg"
          className="h-11 w-full sm:w-auto"
          disabled={!diagnostic.actif}
          aria-describedby={diagnostic.phrase ? `${idPhrase} ${idGarantie}` : idGarantie}
        >
          <FileUp aria-hidden="true" /> Recevoir et contrôler le lot
        </Button>
        {diagnostic.phrase && !enCours && <p id={idPhrase} className="text-sm text-foreground">{diagnostic.phrase}</p>}
        <p id={idGarantie} className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Le serveur calcule l'empreinte du fichier reçu. Aucune donnée du référentiel n'est modifiée par cette réception.</span>
        </p>
      </div>

      {enCours && (
        <div className="space-y-1" data-testid="envoi-en-cours">
          <p role="status" className="text-sm font-medium text-foreground">
            {envoiTermine
              ? "Fichier envoyé. Le serveur calcule l'empreinte et contrôle le fichier : patientez, ne relancez pas l'envoi."
              : "Envoi du fichier en cours : patientez, ne relancez pas l'envoi."}
          </p>
          <div
            role="progressbar"
            aria-label="Envoi du fichier"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pourcentage ?? undefined}
            aria-valuetext={pourcentage === null ? "Progression inconnue" : `${pourcentage} %`}
            className="h-2 w-full overflow-hidden rounded bg-muted"
          >
            <div
              className={`h-full bg-primary ${pourcentage === null ? "w-1/3 animate-pulse" : ""}`}
              style={pourcentage === null ? undefined : { width: `${pourcentage}%` }}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {pourcentage === null ? "Progression non communiquée par le navigateur." : `${pourcentage} % transmis.`}
          </p>
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------

interface ResultatProps {
  reponse: ReceptionReponse;
  nomFichier: string;
  refSection: RefObject<HTMLElement>;
  idTitre: string;
}

function ResultatReception({ reponse: r, nomFichier, refSection, idTitre }: ResultatProps) {
  const nature = natureResultat(r);
  const titre = nature === "dejaRecu" ? "Ce fichier avait déjà été reçu : rien n'a été écrit."
    : nature === "rejete" ? "Lot rejeté par le contrôle : c'est un résultat, pas une panne."
    : nature === "controle" ? "Lot reçu."
    : "Lot reçu : le serveur a décidé de son statut.";
  const cadre = nature === "rejete" ? "border-etat-mauvais-trait bg-etat-mauvais-fond"
    : nature === "dejaRecu" ? "border-etat-moyen-trait bg-etat-moyen-fond"
    : "border-etat-bon-trait bg-etat-bon-fond";
  const Icone = nature === "rejete" ? XCircle : nature === "dejaRecu" ? Info : CheckCircle2;
  const differences = r.metadonneesDifferentes ?? [];
  const autresSources = r.memeEmpreinteAutresSources ?? [];
  const avertissements = r.avertissements ?? [];

  return (
    <section
      ref={refSection}
      tabIndex={-1}
      aria-labelledby={idTitre}
      data-testid="resultat-reception"
      className={`space-y-3 rounded-md border p-4 text-sm text-foreground ${cadre}`}
    >
      <h3 id={idTitre} className="flex items-start gap-2 text-base font-semibold">
        <Icone aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
        <span>{titre}</span>
      </h3>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>Lot</span>
        <span className="break-all font-mono font-semibold">{r.reference}</span>
        <BadgeStatut statut={r.statut} />
        <span className="break-all text-muted-foreground">Fichier : {nomFichier}</span>
      </p>

      {(nature === "controle" || nature === "rejete") && (
        <p className="font-medium">Reçu et contrôlé. Aucune donnée du référentiel n'a été modifiée.</p>
      )}
      {nature === "controle" && (
        <p>Le fichier respecte le contrat de schéma. Le lot n'est pas importé : il reste en attente, rien n'est appliqué.</p>
      )}
      {r.statut === "REJETE" && (
        <p>
          <span className="font-medium">Motif : </span>{r.motifRejetLot ?? "aucune ligne conforme"}.
          {nature === "rejete" && " Le lot est conservé avec son motif. Corrigez le fichier lui-même : un fichier identique, envoyé pour la même source, serait reconnu comme déjà reçu."}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Lignes lues", r.compteurs.lues],
          ["Lignes conformes", r.compteurs.validees],
          ["Lignes rejetées", r.compteurs.rejetees],
          ["Lignes ignorées", r.compteurs.ignorees],
        ].map(([libelle, valeur]) => (
          <div key={libelle} className="rounded border border-input bg-card p-2">
            <dt className="text-muted-foreground">{libelle}</dt>
            <dd className="text-base font-semibold">{valeur}</dd>
          </div>
        ))}
      </dl>

      {avertissements.length > 0 && (
        <div>
          <p className="font-medium">Avertissements du serveur</p>
          <ul className="list-disc space-y-1 pl-6">{avertissements.map((a, i) => <li key={`${i}-${a}`}>{a}</li>)}</ul>
        </div>
      )}

      {differences.length > 0 && (
        <div>
          <p className="font-medium">Vos nouvelles informations n'ont pas été appliquées : le lot conserve les anciennes.</p>
          <ul className="list-disc space-y-1 pl-6">
            {differences.map((d) => (
              <li key={d.champ}>
                <span className="font-medium">{libelleChampServeur(d.champ)}</span>
                {" : vous avez saisi « "}{d.recu}{" », le lot conserve « "}{d.conserve}{" »."}
              </li>
            ))}
          </ul>
        </div>
      )}

      {autresSources.length > 0 && (
        <div>
          <p className="font-medium">Ce même contenu a aussi été reçu sous une autre source :</p>
          <ul className="list-disc space-y-1 pl-6">
            {autresSources.map((s) => <li key={s.reference}><span className="font-mono">{s.reference}</span> ({s.systemeSource})</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
