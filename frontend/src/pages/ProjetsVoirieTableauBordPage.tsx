/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, LayoutDashboard } from "lucide-react";
import { BandeauHorsLigne, EtatChargement, EtatErreur } from "../components/projets-voirie/EtatsPv";
import { SelecteurTerritoire } from "../components/projets-voirie/territoires/SelecteurTerritoire";
import { useEnLigne } from "../lib/projetsVoirieHooks";
import { useTableauDeBord } from "../lib/projetsVoirieExportsHooks";
import { LIBELLE_NIVEAU, type NiveauTerritoire, type Territoire } from "../lib/projetsVoirieTerritoires";
import { LIBELLE_STATUT_JEU, formaterDate, type StatutJeu } from "../lib/projetsVoirie";
import { STATUTS_CONFLIT, STYLE_STATUT_CONFLIT, type StatutConflit } from "../lib/projetsVoirieConflits";
import { LIBELLE_STATUT_DOCUMENT, estStatutDocument } from "../lib/projetsVoirieDocuments";
import {
  NON_COMMUNIQUE, classerErreurTableau, jeuxParStatut, valeurAgregat,
  type Agregat, type Lisibilite, type TableauDeBord,
} from "../lib/projetsVoirieExports";

/**
 * Tableaux de bord du module (lot X1, interface UI-D) : national (perimetre du compte) et par territoire (le territoire et ses subdivisions, selecteur
 * du lot UI-C). AGREGATS SEULEMENT : nombres de projets, jeux par statut, dossiers de conflit par statut, documents manquants, referents actifs.
 * Aucune geometrie, aucun nom d'objet, de fichier, de concessionnaire ni de document.
 *
 * Un agregat que le serveur ne communique pas a ce role (`null`, ou un statut hors de la `lisibilite` qu'il annonce) s'affiche « Non communique a votre
 * role », jamais zero. Le territoire choisi n'est pas mis dans l'adresse de la page.
 */

const libelleStatutJeu = (s: string) => LIBELLE_STATUT_JEU[s as StatutJeu] ?? s;
const libelleStatutConflit = (s: string) => STYLE_STATUT_CONFLIT[s as StatutConflit]?.libelle ?? s;

export function ProjetsVoirieTableauBordPage() {
  const id = useId();
  const enLigne = useEnLigne();
  const [portee, setPortee] = useState<"national" | "territoire">("national");
  const [territoire, setTerritoire] = useState<Territoire | null>(null);
  const tid = portee === "territoire" ? territoire?.id ?? null : null;
  const q = useTableauDeBord(tid, portee === "national" || tid !== null);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <Link to="/projets-voirie" className="inline-flex min-h-[44px] items-center gap-1 text-sm text-navy underline xl:min-h-0"><ArrowLeft aria-hidden="true" className="h-4 w-4" /> Projets de voirie</Link>
        <h1 className="flex items-center gap-2 text-xl font-bold text-navy"><LayoutDashboard aria-hidden="true" className="h-5 w-5" />Tableau de bord des projets de voirie</h1>
        <p className="text-sm text-gray-600">Des nombres seulement, calculés sur votre périmètre : ni tracé, ni nom de fichier, de concessionnaire ou de document.</p>
      </header>
      {!enLigne && <BandeauHorsLigne />}

      <fieldset className="flex flex-wrap items-center gap-4">
        <legend className="sr-only">Portée du tableau de bord</legend>
        {(["national", "territoire"] as const).map((p) => (
          <label key={p} className="flex min-h-[44px] cursor-pointer items-center gap-1.5 text-sm text-gray-900 xl:min-h-0">
            <input type="radio" name={`${id}-portee`} className="h-4 w-4" checked={portee === p} onChange={() => setPortee(p)} />
            {p === "national" ? "Tout mon périmètre" : "Un territoire et ses subdivisions"}
          </label>
        ))}
      </fieldset>
      {portee === "territoire" && (
        <div className="max-w-2xl">
          <SelecteurTerritoire libelle="Territoire du tableau de bord" valeur={territoire?.id ?? null} onChange={setTerritoire} aide="Le tableau compte le territoire choisi et toutes ses subdivisions." />
        </div>
      )}

      {portee === "territoire" && !tid && <p className="text-sm text-gray-700">Choisissez un territoire pour afficher son tableau de bord.</p>}
      {q.isFetching && q.isPending && (portee === "national" || tid) && <EtatChargement libelle="Calcul du tableau de bord…" />}
      {q.isError && <EtatErreur erreur={classerErreurTableau(q.error)} sujet="Tableau de bord" onReessayer={() => void q.refetch()} enCours={q.isFetching} />}
      {q.isSuccess && <Tableau t={q.data} />}
    </div>
  );
}

