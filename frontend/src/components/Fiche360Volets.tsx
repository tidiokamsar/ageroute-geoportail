import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { messageErreur } from "../lib/exploitation";
import { aujourdhui, avertissements, etiquetteJour, jourValide, resume, type ReponseCurseur } from "../lib/curseur";
import {
  LIBELLE_STATUT_PREVISION, LIBELLE_STATUT_VALIDATION, emprise, formaterValeur, jourFr,
  type VersionPortion, type VoletPortions as Portions, type VoletProgrammation as Programmation,
} from "../lib/tableauDeBord";

/**
 * Fiche 360 : les volets PORTION et PROGRAMMATION, qui s'ajoutent a la fiche tronçon existante.
 *
 * CE QUE CES VOLETS DISENT, ET QUI NE VA PAS DE SOI
 *
 * **Une date d'effet absente reste absente.** « Non renseignée » n'est pas « depuis toujours ».
 * **L'etat a une date vient du curseur temporel**, la seule definition de « vrai a cette date » : le volet
 * l'appelle, il ne la recalcule pas. Il ne montre pas l'avenir (la date est bornee a aujourd'hui).
 * **Les interventions figees n'existent pas encore** (aucune table) : le volet le dit, il n'en invente aucune.
 * **Hors perimetre, rien n'est montre** : le serveur refuse (403) et l'ecran affiche ce refus.
 */

function Chargement({ quoi }: { quoi: string }) {
  return <p role="status" className="text-sm text-gray-600">Chargement {quoi}…</p>;
}
function Erreur({ error, quoi }: { error: unknown; quoi: string }) {
  return <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">{quoi} n'a pas pu être chargé. {messageErreur(error, "Réessayez dans un instant.")}</p>;
}

