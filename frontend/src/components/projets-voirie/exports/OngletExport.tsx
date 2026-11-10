import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Download, FileArchive, KeyRound, ShieldCheck, X } from "lucide-react";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { EtatChargement, EtatErreur } from "../EtatsPv";
import { DialogueDerogation, type JeuDerogation } from "./DialogueDerogation";
import { useAccorderDerogation, useDerogations, useInvalidationExports, useJournalExports, useMesDerogations } from "../../../lib/projetsVoirieExportsHooks";
import { exporterDossier } from "../../../lib/projetsVoirieExportsApi";
import { LIBELLE_CONFIDENTIALITE, formaterDate, formaterNombre, formaterTaille, type ErreurPv } from "../../../lib/projetsVoirie";
import {
  AIDE_ETAT_DEROGATION, DELAI_EXPORT_NAVIGATEUR_MS, FICHIERS_ARCHIVE, LIBELLE_ETAT_DEROGATION, LIBELLE_RAISON_ECART, LIBELLE_TENTATIVE, MOTIF_UUID,
  apercuArchive, classerErreurExports, derogationsUtilisables,
  type Derogation, type ResultatExport,
} from "../../../lib/projetsVoirieExports";
import type { JeuProjet } from "../../../lib/projetsVoirieApi";

/**
 * Onglet « Export » de la fiche projet (lot X1, interface UI-D), monte pour ADMIN et GESTIONNAIRE seulement (le serveur reserve l'export aux
 * comptes qui decident, 403 sinon). Contenu : fabrication du dossier technique (ce que l'archive contiendra et ce qui en sera exclu, attente bornee
 * et annulable, telechargement du ZIP, erreurs typees expliquees), journal des tentatives, derogations (ADMIN : accorder a une autre personne,
 * liste et etat ; beneficiaire : exporter avec la sienne).
 *
 * L'archive n'est ni ouverte, ni lue, ni gardee par l'application : elle est remise au navigateur comme un fichier a enregistrer.
 */

type ChoixDerogation = { genre: "aucune" } | { genre: "liste"; id: string } | { genre: "saisie" };

