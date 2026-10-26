import { AlertTriangle } from "lucide-react";
import { CompteursLot, LIBELLE_STATUT_LIGNE, classePastilleLigne, nombre, rendreVisible } from "./CompteursLot";
import type { ControleLot, StatutLot } from "./types";

/**
 * Résultat du contrôle du schéma d'un lot : motif de rejet, compteurs, colonnes, premiers rejets,
 * avertissements.
 *
 * TROIS RÈGLES DE FOND
 *
 * 1. Un lot REJETÉ montre son motif EN ÉVIDENCE, avant les chiffres : c'est la réponse à « pourquoi ? ».
 * 2. Un lot « schéma validé » n'est jamais présenté comme appliqué : l'encart dit que rien n'a été créé.
 *    Il est ambre (en attente), jamais vert.
 * 3. `colonnes` à `null` veut dire NON CALCULABLE. On l'écrit ; on ne montre jamais deux listes vides
 *    (« aucune colonne inconnue » serait alors une information fausse).
 */

function ListeColonnes({ titre, valeurs }: { titre: string; valeurs: string[] }) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-xs font-semibold text-slate-800">{titre} ({nombre(valeurs.length)})</h4>
      {valeurs.length === 0 ? (
        <p className="text-sm text-slate-700">Aucune.</p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {valeurs.map((c, i) => (
            <li key={`${c}-${i}`} className="break-all rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-900">
              {rendreVisible(c)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Nombre de lignes mises à l'écart que le fichier d'erreurs contient et que le tableau ne montre pas. */
export function nombreAutresRejets(controle: ControleLot): number {
  const { rejetees, ignorees } = controle.compteurs;
  if (![rejetees, ignorees].every((n) => typeof n === "number" && Number.isFinite(n))) return 0;
  // Le fichier d'erreurs porte les lignes rejetées ET ignorées (route erreurs.csv).
  return Math.max(0, rejetees + ignorees - controle.premiersRejets.length);
}

export function RapportControle({ controle, statut, idTitre }: { controle: ControleLot; statut: StatutLot; idTitre?: string }) {
  const rejete = statut === "REJETE" || Boolean(controle.motifRejetLot);
  const autres = nombreAutresRejets(controle);
  const { rejetees, ignorees } = controle.compteurs;
  const lignesMisesDeCote = (Number.isFinite(rejetees) ? rejetees : 0) + (Number.isFinite(ignorees) ? ignorees : 0);

  return (
    <div className="space-y-4">
      <h3 id={idTitre} className="text-sm font-semibold text-slate-900">Résultat du contrôle du schéma</h3>

      {rejete && (
        <p className="rounded border-l-4 border-red-700 bg-red-50 p-3 text-sm text-red-900">
          <strong>Lot rejeté :</strong>{" "}
          {controle.motifRejetLot ? rendreVisible(controle.motifRejetLot) : "le serveur n'a pas fourni de motif pour ce rejet."}
        </p>
      )}

      {statut === "VALIDE_SCHEMA" && (
        <p className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {nombre(controle.compteurs.validees)} ligne(s) conformes au contrat, <strong>en attente d'application</strong>. Aucun objet n'a été créé.
          </span>
        </p>
      )}

      <CompteursLot compteurs={controle.compteurs} />

      <div>
        <h4 className="mb-1 text-xs font-semibold text-slate-800">Colonnes du fichier</h4>
        {controle.colonnes === null ? (
          <p className="text-sm text-slate-700">Colonnes reconnues et inconnues : non calculable pour ce lot.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <ListeColonnes titre="Colonnes reconnues" valeurs={controle.colonnes.reconnues} />
            <ListeColonnes titre="Colonnes inconnues" valeurs={controle.colonnes.inconnues} />
          </div>
        )}
      </div>

      <div>
        <h4 className="mb-1 text-xs font-semibold text-slate-800">Erreurs bloquantes et mises à l'écart</h4>
        {controle.premiersRejets.length === 0 ? (
          <p className="text-sm text-slate-700">
            {lignesMisesDeCote > 0
              ? `${nombre(lignesMisesDeCote)} ligne(s) rejetée(s) ou ignorée(s) : le détail est dans le fichier d'erreurs.`
              : "Aucune ligne rejetée ni ignorée."}
          </p>
        ) : (
          <>
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[20rem] border-collapse text-left text-sm">
                <caption className="sr-only">Premiers rejets du lot : ligne, statut, motif</caption>
                <thead>
                  <tr className="border-b border-slate-300 text-xs text-slate-800">
                    <th scope="col" className="px-2 py-1 font-semibold">Ligne</th>
                    <th scope="col" className="px-2 py-1 font-semibold">Statut</th>
                    <th scope="col" className="px-2 py-1 font-semibold">Motif</th>
                  </tr>
                </thead>
                <tbody>
                  {controle.premiersRejets.map((r) => (
                    <tr key={`${r.numeroLigne}-${r.statut}`} className="border-b border-slate-100 align-top">
                      <th scope="row" className="px-2 py-1 font-mono text-xs font-normal">{r.numeroLigne}</th>
                      <td className="px-2 py-1">
                        <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-medium ${classePastilleLigne(r.statut)}`}>
                          {LIBELLE_STATUT_LIGNE[r.statut] ?? rendreVisible(r.statut)}
                        </span>
                      </td>
                      <td className="break-words px-2 py-1">{r.motif ? rendreVisible(r.motif) : "Motif non fourni"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {autres > 0 && (
              <p className="mt-1 text-sm text-slate-700">{nombre(autres)} {autres > 1 ? "autres" : "autre"} dans le fichier d'erreurs.</p>
            )}
          </>
        )}
      </div>

      <div>
        <h4 className="mb-1 text-xs font-semibold text-slate-800">Avertissements</h4>
        {controle.avertissements.length === 0 ? (
          <p className="text-sm text-slate-700">Aucun avertissement.</p>
        ) : (
          <ul className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
            {controle.avertissements.map((a, i) => (
              <li key={`${a}-${i}`} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="break-words">{rendreVisible(a)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
