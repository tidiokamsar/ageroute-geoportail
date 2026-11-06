import { useId, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, GitCompare, TriangleAlert } from "lucide-react";
import { Button } from "../ui/Button";
import { Select } from "../ui/Input";
import { EtatChargement, EtatErreur, EtatVide } from "./EtatsPv";
import { BadgeStatutConflit, BadgeTypeConflit } from "./BadgesConflit";
import type { AnalyseConflit, CategorieComparaison, ConflitResume } from "../../lib/projetsVoirieConflitsApi";
import { useAnalysesConflits, useComparaison, useDetailAnalyse } from "../../lib/projetsVoirieConflitsHooks";
import { LIBELLE_STATUT_ANALYSE, LIBELLE_TYPE_CONFLIT, classerErreurConflit, formaterDateHeure } from "../../lib/projetsVoirieConflits";
import { LIBELLE_ROLE, STYLE_RESEAU, formaterMetres, formaterNombre, type RoleJeu } from "../../lib/projetsVoirie";

/**
 * Historique des analyses persistees et comparaison de deux analyses (apparus, disparus, modifies, identiques).
 *
 * Une nouvelle analyse ne supprime ni ne ferme jamais un conflit : un conflit « disparu » n'est PAS un conflit resolu, c'est un conflit non
 * retrouve, conserve et a reexaminer. L'ecran le dit. Les cles de comparaison sont des empreintes techniques : quand le dossier correspondant
 * est dans la liste chargee, on montre son axe et son type et on propose de l'ouvrir.
 */