export function OngletExport({ projetId, code, jeux, actif, estAdmin, compteId, enLigne }: {
  projetId: string; code: string; jeux: readonly JeuProjet[]; actif: boolean; estAdmin: boolean; compteId: string | undefined; enLigne: boolean;
}) {
  const id = useId();
  const journal = useJournalExports(projetId, actif);
  const derogations = useDerogations(projetId, actif && estAdmin);
  // Un non-ADMIN ne lit pas la liste du projet : seulement les derogations qui le designent (ecart E1 du lot UI-D, filtrees par le serveur).
  const miennes = useMesDerogations(projetId, actif && !estAdmin);
  const accorder = useAccorderDerogation(projetId);
  const invalider = useInvalidationExports();
  const [geojson, setGeojson] = useState(true);
  const [choix, setChoix] = useState<ChoixDerogation>({ genre: "aucune" });
  const [saisieId, setSaisieId] = useState("");
  const [enCours, setEnCours] = useState(false);
  const [ecoule, setEcoule] = useState(0);
  const [resultat, setResultat] = useState<(ResultatExport & { prevus: number; comparable: boolean }) | null>(null);
  const [erreur, setErreur] = useState<ErreurPv | null>(null);
  const [octroi, setOctroi] = useState(false);
  const [annonce, setAnnonce] = useState("");
  const controleur = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enCours) return undefined;
    const debut = Date.now();
    setEcoule(0);
    const t = setInterval(() => setEcoule(Math.floor((Date.now() - debut) / 1000)), 1000);
    return () => clearInterval(t);
  }, [enCours]);
  useEffect(() => () => controleur.current?.abort(), []);

  const sourceDerogations = estAdmin ? derogations.data : miennes.data;
  const mesDerogations = useMemo(() => derogationsUtilisables(sourceDerogations ?? [], compteId), [sourceDerogations, compteId]);
  const derogationCitee = choix.genre === "liste" ? mesDerogations.find((d) => d.id === choix.id) ?? null : null;
  const idDerogation = choix.genre === "liste" ? choix.id : choix.genre === "saisie" ? saisieId.trim() : null;
  const saisieInvalide = choix.genre === "saisie" && !MOTIF_UUID.test(saisieId.trim());
  const jeuxApercu = jeux.map((j) => ({ id: j.id, statut: j.statut, confidentialite: j.confidentialite, libelle: `${j.nomFichier}, v${j.version}` }));
  // Une derogation saisie (beneficiaire gestionnaire) : ses jeux ne sont pas connus du client ; la prevision le dit, le manifeste fera foi.
  const apercu = apercuArchive(jeuxApercu, { geojson, jeuxDerogation: new Set(derogationCitee?.jeuxIds ?? []) });

  async function exporter() {
    setEnCours(true); setErreur(null); setResultat(null); setAnnonce("Fabrication du dossier en cours.");
    const c = new AbortController();
    controleur.current = c;
    try {
      const r = await exporterDossier(projetId, code, { geojson, derogationId: geojson ? idDerogation : null }, c.signal);
      setResultat({ ...r, prevus: apercu.inclus.length, comparable: geojson && idDerogation === null });
      setChoix({ genre: "aucune" }); setSaisieId("");
      setAnnonce(`Dossier remis : ${r.nomFichier}.`);
    } catch (e) {
      const x = classerErreurExports(e);
      const annule = x.genre === "annule";
      setErreur(annule ? { ...x, message: "Fabrication annulée. La tentative est consignée « non reçue » ; une dérogation citée est libérée, non consommée." } : x);
      setAnnonce(annule ? "Fabrication annulée." : "L'export a échoué.");
    } finally {
      controleur.current = null;
      setEnCours(false);
      void invalider();
    }
  }

  const jeuxDerogation: JeuDerogation[] = jeux.map((j) => ({ id: j.id, nomFichier: j.nomFichier, role: j.role, version: j.version, statut: j.statut, confidentialite: j.confidentialite }));
  const nomJeu = (jid: string) => jeux.find((j) => j.id === jid)?.nomFichier ?? "jeu non listé dans la fiche";

  return (
    <section aria-labelledby="pv-titre-export" className="space-y-4">
      <div>
        <h3 id="pv-titre-export" className="flex items-center gap-1 text-sm font-semibold text-navy"><FileArchive aria-hidden="true" className="h-4 w-4" />Dossier technique du projet</h3>
        <p className="text-xs text-gray-700">Une archive ZIP fabriquée par le serveur, consignée à votre nom, avec l&apos;empreinte de chaque fichier. C&apos;est une aide à la décision : elle ne vaut ni ordre ni autorisation.</p>
      </div>
      <p role="status" aria-live="polite" className="sr-only">{annonce}</p>

      <div className="space-y-2 rounded-md border border-gray-200 p-2 text-xs text-gray-800">
        <h4 className="text-xs font-semibold text-gray-900">Ce que l&apos;archive contiendra</h4>
        <ul className="list-disc space-y-0.5 pl-5">{FICHIERS_ARCHIVE.map((f) => <li key={f.chemin}><span className="font-mono">{f.chemin}</span> : {f.contenu}</li>)}</ul>
        <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-gray-900 xl:min-h-0">
          <input type="checkbox" className="h-4 w-4" checked={geojson} disabled={enCours} onChange={(e) => setGeojson(e.target.checked)} />
          Inclure le tracé GeoJSON des jeux exportables
        </label>
        <div data-testid="apercu-geojson" className="space-y-1">
          <p className="font-semibold text-gray-900">Prévision pour le GeoJSON (le manifeste de l&apos;archive fait foi)</p>
          {apercu.inclus.length === 0 ? <p>Aucun jeu ne sortira en GeoJSON.</p> : (
            <ul className="space-y-0.5">{apercu.inclus.map(({ jeu, derogation }) => <li key={jeu.id}>Inclus : {jeu.libelle} ({LIBELLE_CONFIDENTIALITE[jeu.confidentialite as keyof typeof LIBELLE_CONFIDENTIALITE] ?? jeu.confidentialite}){derogation ? ", par dérogation" : ""}</li>)}</ul>
          )}
          {apercu.ecartes.length > 0 && (
            <ul className="space-y-0.5">{apercu.ecartes.map(({ jeu, raison }) => <li key={jeu.id}>Exclu : {jeu.libelle} : {LIBELLE_RAISON_ECART[raison]}</li>)}</ul>
          )}
          <p className="text-gray-700">Les niveaux « confidentiel concessionnaire » et « infrastructure sensible » ne sortent jamais sans dérogation. Un réglage du serveur peut encore exclure « public », « interne » ou « restreint au projet ». Un jeu retiré n&apos;apparaît nulle part ; les attributs des fichiers source ne sont jamais exportés.</p>
          {choix.genre === "saisie" && <p className="text-gray-700">Avec une dérogation saisie par son identifiant, les jeux qu&apos;elle couvre ne sont connus que du serveur : ils seront marqués dans le manifeste.</p>}
        </div>

        {geojson && (
          <fieldset className="space-y-1 rounded border border-gray-200 p-2">
            <legend className="px-1 text-xs font-semibold text-gray-900">Dérogation de confidentialité</legend>
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-gray-900 xl:min-h-0">
              <input type="radio" name={`${id}-der`} className="h-4 w-4" checked={choix.genre === "aucune"} disabled={enCours} onChange={() => setChoix({ genre: "aucune" })} />
              Sans dérogation
            </label>
            {mesDerogations.map((d) => (
              <label key={d.id} className="flex min-h-[44px] cursor-pointer items-start gap-2 text-sm text-gray-900 xl:min-h-0">
                <input type="radio" name={`${id}-der`} className="mt-1 h-4 w-4" checked={choix.genre === "liste" && choix.id === d.id} disabled={enCours} onChange={() => setChoix({ genre: "liste", id: d.id })} />
                <span>Dérogation accordée par {d.accordeePar?.nomComplet ?? "un administrateur"}, valable jusqu&apos;au {formaterDate(d.expireLe)} : {d.jeuxIds.length} jeu(x)</span>
              </label>
            ))}
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-gray-900 xl:min-h-0">
              <input type="radio" name={`${id}-der`} className="h-4 w-4" checked={choix.genre === "saisie"} disabled={enCours} onChange={() => setChoix({ genre: "saisie" })} />
              Une dérogation dont un administrateur m&apos;a communiqué l&apos;identifiant
            </label>
            {choix.genre === "saisie" && (
              <div>
                <label htmlFor={`${id}-derid`} className="block text-xs font-medium text-gray-900">Identifiant de la dérogation</label>
                <Input id={`${id}-derid`} value={saisieId} maxLength={36} autoComplete="off" spellCheck={false} disabled={enCours} aria-invalid={saisieId !== "" && saisieInvalide ? true : undefined}
                  aria-describedby={`${id}-derid-aide`} onChange={(e) => setSaisieId(e.target.value)} className="mt-0.5 border-gray-300 font-mono" />
                <p id={`${id}-derid-aide`} className="text-xs text-gray-700">Une dérogation ne sert qu&apos;à son bénéficiaire, sur ce projet, une seule fois. Elle n&apos;est consommée que si l&apos;archive vous est entièrement remise.</p>
              </div>
            )}
            {!estAdmin && <p className="text-xs text-gray-700">Les dérogations qui vous désignent sur ce projet apparaissent ci-dessus ; la liste de toutes les dérogations reste réservée aux administrateurs.</p>}
          </fieldset>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" className="min-h-[44px] xl:min-h-9" disabled={!enLigne || enCours || (geojson && saisieInvalide)} onClick={() => void exporter()}>
            <Download aria-hidden="true" /> {enCours ? "Fabrication en cours…" : "Fabriquer et télécharger le dossier"}
          </Button>
          {enCours && (
            <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" onClick={() => controleur.current?.abort()}>
              <X aria-hidden="true" /> Annuler
            </Button>
          )}
        </div>
        {enCours && (
          <p role="status" data-testid="attente-export" className="text-xs text-gray-800">
            Fabrication depuis {ecoule} s. Le serveur s&apos;arrête de lui-même au-delà de 50 s ; votre navigateur cesse d&apos;attendre après {DELAI_EXPORT_NAVIGATEUR_MS / 1000} s.
          </p>
        )}
        {!enLigne && <p className="text-xs text-amber-900">Vous êtes hors ligne : l&apos;export est impossible tant que la connexion n&apos;est pas revenue.</p>}
        {erreur && <p role="alert" data-code={erreur.code ?? undefined} className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-900">{erreur.message}</p>}
        {resultat && (
          <div data-testid="export-remis" className="space-y-0.5 rounded border border-green-300 bg-green-50 p-2 text-xs text-green-900">
            <p className="font-semibold">Dossier remis : {resultat.nomFichier}{resultat.tailleOctets !== null ? ` (${formaterTaille(resultat.tailleOctets)})` : ""}</p>
            <p>{resultat.nbFichiers !== null ? `${formaterNombre(resultat.nbFichiers, 0)} fichiers` : "Nombre de fichiers non communiqué"}, dont {resultat.nbJeuxGeojson !== null ? `${formaterNombre(resultat.nbJeuxGeojson, 0)} GeoJSON` : "un nombre non communiqué de GeoJSON"}.</p>
            {resultat.sha256 && <p className="break-all">Empreinte SHA-256 de l&apos;archive : <span className="font-mono">{resultat.sha256}</span></p>}
            {resultat.nbJeuxGeojson !== null && resultat.comparable && resultat.nbJeuxGeojson !== resultat.prevus && (
              <p data-testid="ecart-prevision">Le serveur a exporté {resultat.nbJeuxGeojson} GeoJSON pour {resultat.prevus} prévu(s) : son réglage en a décidé autrement ; voyez le manifeste de l&apos;archive.</p>
            )}
            <p>Vérifiez l&apos;intégrité avec manifeste.sha256 (commande sha256sum -c).</p>
          </div>
        )}
      </div>

      <section aria-labelledby="pv-titre-journal-exports" className="space-y-1">
        <h4 id="pv-titre-journal-exports" className="text-xs font-semibold text-gray-900">Journal des exports de ce projet</h4>
        {journal.isPending && <EtatChargement libelle="Chargement du journal…" />}
        {journal.isError && <EtatErreur erreur={classerErreurExports(journal.error)} sujet="Journal des exports" onReessayer={() => void journal.refetch()} enCours={journal.isFetching} />}
        {journal.isSuccess && journal.data.length === 0 && <p className="text-xs text-gray-700">Aucun export n&apos;a encore été demandé pour ce projet.</p>}
        {journal.isSuccess && journal.data.length > 0 && (
          <ul aria-label="Tentatives d'export" className="space-y-1 text-xs text-gray-800">
            {journal.data.map((t) => (
              <li key={t.id} className="rounded border border-gray-200 p-1.5">
                <p><span className="font-semibold text-gray-900">{t.statut ? LIBELLE_TENTATIVE[t.statut] : "Statut inconnu"}</span> · {formaterDate(t.createdAt)} · {t.acteur?.nomComplet ?? "compte non nommé"}{t.derogationId ? " · avec dérogation" : ""}</p>
                {t.statut === "REMIS" && <p>{t.nbFichiers ?? "?"} fichiers, {t.nbJeuxGeojson ?? "?"} GeoJSON{t.tailleOctets !== null ? `, ${formaterTaille(t.tailleOctets)}` : ""}{t.sha256 ? <>, empreinte <span className="font-mono">{t.sha256.slice(0, 12)}…</span></> : null}</p>}
                {t.codeEchec && <p>Cause : {t.codeEchec}</p>}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-gray-700">Chaque tentative compte dans la cadence des exports, même en échec.</p>
      </section>

      {estAdmin && (
        <section aria-labelledby="pv-titre-derogations" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 id="pv-titre-derogations" className="flex items-center gap-1 text-xs font-semibold text-gray-900"><ShieldCheck aria-hidden="true" className="h-4 w-4" />Dérogations de confidentialité</h4>
            <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => setOctroi(true)}>
              <KeyRound aria-hidden="true" /> Accorder une dérogation
            </Button>
          </div>
          {derogations.isPending && <EtatChargement libelle="Chargement des dérogations…" />}
          {derogations.isError && <EtatErreur erreur={classerErreurExports(derogations.error)} sujet="Dérogations" onReessayer={() => void derogations.refetch()} enCours={derogations.isFetching} />}
          {derogations.isSuccess && derogations.data.length === 0 && <p className="text-xs text-gray-700">Aucune dérogation accordée sur ce projet.</p>}
          {derogations.isSuccess && derogations.data.length > 0 && (
            <ul aria-label="Dérogations du projet" className="space-y-1">
              {derogations.data.map((d) => <ElementDerogation key={d.id} d={d} moi={compteId} nomJeu={nomJeu} />)}
            </ul>
          )}
        </section>
      )}

      {estAdmin && octroi && (
        <DialogueDerogation jeux={jeuxDerogation} compteId={compteId} enLigne={enLigne} onFermer={() => setOctroi(false)}
          onValider={async (c) => { const d = await accorder.mutateAsync(c); setAnnonce(`Dérogation accordée à ${d.beneficiaire?.nomComplet ?? "son bénéficiaire"}.`); }} />
      )}
    </section>
  );
}

function ElementDerogation({ d, moi, nomJeu }: { d: Derogation; moi: string | undefined; nomJeu: (id: string) => string }) {
  return (
    <li className="space-y-0.5 rounded border border-gray-200 p-2 text-xs text-gray-800" data-etat-derogation={d.etat ?? d.etatBrut ?? "INCONNU"}>
      <p className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-semibold ${d.etat === "DISPONIBLE" ? "border-green-400 bg-green-50 text-green-900" : d.etat === "RESERVEE" ? "border-amber-400 bg-amber-50 text-amber-900" : "border-gray-400 bg-white text-gray-900"}`}>
          {d.etat ? LIBELLE_ETAT_DEROGATION[d.etat] : `État inconnu (${d.etatBrut ?? "non communiqué"})`}
        </span>
        <span>Bénéficiaire : <strong>{d.beneficiaire?.nomComplet ?? "non nommé"}</strong>{d.beneficiaire?.id === moi ? " (vous)" : ""}</span>
      </p>
      {d.etat && <p className="text-gray-700">Elle {AIDE_ETAT_DEROGATION[d.etat]}.</p>}
      <p>Accordée par {d.accordeePar?.nomComplet ?? "un administrateur"} le {formaterDate(d.createdAt)} ; expire le {formaterDate(d.expireLe)}{d.utiliseeLe ? ` ; utilisée le ${formaterDate(d.utiliseeLe)}` : ""}.</p>
      <p>Jeux : {d.jeuxIds.map(nomJeu).join(", ") || "aucun"}</p>
      {d.justification && <p className="break-words">Justification : {d.justification}</p>}
      <p>Identifiant à communiquer au bénéficiaire : <span className="select-all break-all font-mono">{d.id}</span></p>
    </li>
  );
}