function LigneVersion({ v, historique }: { v: VersionPortion; historique: boolean }) {
  return (
    <tr className="border-t align-top">
      <td className="py-1 pr-2">{emprise(v.debutM, v.finM)}</td>
      <td className="pr-2">{v.etatLibelle ?? <span className="text-gray-600">non qualifié</span>}</td>
      <td className="pr-2">{LIBELLE_STATUT_VALIDATION[v.statutValidation] ?? v.statutValidation}</td>
      <td className="pr-2">
        {v.valideDu ? `depuis le ${jourFr(v.valideDu)}` : <span className="text-amber-800">date d'effet non renseignée</span>}
        {v.valideAu ? ` jusqu'au ${jourFr(v.valideAu)}` : ""}
      </td>
      <td className="pr-2">{jourFr(v.enregistreLe)}</td>
      {historique && (
        <td>
          {v.remplaceeLe ? `Remplacée le ${jourFr(v.remplaceeLe)}` : "Courante"}
          {v.issueDe.length > 0 ? ` · issue de ${v.issueDe.length} version${v.issueDe.length > 1 ? "s" : ""}` : ""}
        </td>
      )}
    </tr>
  );
}

function TableVersions({ lignes, historique, legende }: { lignes: VersionPortion[]; historique: boolean; legende: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{legende}</caption>
        <thead className="text-xs uppercase text-gray-600">
          <tr>
            <th scope="col" className="py-1 pr-2">Emprise</th><th scope="col" className="pr-2">État</th>
            <th scope="col" className="pr-2">Statut</th><th scope="col" className="pr-2">Vrai sur le terrain</th>
            <th scope="col" className="pr-2">Enregistrée le</th>{historique && <th scope="col">Cycle de vie</th>}
          </tr>
        </thead>
        <tbody>{lignes.map((v) => <LigneVersion key={v.id} v={v} historique={historique} />)}</tbody>
      </table>
    </div>
  );
}

/** « État à une date » : le curseur temporel existant, restreint a ce tronçon. */
function EtatALaDate({ tronconId }: { tronconId: string }) {
  const idDate = useId();
  const idProp = useId();
  const auj = aujourdhui();
  const [date, setDate] = useState("");
  const [propositions, setPropositions] = useState(false);
  const valide = jourValide(date) && date <= auj;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["fiche360", "a-la-date", tronconId, date, propositions],
    enabled: valide,
    retry: false,
    queryFn: async () => (await api.get<ReponseCurseur>("/v2/portions/a-la-date", {
      params: { tronconId, date, inclureAValider: propositions ? "true" : "false" },
    })).data,
  });

  return (
    <section aria-labelledby={`${idDate}-t`} className="space-y-2">
      <h3 id={`${idDate}-t`} className="text-xs font-semibold uppercase text-gray-600">État à une date</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={idDate} className="block text-xs text-gray-700">Jour de terrain</label>
          <input id={idDate} type="date" max={auj} value={date} onChange={(e) => setDate(e.target.value)} className="rounded border px-2 py-1 text-sm" />
        </div>
        <div className="flex items-center gap-2">
          <input id={idProp} type="checkbox" checked={propositions} onChange={(e) => setPropositions(e.target.checked)} />
          <label htmlFor={idProp} className="text-xs text-gray-700">Inclure les propositions non validées</label>
        </div>
      </div>
      {!valide && <p className="text-xs text-gray-600">Choisissez un jour (jusqu'à aujourd'hui) : l'écran montre ce qui était vrai ce jour-là, jamais l'avenir.</p>}
      {valide && isLoading && <Chargement quoi="de l'état à cette date" />}
      {valide && isError && <Erreur error={error} quoi="L'état à cette date" />}
      {valide && data && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-gray-800">{resume(data)}</p>
          {avertissements(null, data).map((a) => <p key={a} className="text-xs text-amber-800">{a}</p>)}
          {data.portions.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">{`Portions vraies le ${etiquetteJour(data.dateTerrain)}`}</caption>
                <thead className="text-xs uppercase text-gray-600">
                  <tr><th scope="col" className="py-1 pr-2">Emprise</th><th scope="col" className="pr-2">État</th><th scope="col" className="pr-2">Statut ce jour-là</th><th scope="col">Vrai sur le terrain</th></tr>
                </thead>
                <tbody>
                  {data.portions.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="py-1 pr-2">{emprise(p.debutM, p.finM)}</td>
                      <td className="pr-2">{p.etatLibelle ?? <span className="text-gray-600">non qualifié</span>}</td>
                      <td className="pr-2">{LIBELLE_STATUT_VALIDATION[p.statut] ?? p.statut}{p.ambigue ? " (recouvre une autre)" : ""}</td>
                      <td>{p.valideDu ? `depuis le ${jourFr(p.valideDu)}` : "date d'effet non renseignée"}{p.valideAu ? ` jusqu'au ${jourFr(p.valideAu)}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function VoletPortions({ tronconId }: { tronconId: string }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["fiche360", "portions", tronconId],
    queryFn: async () => (await api.get<Portions>(`/v2/fiche-360/troncons/${tronconId}/portions`)).data,
    retry: false,
  });

  if (isLoading) return <Chargement quoi="du volet portions" />;
  if (isError || !data) return <Erreur error={error} quoi="Le volet portions" />;

  return (
    <div className="space-y-4" data-testid="volet-portions">
      <section aria-labelledby="vp-courantes" className="space-y-1">
        <h3 id="vp-courantes" className="text-xs font-semibold uppercase text-gray-600">Version courante ({data.comptes.courantes})</h3>
        {data.courantes.length === 0 ? (
          <p className="text-sm text-gray-700">Aucune portion courante : ce tronçon n'a jamais été inventorié. Il n'hérite pas de l'état porté par sa fiche, qui est une valeur déclarée.</p>
        ) : (
          <TableVersions lignes={data.courantes} historique={false} legende="Portions courantes du tronçon" />
        )}
      </section>

      <section aria-labelledby="vp-historique" className="space-y-1">
        <h3 id="vp-historique" className="text-xs font-semibold uppercase text-gray-600">
          Historique des versions ({data.historique.length}, dont {data.comptes.remplacees} remplacée{data.comptes.remplacees > 1 ? "s" : ""})
        </h3>
        {data.historique.length === 0 ? (
          <p className="text-sm text-gray-700">Aucune version enregistrée.</p>
        ) : (
          <TableVersions lignes={data.historique} historique legende="Toutes les versions de portions du tronçon" />
        )}
        {data.tronque && <p className="text-xs text-amber-800">Historique tronqué à {data.plafond.toLocaleString("fr-FR")} versions.</p>}
        {data.comptes.sansDateEffet > 0 && (
          <p className="text-xs text-amber-800">
            {data.comptes.sansDateEffet} version{data.comptes.sansDateEffet > 1 ? "s" : ""} sans date d'effet : {data.comptes.sansDateEffet > 1 ? "elles ne sont placées" : "elle n'est placée"} à aucune date par le curseur temporel.
          </p>
        )}
      </section>

      <EtatALaDate tronconId={tronconId} />
    </div>
  );
}

export function VoletProgrammation({ tronconId }: { tronconId: string }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["fiche360", "programmation", tronconId],
    queryFn: async () => (await api.get<Programmation>(`/v2/fiche-360/troncons/${tronconId}/programmation`)).data,
    retry: false,
  });

  if (isLoading) return <Chargement quoi="du volet programmation" />;
  if (isError || !data) return <Erreur error={error} quoi="Le volet programmation" />;

  return (
    <div className="space-y-4" data-testid="volet-programmation">
      <section aria-labelledby="vg-previsions" className="space-y-1">
        <h3 id="vg-previsions" className="text-xs font-semibold uppercase text-gray-600">Prévisions budgétaires saisies ({data.previsions.length})</h3>
        {data.previsions.length === 0 ? (
          <p className="text-sm text-gray-700">Aucune prévision n'est saisie pour ce tronçon. Ce n'est pas un budget nul : rien n'a été programmé dans cette base.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Prévisions budgétaires du tronçon</caption>
                <thead className="text-xs uppercase text-gray-600">
                  <tr><th scope="col" className="py-1 pr-2">Année</th><th scope="col" className="pr-2">Intitulé</th><th scope="col" className="pr-2">Statut</th><th scope="col" className="pr-2">Bailleur</th><th scope="col">Montant</th></tr>
                </thead>
                <tbody>
                  {data.previsions.map((p) => (
                    <tr key={p.id} className="border-t align-top">
                      <td className="py-1 pr-2">{p.annee}</td>
                      <td className="pr-2">{p.intitule}{p.typeIntervention ? ` (${p.typeIntervention})` : ""}</td>
                      <td className="pr-2">{LIBELLE_STATUT_PREVISION[p.statut] ?? p.statut}</td>
                      <td className="pr-2">{p.bailleur ?? <span className="text-gray-600">non renseigné</span>}</td>
                      <td>{formaterValeur(p.montantPrevuGnf, "GNF")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="text-xs text-gray-700">
              {data.totaux.map((t) => (
                <li key={t.statut}>{LIBELLE_STATUT_PREVISION[t.statut] ?? t.statut} : {t.nb} ligne{t.nb > 1 ? "s" : ""}, {formaterValeur(t.montantGnf, "GNF")}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="vg-chantiers" className="space-y-1">
        <h3 id="vg-chantiers" className="text-xs font-semibold uppercase text-gray-600">Chantiers du tronçon ({data.chantiers.length})</h3>
        {data.chantiers.length === 0 ? (
          <p className="text-sm text-gray-700">Aucun chantier rattaché à ce tronçon.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.chantiers.map((c) => (
              <li key={c.id}>
                {c.intitule} : {c.statut} ({c.avancementPct} %) · {c.entreprise}
                {c.montantGnf !== null ? ` · ${formaterValeur(c.montantGnf, "GNF")}` : " · montant non renseigné"}
                {c.dateFinPrevue ? ` · fin prévue le ${jourFr(c.dateFinPrevue)}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="rounded border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900">
        <strong>Interventions figées : aucune donnée.</strong> {data.interventionsFigees.motif}
      </p>
    </div>
  );
}
