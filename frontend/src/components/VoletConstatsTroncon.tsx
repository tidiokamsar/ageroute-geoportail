import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { messageErreur } from "../lib/exploitation";
import { LIBELLE_STATUT_CONSTAT, libelleGravite, type VoletConstats } from "../lib/historiqueSection";

/**
 * Fiche tronçon, onglet « Constats terrain » : l'HISTOIRE de la section vue du terrain (défauts et observations rattachés).
 *
 * Ce que l'écran dit, et qui ne va pas de soi :
 *   - « confirmés » (validés par un tiers) et « proposés » (pas encore tranchés) sont comptés à part : une proposition n'est pas un fait ;
 *   - une RÉCURRENCE = le même type constaté à au moins deux jours distincts ;
 *   - un constat rejeté est écarté (et compté comme écarté) ;
 *   - une observation prise en roulant n'apparaît qu'une fois RATTACHÉE à ce tronçon par un responsable ;
 *   - ce n'est ni un indice d'état ni une décision d'intervention.
 */
export function VoletConstatsTroncon({ tronconId }: { tronconId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["fiche360", "constats", tronconId],
    queryFn: async () => (await api.get<VoletConstats>(`/v2/fiche-360/troncons/${tronconId}/constats`)).data,
    retry: false,
  });

  if (isLoading) return <p role="status" className="text-sm text-gray-600">Chargement des constats…</p>;
  if (error || !data) return <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">Les constats n'ont pas pu être chargés. {messageErreur(error, "Réessayez dans un instant.")}</p>;
  const h = data.historique;

  return (
    <div className="space-y-4">
      {data.avertissements.map((a) => <p key={a} role="status" className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{a}</p>)}

      {h.total === 0 ? (
        <p className="text-sm text-gray-700">Aucun constat de terrain rattaché à ce tronçon{h.rejetesEcartes > 0 ? ` (${h.rejetesEcartes} rejeté(s) écarté(s))` : ""}. Cela ne veut pas dire que la route est en bon état : personne ne l'a relevée, ou ses relevés ne sont pas rattachés.</p>
      ) : (
        <>
          <dl aria-label="Résumé des constats" className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div className="rounded border border-gray-200 p-2"><dt className="text-xs text-gray-600">Constats retenus</dt><dd className="text-lg font-semibold">{h.total}</dd></div>
            <div className="rounded border border-gray-200 p-2"><dt className="text-xs text-gray-600">Confirmés</dt><dd className="text-lg font-semibold">{h.confirmes}</dd></div>
            <div className="rounded border border-gray-200 p-2"><dt className="text-xs text-gray-600">Proposés, à trancher</dt><dd className="text-lg font-semibold">{h.proposes}</dd></div>
            <div className="rounded border border-gray-200 p-2"><dt className="text-xs text-gray-600">Défauts · observations</dt><dd className="text-lg font-semibold">{h.defauts} · {h.observations}</dd></div>
          </dl>
          <p className="text-xs text-gray-600">Du {h.premierConstat} au {h.dernierConstat}{h.rejetesEcartes > 0 ? ` · ${h.rejetesEcartes} constat(s) rejeté(s) écarté(s)` : ""}.</p>

          <section aria-labelledby="recurrences">
            <h3 id="recurrences" className="text-sm font-semibold">Ce qui revient</h3>
            {h.recurrents.length === 0
              ? <p className="text-sm text-gray-700">Aucun type de constat vu à deux dates différentes.</p>
              : (
                <ul className="mt-1 space-y-1 text-sm">
                  {h.recurrents.map((r) => (
                    <li key={r.cle}>
                      <strong>{r.libelle}</strong> ({r.nature === "DEFAUT" ? "défaut" : "observation"}) : constaté à {r.nbDates} dates, du {r.premiereFois} au {r.derniereFois}, {r.nbConstats} constat(s).
                    </li>
                  ))}
                </ul>
              )}
          </section>

          <section aria-labelledby="par-jour">
            <h3 id="par-jour" className="text-sm font-semibold">Par jour de constat</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Constats de terrain de ce tronçon, regroupés par jour</caption>
                <thead className="text-xs uppercase text-gray-600">
                  <tr><th scope="col" className="py-1 pr-3">Jour</th><th scope="col" className="pr-3">Défauts</th><th scope="col" className="pr-3">Observations</th><th scope="col" className="pr-3">Graves</th><th scope="col" className="pr-3">Confirmés</th><th scope="col">Proposés</th></tr>
                </thead>
                <tbody>
                  {[...h.parJour].reverse().map((j) => (
                    <tr key={j.date} className="border-t"><td className="py-1 pr-3">{j.date}</td><td className="pr-3">{j.defauts}</td><td className="pr-3">{j.observations}</td><td className="pr-3">{j.graves}</td><td className="pr-3">{j.confirmes}</td><td>{j.proposes}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="liste-constats">
            <h3 id="liste-constats" className="text-sm font-semibold">Constats récents</h3>
            <ul className="mt-1 divide-y text-sm">
              {data.liste.map((c) => (
                <li key={`${c.nature}-${c.id}`} className="py-1">
                  <span className="font-medium">{c.libelle}</span> ({c.nature === "DEFAUT" ? "défaut" : "observation"}) · {c.constateA.slice(0, 10)} · gravité {libelleGravite(c.gravite, c.nature)}{c.grave ? " (grave)" : ""} · {LIBELLE_STATUT_CONSTAT[c.statut] ?? c.statut}{c.etatDefaut && c.etatDefaut !== "ACTIF" ? ` · ${c.etatDefaut === "TRAITE" ? "traité" : "disparu"}` : ""}
                </li>
              ))}
            </ul>
            {data.listeTronquee && <p className="text-xs text-gray-600">Seuls les {data.plafondListe} constats les plus récents sont listés ; les comptes ci-dessus portent sur tous.</p>}
          </section>
        </>
      )}
    </div>
  );
}