function Tableau({ t }: { t: TableauDeBord }) {
  const restreint = t.lisibilite.jeux === "AUTORISE_SEULEMENT" || !t.lisibilite.documentsEnCours || !t.lisibilite.referents;
  const titre = t.portee === "NATIONAL" ? (t.perimetre.national ? "Tout le pays" : "Vos régions") : t.territoire ? `${t.territoire.nom}${t.territoire.niveau ? ` (${LIBELLE_NIVEAU[t.territoire.niveau as NiveauTerritoire] ?? t.territoire.niveau})` : ""}` : "Territoire";
  return (
    <section aria-labelledby="pv-tdb-titre" className="space-y-4">
      <div>
        <h2 id="pv-tdb-titre" className="text-base font-semibold text-navy">{titre}</h2>
        {t.territoire && t.territoire.ancetres.length > 0 && <p className="text-xs text-gray-700">Dans : {t.territoire.ancetres.map((a) => a.nom).join(" › ")}</p>}
        {t.calculeLe && <p className="text-xs text-gray-700">Calculé le {formaterDate(t.calculeLe)}.</p>}
      </div>
      {restreint && (
        <p data-testid="lisibilite-restreinte" className="rounded border border-gray-300 bg-gray-50 p-2 text-xs text-gray-800">
          Votre rôle ne compte que les jeux autorisés et les dossiers de conflit dont tous les jeux sont autorisés ; les pièces en cours d&apos;examen et les référents ne vous sont pas communiqués.
        </p>
      )}
      <Synthese a={t.total} l={t.lisibilite} />
      <TableJeux a={t.total} l={t.lisibilite} />
      <TableConflits a={t.total} l={t.lisibilite} />
      <TableRepartition t={t} />
      {t.tronque && <p role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">Liste tronquée : seules les 500 premières subdivisions sont détaillées ; les totaux, eux, comptent tout.</p>}
    </section>
  );
}

function Tuile({ libelle, valeur, aide, testid }: { libelle: string; valeur: string; aide?: string; testid: string }) {
  const nc = valeur === NON_COMMUNIQUE;
  return (
    <div data-testid={testid} className="rounded-md border border-gray-200 bg-white p-3 shadow-sm">
      <dt className="text-xs font-medium text-gray-700">{libelle}</dt>
      <dd className={nc ? "mt-1 text-sm font-medium italic text-gray-700" : "mt-1 text-2xl font-bold tabular-nums text-navy"}>{valeur}</dd>
      {aide && <dd className="mt-0.5 text-xs text-gray-700">{aide}</dd>}
    </div>
  );
}

function Synthese({ a, l }: { a: Agregat; l: Lisibilite }) {
  const dm = a.documentsManquants;
  return (
    <dl aria-label="Synthèse" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Tuile testid="tuile-projets" libelle="Projets" valeur={valeurAgregat(a.projets)} />
      <Tuile testid="tuile-types-manquants" libelle="Types de document obligatoires non fournis" valeur={valeurAgregat(dm.typesObligatoiresNonFournis)} aide={`Projets incomplets : ${valeurAgregat(dm.projetsIncomplets)}`} />
      <Tuile testid="tuile-pieces-attente" libelle="Pièces en attente" valeur={l.documentsEnCours ? valeurAgregat(dm.piecesEnAttente) : NON_COMMUNIQUE}
        aide={l.documentsEnCours && dm.piecesEnAttenteParStatut ? Object.entries(dm.piecesEnAttenteParStatut).filter(([, n]) => n > 0).map(([s, n]) => `${estStatutDocument(s) ? LIBELLE_STATUT_DOCUMENT[s] : s} ${n}`).join(", ") || undefined : undefined} />
      <Tuile testid="tuile-referents" libelle="Référents actifs" valeur={l.referents && a.referentsActifs ? valeurAgregat(a.referentsActifs.comptes) : NON_COMMUNIQUE}
        aide={l.referents && a.referentsActifs ? `Rattachements : ${valeurAgregat(a.referentsActifs.rattachements)}` : undefined} />
    </dl>
  );
}

function TableJeux({ a, l }: { a: Agregat; l: Lisibilite }) {
  const lignes = jeuxParStatut(a, l);
  return (
    <div role="region" aria-label="Jeux de données par statut, tableau défilant" tabIndex={0} className="overflow-x-auto rounded-md border border-gray-200 bg-white">
      <table className="w-full min-w-[320px] border-collapse text-left text-sm">
        <caption className="px-3 py-2 text-left text-sm font-semibold text-gray-900">Jeux de données par statut</caption>
        <thead className="bg-gray-100 text-gray-800"><tr><th scope="col" className="px-3 py-1.5 font-semibold">Statut</th><th scope="col" className="px-3 py-1.5 text-right font-semibold">Jeux</th></tr></thead>
        <tbody>
          {lignes.map((x) => (
            <tr key={x.statut} className="border-t border-gray-200"><th scope="row" className="px-3 py-1.5 text-left font-normal">{libelleStatutJeu(x.statut)}</th><td className={`px-3 py-1.5 text-right ${x.n === null ? "italic text-gray-700" : "tabular-nums"}`}>{valeurAgregat(x.n)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableConflits({ a, l }: { a: Agregat; l: Lisibilite }) {
  const autres = Object.keys(a.conflits).filter((s) => !(STATUTS_CONFLIT as readonly string[]).includes(s));
  return (
    <div role="region" aria-label="Dossiers de conflit par statut, tableau défilant" tabIndex={0} className="overflow-x-auto rounded-md border border-gray-200 bg-white">
      <table className="w-full min-w-[320px] border-collapse text-left text-sm">
        <caption className="px-3 py-2 text-left text-sm font-semibold text-gray-900">
          Dossiers de conflit par statut{l.conflits === "DOSSIERS_VISIBLES" ? " (dossiers visibles de votre compte)" : ""}
        </caption>
        <thead className="bg-gray-100 text-gray-800"><tr><th scope="col" className="px-3 py-1.5 font-semibold">Statut</th><th scope="col" className="px-3 py-1.5 text-right font-semibold">Dossiers</th></tr></thead>
        <tbody>
          {[...STATUTS_CONFLIT, ...autres].map((s) => (
            <tr key={s} className="border-t border-gray-200"><th scope="row" className="px-3 py-1.5 text-left font-normal">{libelleStatutConflit(s)}</th><td className="px-3 py-1.5 text-right tabular-nums">{valeurAgregat(a.conflits[s] ?? 0)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableRepartition({ t }: { t: TableauDeBord }) {
  const l = t.lisibilite;
  const lignes = [
    ...t.lignes.map((x) => ({ cle: x.cle, libelle: `${x.libelle}${x.niveau ? ` (${LIBELLE_NIVEAU[x.niveau as NiveauTerritoire] ?? x.niveau})` : ""}`, a: x.agregat })),
    ...(t.rattachesDirectement && (t.rattachesDirectement.projets ?? 0) > 0 ? [{ cle: "directs", libelle: "Rattachés directement au territoire", a: t.rattachesDirectement }] : []),
    ...(t.nonVentiles && (t.nonVentiles.projets ?? 0) > 0 ? [{ cle: "non-ventiles", libelle: "Sous des subdivisions hors de votre périmètre (non ventilés)", a: t.nonVentiles }] : []),
  ];
  if (lignes.length === 0) return <p className="text-sm text-gray-700">{t.portee === "NATIONAL" ? "Aucun projet dans votre périmètre." : "Aucune subdivision de ce territoire ne porte de projet."}</p>;
  const somme = (o: Record<string, number>) => Object.entries(o).filter(([s]) => s !== "RETIRE").reduce((n, [, v]) => n + v, 0);
  return (
    <div role="region" aria-label="Répartition, tableau défilant" tabIndex={0} className="overflow-x-auto rounded-md border border-gray-200 bg-white">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <caption className="px-3 py-2 text-left text-sm font-semibold text-gray-900">{t.portee === "NATIONAL" ? "Répartition par région" : "Répartition par subdivision"}</caption>
        <thead className="bg-gray-100 text-gray-800">
          <tr>
            <th scope="col" className="px-3 py-1.5 font-semibold">{t.portee === "NATIONAL" ? "Région" : "Subdivision"}</th>
            <th scope="col" className="px-3 py-1.5 text-right font-semibold">Projets</th>
            <th scope="col" className="px-3 py-1.5 text-right font-semibold">{l.jeux === "AUTORISE_SEULEMENT" ? "Jeux autorisés" : "Jeux"}</th>
            <th scope="col" className="px-3 py-1.5 text-right font-semibold">Dossiers de conflit</th>
            <th scope="col" className="px-3 py-1.5 text-right font-semibold">Types obligatoires non fournis</th>
            <th scope="col" className="px-3 py-1.5 text-right font-semibold">Pièces en attente</th>
            <th scope="col" className="px-3 py-1.5 text-right font-semibold">Référents actifs</th>
          </tr>
        </thead>
        <tbody>
          {lignes.map((x) => (
            <tr key={x.cle} className="border-t border-gray-200">
              <th scope="row" className="px-3 py-1.5 text-left font-normal">{x.libelle}</th>
              <td className="px-3 py-1.5 text-right tabular-nums">{valeurAgregat(x.a.projets)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{valeurAgregat(somme(x.a.jeux))}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{valeurAgregat(somme(x.a.conflits))}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{valeurAgregat(x.a.documentsManquants.typesObligatoiresNonFournis)}</td>
              <td className={`px-3 py-1.5 text-right ${l.documentsEnCours ? "tabular-nums" : "italic text-gray-700"}`}>{l.documentsEnCours ? valeurAgregat(x.a.documentsManquants.piecesEnAttente) : NON_COMMUNIQUE}</td>
              <td className={`px-3 py-1.5 text-right ${l.referents ? "tabular-nums" : "italic text-gray-700"}`}>{l.referents ? valeurAgregat(x.a.referentsActifs?.comptes ?? null) : NON_COMMUNIQUE}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
