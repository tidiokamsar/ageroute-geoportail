import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { messageErreur } from "../lib/exploitation";
import { Button } from "./ui/Button";
import {
  LIBELLE_GROUPE, aTraiter, etatAffichage, formaterValeur, perimetresDistincts, resumeControle, texteIndicateur, textePortee,
  type Groupe, type IndicateurEvalue, type RapportControle, type ReponseIndicateurs, type ResultatControle,
} from "../lib/tableauDeBord";

/**
 * Indicateurs du tableau de bord executif (paragraphe 7.12), avec leur PERIMETRE et, pour qui gere la
 * donnee, le rapprochement de chaque chiffre avec sa requete de controle (A12).
 *
 * CE QUE CE BLOC DIT, ET QUI NE VA PAS DE SOI
 *
 * **Chaque chiffre porte son perimetre.** « Réseau classé saisi » n'est jamais appelé « réseau national ».
 * **Un compte regional ne lit que ses regions** ; un indicateur sans ventilation regionale lui est refuse,
 * et l'ecran le dit au lieu de montrer le national a la place.
 * **Le rapprochement n'est pas automatique** : il relance chaque requete deux fois. Il est demande.
 */

const GROUPES_TABLEAU: readonly Groupe[] = ["reseau", "portions", "qualite"];

function Badge({ r }: { r: ResultatControle | undefined }) {
  if (!r) return null;
  if (r.statut === "EGAL") return <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800">Égal à sa requête de contrôle</span>;
  if (r.statut === "ECART") {
    return (
      <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800">
        Écart : calcul {formaterValeur(r.calcul, r.unite)}, contrôle {formaterValeur(r.controle, r.unite)}
      </span>
    );
  }
  if (r.statut === "ERREUR") return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">Rapprochement en erreur</span>;
  return null;
}

export function IndicateursControles() {
  const { user } = useAuth();
  const peutControler = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["tdb", "indicateurs"],
    queryFn: async () => (await api.get<ReponseIndicateurs>("/v2/tableau-de-bord/indicateurs")).data,
    retry: false,
  });
  const controle = useMutation({
    mutationFn: async () => (await api.get<RapportControle>("/v2/tableau-de-bord/controle")).data,
  });

  if (isLoading) return <p role="status" className="text-sm text-gray-500">Chargement des indicateurs…</p>;
  if (isError || !data) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
        Les indicateurs contrôlés n'ont pas pu être chargés. {messageErreur(error, "Réessayez dans un instant.")}
      </div>
    );
  }

  const parCode = new Map((controle.data?.resultats ?? []).map((r) => [r.code, r]));

  return (
    <section aria-labelledby="titre-indicateurs" className="space-y-4" data-testid="indicateurs-controles">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="titre-indicateurs" className="text-sm font-semibold text-gray-500 uppercase tracking-widest">Indicateurs et périmètres</h2>
          <p className="mt-1 text-xs text-gray-600">
            Chaque chiffre est calculé par une requête et dit sur quoi il porte. {textePortee(data.portee)}
          </p>
        </div>
        {peutControler && (
          <Button variant="secondary" onClick={() => controle.mutate()} disabled={controle.isPending}>
            {controle.isPending ? "Rapprochement en cours…" : "Rapprocher des requêtes de contrôle"}
          </Button>
        )}
      </div>

      {controle.isError && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          Le rapprochement a échoué. {messageErreur(controle.error, "Réessayez dans un instant.")}
        </p>
      )}
      {controle.data && (
        <p role="status" className={`rounded border px-3 py-2 text-sm ${controle.data.ecarts + controle.data.erreurs > 0 ? "border-red-200 bg-red-50 text-red-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
          {resumeControle(controle.data)}
        </p>
      )}

      {data.indicateurs.length === 0 ? (
        <p className="text-sm text-gray-500">Aucun indicateur à afficher.</p>
      ) : (
        GROUPES_TABLEAU.map((g) => {
          const lignes = data.indicateurs.filter((i) => i.groupe === g);
          if (lignes.length === 0) return null;
          return (
            <div key={g}>
              <h3 className="mb-2 text-sm font-semibold text-gray-700">{LIBELLE_GROUPE[g]}</h3>
              <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {lignes.map((i) => <Ligne key={i.code} i={i} r={parCode.get(i.code)} />)}
              </ul>
            </div>
          );
        })
      )}

      <details className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
        <summary className="cursor-pointer font-medium text-gray-700">Définition des périmètres</summary>
        <dl className="mt-2 space-y-2">
          {perimetresDistincts(data.indicateurs).map((p) => (
            <div key={p.code}>
              <dt className="font-medium text-gray-800">{p.libelle}</dt>
              <dd className="text-gray-600">{p.definition}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

function Ligne({ i, r }: { i: IndicateurEvalue; r: ResultatControle | undefined }) {
  const etat = etatAffichage(i);
  const grise = etat !== "valeur";
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-600">{i.libelle}</p>
      <p className={`mt-1 ${grise ? "text-sm text-gray-600" : "text-2xl font-semibold text-navy"}`}>{texteIndicateur(i)}</p>
      {i.motif && etat !== "valeur" && <p className="mt-1 text-xs text-gray-600">{i.motif}</p>}
      <p className="mt-1 text-xs text-gray-600">Périmètre : {i.perimetre.libelle}</p>
      {aTraiter(i) && <p className="mt-1 text-xs font-medium text-red-700">À traiter</p>}
      <div className="mt-1"><Badge r={r} /></div>
    </li>
  );
}