export function BadgeStatutAnalyse({ statut }: { statut: AnalyseConflit["statut"] }) {
  const ok = statut === "TERMINEE";
  return (
    <span data-statut-analyse={statut} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold ${ok ? "border-green-400 bg-green-50 text-green-900" : "border-2 border-red-400 bg-red-50 text-red-900"}`}>
      {ok ? <Check aria-hidden="true" className="h-3 w-3" /> : <TriangleAlert aria-hidden="true" className="h-3 w-3" />}{LIBELLE_STATUT_ANALYSE[statut]}
    </span>
  );
}

const nbOuInconnu = (n: number | null) => (n === null ? "non fourni" : formaterNombre(n, 0));
const libelleAnalyse = (a: Pick<AnalyseConflit, "numero" | "id">) => (a.numero !== null ? `n° ${a.numero}` : `(${a.id.slice(0, 8)})`);

function Detail({ projetId, analyseId }: { projetId: string; analyseId: string }) {
  const d = useDetailAnalyse(projetId, analyseId);
  if (d.isPending) return <EtatChargement libelle="Chargement du détail…" />;
  if (d.isError || !d.data) return <EtatErreur erreur={classerErreurConflit(d.error)} sujet="Détail de l'analyse" onReessayer={() => void d.refetch()} enCours={d.isFetching} />;
  const a = d.data;
  return (
    <div className="space-y-2 border-t border-gray-200 pt-2 text-xs text-gray-900">
      <div>
        <p className="font-semibold">Règles appliquées</p>
        {a.regles.length === 0 ? <p className="text-gray-700">Aucune règle listée par le serveur.</p> : (
          <ul className="list-disc pl-5">{a.regles.map((r, i) => <li key={`${r.regleId ?? r.code}-${i}`}>{r.code ?? "règle sans code"}, version {r.version ?? "inconnue"}{r.famille ? `, ${STYLE_RESEAU[r.famille].libelle}` : ", toutes familles"}</li>)}</ul>
        )}
      </div>
      <div>
        <p className="font-semibold">Jeux de données pris en compte</p>
        {a.jeux.length === 0 ? <p className="text-gray-700">Aucun jeu listé par le serveur.</p> : (
          <ul className="list-disc pl-5">
            {a.jeux.map((j, i) => (
              <li key={`${j.jeuId ?? j.sha256}-${i}`} className="break-words">
                {j.role ? (LIBELLE_ROLE[j.role as RoleJeu] ?? j.role) : "jeu"}, version {j.version ?? "inconnue"}{j.statut ? `, ${j.statut}` : ""}
                {j.sha256 && <span className="block break-all text-[11px] text-gray-700">empreinte SHA-256 : {j.sha256.slice(0, 16)}…</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-gray-700">Rejouer l&apos;analyse avec les mêmes jeux, règles, largeurs et version d&apos;algorithme redonne les mêmes conflits.</p>
    </div>
  );
}

function CarteAnalyse({ projetId, a }: { projetId: string; a: AnalyseConflit }) {
  const [ouvert, setOuvert] = useState(false);
  const r = a.resume;
  const idDetail = useId();
  return (
    <li className="space-y-1 rounded border border-gray-300 bg-white p-2 text-xs text-gray-900" data-analyse-id={a.id}>
      <p className="flex flex-wrap items-center gap-2"><strong className="text-sm text-navy">Analyse {libelleAnalyse(a)}</strong><BadgeStatutAnalyse statut={a.statut} /></p>
      <p className="text-[11px] text-gray-700">
        {formaterDateHeure(a.createdAt)} · {a.declenchePar ? (a.declenchePar.nom ?? "compte sans nom") : "déclencheur inconnu"}
        {a.dureeMs !== null ? ` · durée ${formaterNombre(a.dureeMs / 1000, 1)} s` : ""}
      </p>
      {a.statut === "ECHEC" && <p role="note" className="rounded border border-red-200 bg-red-50 p-1.5 text-red-900">Cette analyse a échoué : elle n&apos;a pas produit de résultat exploitable. Les conflits existants sont restés intacts.</p>}
      <p>
        Largeurs : chaussée {a.largeurChausseeM !== null ? formaterMetres(a.largeurChausseeM) : "non fournie"}, emprise {a.largeurEmpriseM !== null ? formaterMetres(a.largeurEmpriseM) : "non fournie"}
        {a.versionAlgorithme ? ` · algorithme ${a.versionAlgorithme}` : ""}
      </p>
      <p>
        <strong>{nbOuInconnu(r.total)}</strong> conflit(s) · <strong>{nbOuInconnu(r.nouveaux)}</strong> nouveau(x) · <strong>{nbOuInconnu(r.retrouves)}</strong> retrouvé(s) · <strong>{nbOuInconnu(r.disparus)}</strong> non retrouvé(s)
      </p>
      {Object.keys(r.parType).length > 0 && (
        <p className="text-[11px] text-gray-700">Par type : {Object.entries(r.parType).map(([t, n]) => `${LIBELLE_TYPE_CONFLIT[t as keyof typeof LIBELLE_TYPE_CONFLIT] ?? t} ${n}`).join(", ")}.</p>
      )}
      <button
        type="button" aria-expanded={ouvert} aria-controls={idDetail} onClick={() => setOuvert((v) => !v)}
        className="inline-flex min-h-[44px] items-center gap-1 rounded text-xs font-medium text-navy underline focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-8"
      >
        {ouvert ? <ChevronDown aria-hidden="true" className="h-4 w-4" /> : <ChevronRight aria-hidden="true" className="h-4 w-4" />}
        Règles et jeux de l&apos;analyse {libelleAnalyse(a)}
      </button>
      <div id={idDetail} hidden={!ouvert}>{ouvert && <Detail projetId={projetId} analyseId={a.id} />}</div>
    </li>
  );
}

const MAX_CLES = 50;

function ListeCles({ cat, conflitsParCle, onOuvrir }: { cat: CategorieComparaison; conflitsParCle: ReadonlyMap<string, ConflitResume>; onOuvrir: (id: string) => void }) {
  if (cat.nb === 0) return <p className="text-xs text-gray-700">Aucun.</p>;
  if (cat.cles.length === 0) return <p className="text-xs text-gray-700">{formaterNombre(cat.nb, 0)} conflit(s) ; le serveur n&apos;en donne pas la liste.</p>;
  return (
    <>
      <ul className="space-y-1">
        {cat.cles.slice(0, MAX_CLES).map((k) => {
          const c = conflitsParCle.get(k);
          return (
            <li key={k} className="text-xs text-gray-900">
              {c ? (
                <button type="button" onClick={() => onOuvrir(c.id)} className="flex min-h-[44px] w-full flex-wrap items-center gap-1 rounded border border-gray-300 bg-white p-1.5 text-left hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-0">
                  <BadgeStatutConflit statut={c.statut} /><BadgeTypeConflit type={c.type} /><span className="break-words">{c.axe ?? "axe non précisé"}</span>
                  <span className="text-[11px] text-gray-700">Ouvrir le dossier</span>
                </button>
              ) : (
                <span className="break-all text-gray-700">Empreinte …{k.slice(-10)} (dossier hors de la liste chargée)</span>
              )}
            </li>
          );
        })}
      </ul>
      {cat.cles.length > MAX_CLES && <p className="text-[11px] text-gray-700">{cat.cles.length - MAX_CLES} autre(s) non affiché(s).</p>}
    </>
  );
}

export interface PropsAnalysesConflits {
  projetId: string;
  conflitsParCle: ReadonlyMap<string, ConflitResume>;
  onOuvrirConflit: (id: string) => void;
}

export function AnalysesConflits({ projetId, conflitsParCle, onOuvrirConflit }: PropsAnalysesConflits) {
  const requete = useAnalysesConflits(projetId);
  const idA = useId();
  const idB = useId();
  const triees = useMemo(() => [...(requete.data ?? [])].sort((a, b) => (b.numero ?? 0) - (a.numero ?? 0) || (b.createdAt ?? "").localeCompare(a.createdAt ?? "")), [requete.data]);
  const [recenteChoisie, setRecenteChoisie] = useState<string>("");
  const [referenceChoisie, setReferenceChoisie] = useState<string>("");
  const [demande, setDemande] = useState<{ recente: string; reference: string } | null>(null);
  const [erreurSaisie, setErreurSaisie] = useState<string | null>(null);

  const recenteId = recenteChoisie || triees[0]?.id || "";
  const referenceId = referenceChoisie || triees[1]?.id || "";
  const comparaison = useComparaison(projetId, demande?.recente ?? null, demande?.reference ?? null);
  const parId = useMemo(() => new Map(triees.map((a) => [a.id, a])), [triees]);

  function comparer() {
    const a = parId.get(recenteId);
    const b = parId.get(referenceId);
    if (!a || !b || a.id === b.id) { setErreurSaisie("Choisissez deux analyses différentes."); return; }
    // La plus recente est comparee a la reference : « apparus » = presents dans la plus recente, absents de la reference.
    const [recente, reference] = (a.numero ?? 0) >= (b.numero ?? 0) ? [a, b] : [b, a];
    setErreurSaisie(null);
    setDemande({ recente: recente.id, reference: reference.id });
  }

  const nomRecente = demande ? libelleAnalyse(parId.get(demande.recente) ?? { id: demande.recente, numero: null }) : "";
  const nomReference = demande ? libelleAnalyse(parId.get(demande.reference) ?? { id: demande.reference, numero: null }) : "";
  const cats = comparaison.data ? ([
    ["apparus", "Apparus", `Présents dans l'analyse ${nomRecente}, absents de l'analyse ${nomReference} : nouveaux dossiers.`, comparaison.data.apparus],
    ["disparus", "Non retrouvés (disparus)", `Présents dans l'analyse ${nomReference}, absents de l'analyse ${nomRecente}. Ils ne sont ni fermés ni supprimés : ils restent en base, marqués « à réexaminer », leur verdict humain est conservé.`, comparaison.data.disparus],
    ["modifies", "Modifiés", "Même dossier, mesure différente : à réexaminer.", comparaison.data.modifies],
    ["identiques", "Identiques", "Même dossier, même mesure.", comparaison.data.identiques],
  ] as const) : [];

  return (
    <div className="space-y-4">
      <section aria-labelledby="pv-titre-historique-analyses" className="space-y-2">
        <h3 id="pv-titre-historique-analyses" className="text-sm font-semibold text-navy">Historique des analyses</h3>
        <p className="text-xs text-gray-700">Chaque analyse est enregistrée avec les versions des jeux, des règles et de l&apos;algorithme : elle est reproductible. Une nouvelle analyse ne supprime ni ne ferme jamais un conflit et n&apos;écrase aucun verdict humain.</p>
        {requete.isPending && <EtatChargement libelle="Chargement de l'historique…" />}
        {requete.isError && <EtatErreur erreur={classerErreurConflit(requete.error)} sujet="Historique des analyses" onReessayer={() => void requete.refetch()} enCours={requete.isFetching} />}
        {requete.isSuccess && triees.length === 0 && (
          <EtatVide titre="Aucune analyse lancée"><p>Un administrateur ou un gestionnaire peut lancer la première analyse avec le bouton « Lancer une analyse ».</p></EtatVide>
        )}
        {triees.length > 0 && <ul aria-label="Analyses" className="space-y-1.5">{triees.map((a) => <CarteAnalyse key={a.id} projetId={projetId} a={a} />)}</ul>}
      </section>

      <section aria-labelledby="pv-titre-comparaison" className="space-y-2 border-t border-gray-200 pt-3">
        <h3 id="pv-titre-comparaison" className="text-sm font-semibold text-navy">Comparer deux analyses</h3>
        {triees.length < 2 ? (
          <p className="text-xs text-gray-700">Il faut au moins deux analyses pour les comparer.</p>
        ) : (
          <>
            <div className="grid gap-2">
              <div>
                <label htmlFor={idA} className="block text-xs font-medium text-gray-800">Analyse à comparer</label>
                <Select id={idA} value={recenteId} onChange={(e) => setRecenteChoisie(e.target.value)} className="border-gray-300">
                  {triees.map((a) => <option key={a.id} value={a.id}>Analyse {libelleAnalyse(a)}, {formaterDateHeure(a.createdAt)}</option>)}
                </Select>
              </div>
              <div>
                <label htmlFor={idB} className="block text-xs font-medium text-gray-800">Avec l&apos;analyse de référence</label>
                <Select id={idB} value={referenceId} onChange={(e) => setReferenceChoisie(e.target.value)} className="border-gray-300">
                  {triees.map((a) => <option key={a.id} value={a.id}>Analyse {libelleAnalyse(a)}, {formaterDateHeure(a.createdAt)}</option>)}
                </Select>
              </div>
              <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" onClick={comparer}><GitCompare aria-hidden="true" /> Comparer</Button>
            </div>
            {erreurSaisie && <p role="alert" className="text-xs text-red-700">{erreurSaisie}</p>}
          </>
        )}
        {demande && comparaison.isFetching && !comparaison.data && <EtatChargement libelle="Comparaison en cours…" />}
        {demande && comparaison.isError && <EtatErreur erreur={classerErreurConflit(comparaison.error)} sujet="Comparaison" onReessayer={() => void comparaison.refetch()} enCours={comparaison.isFetching} />}
        {demande && comparaison.data && (
          <div aria-live="polite" data-testid="resultat-comparaison" className="space-y-2">
            <p className="text-xs text-gray-800">Comparaison de l&apos;analyse {nomRecente} avec l&apos;analyse {nomReference}.</p>
            {cats.map(([cle, titre, aide, cat]) => (
              <section key={cle} aria-labelledby={`pv-cmp-${cle}`} className="space-y-1 rounded border border-gray-300 bg-white p-2">
                <h4 id={`pv-cmp-${cle}`} className="text-xs font-semibold text-gray-900">{titre} : <span data-testid={`cmp-${cle}`}>{formaterNombre(cat.nb, 0)}</span></h4>
                <p className="text-[11px] text-gray-700">{aide}</p>
                {cle !== "identiques" && <ListeCles cat={cat} conflitsParCle={conflitsParCle} onOuvrir={onOuvrirConflit} />}
              </section>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
