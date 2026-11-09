/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useId, useState } from "react";
import { GitCompare, History } from "lucide-react";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Input";
import { CadreDialogue, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { EtatChargement, EtatErreur, EtatVide } from "../EtatsPv";
import { BadgeResultat, StatutReseau, libelleTypeReseau } from "./commun";
import { ResultatsComparaison } from "./ResultatsComparaison";
import { ReglesRapprochement } from "./ReglesRapprochement";
import { useComparaisons, useLancerComparaison, useSources } from "../../../lib/projetsVoirieSourcesHooks";
import { useReferentiel } from "../../../lib/projetsVoirieTerritoiresHooks";
import { formaterDate, formaterNombre } from "../../../lib/projetsVoirie";
import {
  LIBELLE_MODE, MENTION_SANS_FUSION, classerErreurSources, totauxParStatut,
  type Comparaison, type GroupeSources, type SourceJeu,
} from "../../../lib/projetsVoirieSources";
import { libelleDeCode, type ValeurReferentiel } from "../../../lib/projetsVoirieTerritoires";
import { texteMetres } from "../../../lib/projetsVoirieReseaux";

/**
 * Onglet « Sources » de la fiche projet (lot S1) : sources de chaque reseau, comparaisons, regles de rapprochement.
 *
 * - Un reseau a source unique est dans l'etat NORMAL « Source unique : comparaison indisponible » : ton neutre, jamais une erreur.
 * - Comparer est un geste ADMIN / GESTIONNAIRE ; le serveur choisit le mode et la reference (A) ; un lecteur ne voit aucun bouton d'ecriture.
 * - Rien ici ne fusionne, ne retient ni ne corrige une source ; un dossier de divergence ne s'ouvre que par une action humaine justifiee.
 * Les geometries ne sont ni chargees ni affichees : l'API S1 n'en rend aucune.
 */
export function OngletSources({ projetId, actif, peutEcrire, estAdmin, compteId, enLigne }: {
  projetId: string; actif: boolean; peutEcrire: boolean; estAdmin: boolean; compteId: string | undefined; enLigne: boolean;
}) {
  const sources = useSources(projetId, actif);
  const comparaisons = useComparaisons(projetId, actif);
  const types = useReferentiel("TYPE_RESEAU", actif);
  const methodes = useReferentiel("METHODE_ACQUISITION", actif);
  const [aComparer, setAComparer] = useState<{ groupe: GroupeSources; candidat: SourceJeu | null } | null>(null);
  const [ouverte, setOuverte] = useState<string | null>(null);
  const lancer = useLancerComparaison(projetId);
  const [annonce, setAnnonce] = useState<string | null>(null);

  const erreur = sources.isError ? classerErreurSources(sources.error) : null;
  const listeCmp = comparaisons.data?.pages.flatMap((p) => p.comparaisons) ?? [];
  const typesV = types.data?.valeurs;
  const methodesV = methodes.data?.valeurs;

  function surComparee(c: Comparaison) {
    setOuverte(c.id);
    setAnnonce(c.statut === "TERMINEE" ? `Comparaison n° ${c.numero ?? ""} terminée : ses résultats sont affichés ci-dessous.` : `Comparaison n° ${c.numero ?? ""} en échec : la cause est indiquée dans son détail.`);
  }

  return (
    <section aria-labelledby="pv-titre-sources" className="space-y-4">
      <div>
        <h3 id="pv-titre-sources" className="text-sm font-semibold text-navy">Sources des réseaux</h3>
        <p className="text-xs text-gray-700">{MENTION_SANS_FUSION}</p>
      </div>
      <p role="status" aria-live="polite" className="sr-only">{annonce ?? ""}</p>

      {sources.isPending && <EtatChargement libelle="Chargement des sources…" />}
      {erreur && <EtatErreur erreur={erreur} sujet="Sources" onReessayer={() => void sources.refetch()} enCours={sources.isFetching} />}
      {sources.isSuccess && sources.data.reseaux.length === 0 && (
        <EtatVide titre="Aucune source autorisée pour l'instant">
          <p>Une source est un jeu autorisé : un plan d&apos;axes ou le réseau d&apos;un concessionnaire. Déposez et autorisez un fichier pour la voir ici.</p>
        </EtatVide>
      )}
      {sources.isSuccess && sources.data.ignores > 0 && <p className="text-xs text-amber-900">{sources.data.ignores} groupe(s) de sources illisible(s) ont été écartés de l&apos;affichage.</p>}

      {sources.data?.reseaux.map((g) => (
        <article key={`${g.role}-${g.concessionnaire?.id ?? ""}-${g.typeReseauCode ?? g.typeReseau ?? ""}`} aria-label={titreGroupe(g, typesV)} className="space-y-2 rounded-md border border-gray-200 p-3">
          <h4 className="text-sm font-semibold text-gray-900">{titreGroupe(g, typesV)}</h4>
          <StatutReseau statut={g.statut} />
          <TableSources sources={g.sources} methodes={methodesV} legende={`Sources de ${titreGroupe(g, typesV)}`} />
          {g.derniereComparaison && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-800">
              <span>Dernière comparaison : n° {g.derniereComparaison.numero ?? "?"} du {formaterDate(g.derniereComparaison.createdAt)}</span>
              {totauxParStatut(g.derniereComparaison.totaux).filter((t) => t.n > 0).map((t) => <span key={t.statut} className="inline-flex items-center gap-1"><BadgeResultat statut={t.statut} /><span className="tabular-nums">{formaterNombre(t.n, 0)}</span></span>)}
              <button type="button" className="min-h-[44px] font-medium text-navy underline xl:min-h-0" onClick={() => setOuverte(g.derniereComparaison?.id ?? null)}>Voir ses résultats</button>
            </div>
          )}
          {g.versionsCandidates && g.versionsCandidates.length > 0 && (
            <div className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">
              <p className="font-semibold">Version(s) candidate(s) en contrôle (visibles des seuls décideurs)</p>
              <ul className="space-y-1">
                {g.versionsCandidates.map((v) => (
                  <li key={v.jeuId} className="flex flex-wrap items-center gap-2">
                    <span>{v.nomFichier}, version {v.version} ({libelleDeCode(v.methodeAcquisition, methodesV, "méthode non renseignée")})</span>
                    {peutEcrire && (
                      <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => setAComparer({ groupe: g, candidat: v })}>
                        <GitCompare aria-hidden="true" /> Comparer à la version autorisée
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              <p>La comparaison avant autorisation ne vaut pas autorisation et ne modifie aucun des deux jeux.</p>
            </div>
          )}
          {g.statut === "COMPARABLE" && peutEcrire && (
            <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => setAComparer({ groupe: g, candidat: null })}>
              <GitCompare aria-hidden="true" /> Comparer deux sources
            </Button>
          )}
          {g.mention && <p className="text-xs text-gray-700">{g.mention}</p>}
        </article>
      ))}

      <section aria-labelledby="pv-titre-historique-cmp" className="space-y-2">
        <h3 id="pv-titre-historique-cmp" className="flex items-center gap-1 text-sm font-semibold text-navy"><History aria-hidden="true" className="h-4 w-4" />Historique des comparaisons</h3>
        {comparaisons.isPending && <EtatChargement libelle="Chargement des comparaisons…" />}
        {comparaisons.isError && <EtatErreur erreur={classerErreurSources(comparaisons.error)} sujet="Comparaisons" onReessayer={() => void comparaisons.refetch()} enCours={comparaisons.isFetching} />}
        {comparaisons.isSuccess && listeCmp.length === 0 && <p className="text-xs text-gray-700">Aucune comparaison n&apos;a encore été lancée sur ce projet.</p>}
        {listeCmp.length > 0 && (
          <ul className="space-y-1">
            {listeCmp.map((c) => (
              <li key={c.id} className={`flex flex-wrap items-center gap-2 rounded border p-2 text-xs ${ouverte === c.id ? "border-navy bg-gray-50" : "border-gray-200"}`}>
                <span className="font-semibold text-gray-900">N° {c.numero ?? "?"}</span>
                <span className="text-gray-800">{formaterDate(c.createdAt)}</span>
                <span className="text-gray-800">{c.mode ? LIBELLE_MODE[c.mode] : "Mode non précisé"}</span>
                {c.statut === "ECHEC" ? <span className="font-semibold text-red-800">Échec</span> : (
                  <span className="flex flex-wrap gap-1">{totauxParStatut(c.resume?.totaux).filter((t) => t.n > 0).map((t) => <span key={t.statut} className="inline-flex items-center gap-1"><BadgeResultat statut={t.statut} /><span className="tabular-nums">{formaterNombre(t.n, 0)}</span></span>)}</span>
                )}
                <Button type="button" size="sm" variant="ghost" className="ml-auto min-h-[44px] xl:min-h-8" aria-pressed={ouverte === c.id} onClick={() => setOuverte(ouverte === c.id ? null : c.id)}>
                  {ouverte === c.id ? "Masquer le détail" : "Voir le détail"}<span className="sr-only"> de la comparaison n° {c.numero ?? ""}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {comparaisons.hasNextPage && (
          <Button type="button" variant="outline" size="sm" className="min-h-[44px] xl:min-h-8" disabled={comparaisons.isFetchingNextPage} onClick={() => void comparaisons.fetchNextPage()}>
            {comparaisons.isFetchingNextPage ? "Chargement…" : "Comparaisons plus anciennes"}
          </Button>
        )}
      </section>

      {ouverte && <ResultatsComparaison key={ouverte} projetId={projetId} cmpId={ouverte} peutEcrire={peutEcrire} enLigne={enLigne} methodes={methodesV} onFermer={() => setOuverte(null)} />}

      <ReglesRapprochement projetId={projetId} actif={actif} peutEcrire={peutEcrire} estAdmin={estAdmin} compteId={compteId} enLigne={enLigne} />

      {aComparer && (
        <DialogueComparaison
          groupe={aComparer.groupe} candidat={aComparer.candidat} titre={titreGroupe(aComparer.groupe, typesV)} methodes={methodesV} enLigne={enLigne}
          onFermer={() => setAComparer(null)}
          onValider={async (a, b) => { const c = await lancer.mutateAsync({ jeuAId: a, jeuBId: b }); surComparee(c); }}
        />
      )}
    </section>
  );
}

function titreGroupe(g: GroupeSources, types: readonly ValeurReferentiel[] | undefined): string {
  if (g.role === "AXES_TRAVAUX") return "Plan d'axes de travaux";
  return `${g.concessionnaire?.nom ?? "Concessionnaire inconnu"} · ${libelleTypeReseau(g.typeReseauCode, g.typeReseau, types)}`;
}

function TableSources({ sources, methodes, legende }: { sources: SourceJeu[]; methodes: readonly ValeurReferentiel[] | undefined; legende: string }) {
  return (
    <div role="region" aria-label={`${legende}, tableau défilant`} tabIndex={0} className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-left text-xs">
        <caption className="sr-only">{legende}</caption>
        <thead className="bg-gray-100 text-gray-800">
          <tr>
            <th scope="col" className="px-2 py-1 font-semibold">Fichier</th>
            <th scope="col" className="px-2 py-1 font-semibold">Méthode d&apos;acquisition</th>
            <th scope="col" className="px-2 py-1 font-semibold">Date des données</th>
            <th scope="col" className="px-2 py-1 font-semibold">Précision</th>
            <th scope="col" className="px-2 py-1 text-right font-semibold">Objets</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.jeuId} className="border-t border-gray-200 align-top">
              <th scope="row" className="px-2 py-1 text-left font-normal"><span className="break-all font-medium text-gray-900">{s.nomFichier}</span> <span className="text-gray-700">v{s.version}</span></th>
              <td className="px-2 py-1">{libelleDeCode(s.methodeAcquisition, methodes)}</td>
              <td className="px-2 py-1">{formaterDate(s.dateDonnees)}</td>
              <td className="px-2 py-1">{s.precisionHorizontaleM !== null ? texteMetres(s.precisionHorizontaleM) : s.classePrecision ? `classe ${s.classePrecision}, sans précision en mètres` : "inconnue"}</td>
              <td className="px-2 py-1 text-right tabular-nums">{s.nbObjets === null ? "n/d" : formaterNombre(s.nbObjets, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Choix des deux jeux a comparer. Le serveur ordonne A et B lui-meme (A = la reference) et deduit le mode des statuts ; la requete ne porte que
 * les deux identifiants. Pour une version candidate, la seconde source est la version autorisee qu'elle remplacera (choisie d'office, modifiable).
 */
function DialogueComparaison({ groupe, candidat, titre, methodes, enLigne, onFermer, onValider }: {
  groupe: GroupeSources; candidat: SourceJeu | null; titre: string; methodes: readonly ValeurReferentiel[] | undefined; enLigne: boolean;
  onFermer: () => void; onValider: (a: string, b: string) => Promise<unknown>;
}) {
  const id = useId();
  const remplace = candidat && "remplace" in candidat ? (candidat as { remplace: string | null }).remplace : null;
  const [a, setA] = useState(candidat ? candidat.jeuId : groupe.sources[0]?.jeuId ?? "");
  const [b, setB] = useState(candidat ? (remplace && groupe.sources.some((s) => s.jeuId === remplace) ? remplace : groupe.sources[0]?.jeuId ?? "") : groupe.sources[1]?.jeuId ?? "");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurSources);
  const choix = candidat ? [candidat, ...groupe.sources] : groupe.sources;
  const libelle = (s: SourceJeu) => `${s.nomFichier}, v${s.version} (${libelleDeCode(s.methodeAcquisition, methodes, "méthode non renseignée")})`;
  const erreurs = a && b && a === b ? ["Choisissez deux jeux différents."] : !a || !b ? ["Choisissez les deux jeux à comparer."] : [];
  return (
    <CadreDialogue
      titre="Lancer une comparaison"
      description={<>
        <p><strong>{titre}</strong></p>
        <p>Les objets linéaires des deux jeux sont appariés par un corridor : la plus grande des deux précisions déclarées, plus la marge de la règle de rapprochement en vigueur. Sans deux précisions en mètres, le résultat est un rapprochement incertain, sans aucune distance.</p>
        <p>{MENTION_SANS_FUSION}</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Lancer la comparaison" libelleEnCours="Comparaison en cours…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider(a, b))} enLigne={enLigne} large
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-a`} className={LIBELLE_CHAMP}>{candidat ? "Version candidate" : "Première source"}</label>
          <Select id={`${id}-a`} value={a} onChange={(e) => setA(e.target.value)} disabled={enCours || !!candidat} className="mt-1 border-gray-300">
            {choix.map((s) => <option key={s.jeuId} value={s.jeuId}>{libelle(s)}</option>)}
          </Select>
        </div>
        <div>
          <label htmlFor={`${id}-b`} className={LIBELLE_CHAMP}>{candidat ? "Version autorisée" : "Seconde source"}</label>
          <Select id={`${id}-b`} value={b} onChange={(e) => setB(e.target.value)} disabled={enCours} className="mt-1 border-gray-300">
            {groupe.sources.map((s) => <option key={s.jeuId} value={s.jeuId}>{libelle(s)}</option>)}
          </Select>
        </div>
      </div>
      <p className="text-xs text-gray-700">Le serveur désigne lui-même la référence A (la version autorisée, ou le dépôt le plus ancien) et le mode de comparaison.</p>
    </CadreDialogue>
  );
}
