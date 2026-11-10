import { useId, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { Button } from "../../ui/Button";
import { CadreDialogue, CHAMP_TEXTE, Compteur, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { EtatChargement, EtatErreur } from "../EtatsPv";
import { BadgeResultat } from "./commun";
import { useComparaison, useOuvrirDossierDivergence, useReglesRapprochement, useResultats } from "../../../lib/projetsVoirieSourcesHooks";
import { formaterDate, formaterNombre } from "../../../lib/projetsVoirie";
import { justificationValide } from "../../../lib/projetsVoirieConflits";
import {
  AIDE_STATUT_RESULTAT, LIBELLE_MODE, LIBELLE_STATUT_RESULTAT, MENTION_SANS_FUSION, STATUTS_RESULTAT, classerErreurSources, provenanceBareme, provenancePrecision, raisonIncertitude, texteBareme, texteMesure, totauxParStatut,
  type Comparaison, type JeuDansComparaison, type ProvenanceBareme, type ResultatComparaison, type StatutResultat,
} from "../../../lib/projetsVoirieSources";
import { libelleDeCode, type ValeurReferentiel } from "../../../lib/projetsVoirieTerritoires";

/**
 * Detail d'une comparaison et resultats par objet (pagination par curseur, filtre par statut). Aucune geometrie : l'API S1 n'en rend aucune.
 *
 * - DIVERGENCE : distance de Hausdorff et longueur hors corridor ; une mesure masquee pour ce compte (objet ou jeu B illisible) est dite telle.
 * - RAPPROCHEMENT_INCERTAIN : JAMAIS de distance, avec la raison (precision en metres manquante).
 * - Ouvrir un dossier de divergence : ADMIN / GESTIONNAIRE, sur un resultat DIVERGENCE, avec une justification ; rien d'autre ne change.
 */
export function ResultatsComparaison({ projetId, cmpId, peutEcrire, enLigne, methodes, onFermer }: {
  projetId: string; cmpId: string; peutEcrire: boolean; enLigne: boolean; methodes: readonly ValeurReferentiel[] | undefined; onFermer: () => void;
}) {
  const detail = useComparaison(projetId, cmpId);
  const [filtres, setFiltres] = useState<StatutResultat[]>([]);
  // Revue m4 : `[]` veut dire « tous » ; la derniere case cochee ne se decoche donc pas, et l'ecran le dit.
  const [messageFiltre, setMessageFiltre] = useState<string | null>(null);
  const resultats = useResultats(projetId, detail.data?.statut === "TERMINEE" ? cmpId : null, filtres);
  const [dossier, setDossier] = useState<ResultatComparaison | null>(null);
  const ouvrir = useOuvrirDossierDivergence(projetId);
  // Revue UI-C, M1 : une regle du SYSTEME (aucun auteur) n'a jamais de bareme « approuve » ; la liste des regles le dit (`systeme`).
  const regles = useReglesRapprochement(projetId);
  const c = detail.data;
  const systeme = !!c?.regle && (c.regle.portee === "DEFAUT" || (regles.data?.regles.some((r) => r.id === c.regle?.regleId && r.systeme) ?? false));
  const provenance = c ? provenanceBareme(c, systeme) : null;
  const pages = resultats.data?.pages ?? [];
  const liste = pages.flatMap((p) => p.resultats);
  const masque = pages.some((p) => p.masque);
  const ignores = pages.reduce((n, p) => n + p.ignores, 0);

  return (
    <section aria-labelledby={`pv-cmp-${cmpId}`} className="space-y-3 rounded-md border border-navy/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={`pv-cmp-${cmpId}`} className="text-sm font-semibold text-navy">Comparaison {c?.numero !== null && c?.numero !== undefined ? `n° ${c.numero}` : ""}</h3>
        <Button type="button" size="sm" variant="ghost" className="min-h-[44px] xl:min-h-8" onClick={onFermer}><X aria-hidden="true" /> Fermer le détail</Button>
      </div>
      {detail.isPending && <EtatChargement libelle="Chargement de la comparaison…" />}
      {detail.isError && <EtatErreur erreur={classerErreurSources(detail.error)} sujet="Comparaison" onReessayer={() => void detail.refetch()} enCours={detail.isFetching} />}
      {c && provenance && <EnTete c={c} methodes={methodes} provenance={provenance} />}

      {c?.statut === "ECHEC" && (
        <p role="status" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">
          Cette comparaison a échoué{c.resume?.erreur?.code ? ` (${c.resume.erreur.code})` : ""} : elle n&apos;a aucun résultat. {c.resume?.erreur?.message ?? ""}
        </p>
      )}

      {c?.statut === "TERMINEE" && (
        <>
          <fieldset className="space-y-1">
            <legend className="text-xs font-semibold text-gray-900">Afficher les résultats</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {STATUTS_RESULTAT.map((s) => (
                <label key={s} className="flex min-h-[44px] items-center gap-1.5 text-xs text-gray-900 xl:min-h-0">
                  <input type="checkbox" className="h-4 w-4" checked={filtres.length === 0 || filtres.includes(s)}
                    onChange={(e) => {
                      const base = filtres.length === 0 ? [...STATUTS_RESULTAT] : filtres;
                      const n = e.target.checked ? [...new Set([...base, s])] : base.filter((x) => x !== s);
                      if (n.length === 0) { setMessageFiltre("Au moins un statut doit rester coché."); return; }
                      setMessageFiltre(null);
                      setFiltres(n.length === STATUTS_RESULTAT.length ? [] : n);
                    }} />
                  {LIBELLE_STATUT_RESULTAT[s]}
                </label>
              ))}
            </div>
            <p data-testid="filtre-statut-message" role="status" aria-live="polite" className="text-xs text-amber-900">{messageFiltre ?? ""}</p>
          </fieldset>
          {resultats.isPending && <EtatChargement libelle="Chargement des résultats…" />}
          {resultats.isError && <EtatErreur erreur={classerErreurSources(resultats.error)} sujet="Résultats" onReessayer={() => void resultats.refetch()} enCours={resultats.isFetching} />}
          {masque && (
            <p role="status" data-testid="resultats-masques" className="rounded border border-gray-300 bg-gray-50 p-2 text-xs text-gray-800">
              Les résultats par objet ne sont pas communiqués : une des deux sources a été retirée, ou n&apos;est pas lisible pour votre compte. Les totaux ci-dessus, figés au calcul, restent valables.
            </p>
          )}
          {resultats.isSuccess && !masque && liste.length === 0 && <p className="text-xs text-gray-700">Aucun résultat pour ces statuts.</p>}
          {ignores > 0 && <p className="text-xs text-amber-900">{ignores} résultat(s) illisible(s) ont été écartés de l&apos;affichage.</p>}
          {liste.length > 0 && (
            <ol className="space-y-2" aria-label="Résultats par objet">
              {liste.map((r) => (
                <li key={r.id} className="space-y-1 rounded border border-gray-200 p-2 text-xs text-gray-900">
                  <div className="flex flex-wrap items-center gap-2"><BadgeResultat statut={r.statut} /><span className="text-gray-700">{AIDE_STATUT_RESULTAT[r.statut]}</span></div>
                  <LigneObjet libelle="Source A" objet={r.objetA} attendu={r.statut !== "SANS_CORRESPONDANCE_B"} provenance={provenance} />
                  <LigneObjet libelle="Source B" objet={r.objetB} attendu={r.statut !== "SANS_CORRESPONDANCE_A"} provenance={provenance} />
                  {r.statut === "DIVERGENCE" && (
                    <p data-testid="mesure-divergence"><span className="font-semibold">Mesure : </span>{texteMesure(r) ?? "non communiquée (mesure masquée pour votre compte)"}</p>
                  )}
                  {r.statut === "CONCORDANCE" && texteMesure(r) && <p><span className="font-semibold">Mesure : </span>{texteMesure(r)}</p>}
                  {r.statut === "RAPPROCHEMENT_INCERTAIN" && <p data-testid="raison-incertain"><span className="font-semibold">Raison : </span>{raisonIncertitude(r)} Aucune distance n&apos;est mesurée.</p>}
                  {r.conflitId ? (
                    <p className="font-semibold text-gray-900">Dossier de divergence ouvert (à investiguer) : retrouvez-le dans l&apos;onglet Conflits.</p>
                  ) : r.statut === "DIVERGENCE" && peutEcrire && (
                    <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => setDossier(r)}>
                      <FolderOpen aria-hidden="true" /> Ouvrir un dossier de divergence
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          )}
          {resultats.hasNextPage && (
            <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" disabled={resultats.isFetchingNextPage} onClick={() => void resultats.fetchNextPage()}>
              {resultats.isFetchingNextPage ? "Chargement…" : "Charger plus de résultats"}
            </Button>
          )}
        </>
      )}

      {dossier && c && (
        <DialogueDossierDivergence
          resultat={dossier} enLigne={enLigne} onFermer={() => setDossier(null)}
          onValider={(justification) => ouvrir.mutateAsync({ cmpId: c.id, resultatId: dossier.id, justification }).then(() => resultats.refetch())}
        />
      )}
    </section>
  );
}

function EnTete({ c, methodes, provenance }: { c: Comparaison; methodes: readonly ValeurReferentiel[] | undefined; provenance: ProvenanceBareme }) {
  const jeu = (r: "A" | "B") => c.jeux.find((j) => j.role === r) ?? null;
  const decrire = (j: JeuDansComparaison | null) => {
    if (!j || c.donneesMasquees || !j.nomFichier) return "données du jeu non communiquées";
    return `${j.nomFichier}, v${j.version ?? "?"}, ${libelleDeCode(j.methodeAcquisition, methodes, "méthode non renseignée")}, données du ${formaterDate(j.dateDonnees)}`;
  };
  const r = c.regle;
  const corridor = c.resume?.corridor;
  return (
    <div className="space-y-2 text-xs text-gray-900">
      <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <dt className="font-semibold">Mode</dt><dd>{c.mode ? LIBELLE_MODE[c.mode] : "non précisé"}</dd>
        <dt className="font-semibold">Référence (A)</dt><dd>{decrire(jeu("A"))}</dd>
        <dt className="font-semibold">Comparée (B)</dt><dd>{decrire(jeu("B"))}</dd>
        <dt className="font-semibold">Règle appliquée</dt>
        <dd>{r?.code ? `${r.code} v${r.version ?? "?"}` : "non précisée"}{r?.margeM !== null && r?.margeM !== undefined ? `, marge ${formaterNombre(r.margeM, 2)} m` : ""}{r?.rayonAppariementM !== null && r?.rayonAppariementM !== undefined ? `, rayon d'appariement ${formaterNombre(r.rayonAppariementM, 2)} m` : ""}</dd>
        <dt className="font-semibold">Corridor</dt>
        <dd>
          Plus grande des deux précisions en mètres, plus la marge.
          {corridor && corridor.minM !== null && corridor.maxM !== null ? ` De ${formaterNombre(corridor.minM, 2)} à ${formaterNombre(corridor.maxM, 2)} m sur cette comparaison.` : ""}
          {corridor?.couplesSansCorridor ? ` ${formaterNombre(corridor.couplesSansCorridor, 0)} couple(s) sans corridor (précision manquante).` : ""}
          {" "}<span data-testid="provenance-bareme" data-etat={provenance.etat}>{texteBareme(provenance, r?.precisionParClasseM ?? null)}</span>
        </dd>
        <dt className="font-semibold">Calcul</dt><dd>{c.versionAlgorithme ?? "algorithme non précisé"}{c.epsg ? `, EPSG:${c.epsg}` : ""}, le {formaterDate(c.createdAt)}{c.declenchePar ? ` par ${c.declenchePar.nomComplet}` : ""}</dd>
      </dl>
      {c.donneesMasquees && <p className="rounded border border-gray-300 bg-gray-50 p-2">Une des deux sources a été retirée depuis le calcul : les données tirées des jeux (noms d&apos;objets, fichiers, mesures) ne sont plus communiquées.</p>}
      {c.statut === "TERMINEE" && (
        <ul className="flex flex-wrap gap-2" aria-label="Totaux par statut">
          {totauxParStatut(c.resume?.totaux).map((t) => <li key={t.statut} className="inline-flex items-center gap-1"><BadgeResultat statut={t.statut} /><span className="tabular-nums font-semibold">{formaterNombre(t.n, 0)}</span></li>)}
        </ul>
      )}
      <p className="text-gray-700">{MENTION_SANS_FUSION}</p>
    </div>
  );
}

function LigneObjet({ libelle, objet, attendu, provenance }: { libelle: string; objet: ResultatComparaison["objetA"]; attendu: boolean; provenance: ProvenanceBareme | null }) {
  if (!attendu) return <p><span className="font-semibold">{libelle} : </span>aucun objet apparié.</p>;
  if (!objet) return <p><span className="font-semibold">{libelle} : </span>objet non communiqué (source non lisible pour votre compte).</p>;
  return <p><span className="font-semibold">{libelle} : </span>{objet.nom ?? "Objet sans nom"} ; précision {provenancePrecision(objet, provenance)}.</p>;
}

function DialogueDossierDivergence({ resultat, enLigne, onFermer, onValider }: { resultat: ResultatComparaison; enLigne: boolean; onFermer: () => void; onValider: (justification: string) => Promise<unknown> }) {
  const id = useId();
  const [j, setJ] = useState("");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurSources);
  return (
    <CadreDialogue
      titre="Ouvrir un dossier de divergence"
      description={<>
        <p><BadgeResultat statut={resultat.statut} /> {resultat.objetA?.nom ?? "Objet sans nom"}{resultat.objetB?.nom ? ` / ${resultat.objetB.nom}` : ""}</p>
        <p>Le dossier est ouvert « à investiguer » dans l&apos;onglet Conflits. Il n&apos;ordonne rien, ne déplace rien et ne modifie aucune des deux sources : chacune est préservée.</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider={justificationValide(j)} aide={["Une justification de 10 caractères au moins est obligatoire."]}
      libelleValider="Ouvrir le dossier" libelleEnCours="Ouverture…" onFermer={onFermer} onValider={() => void envoyer(() => onValider(j.trim()))} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-j`} className={LIBELLE_CHAMP}>Justification (10 caractères minimum)</label>
        <textarea id={`${id}-j`} value={j} onChange={(e) => setJ(e.target.value)} rows={3} maxLength={2000} disabled={enCours} aria-describedby={`${id}-jn`} className={CHAMP_TEXTE} />
        <Compteur id={`${id}-jn`} texte={j} />
      </div>
    </CadreDialogue>
  );
}
