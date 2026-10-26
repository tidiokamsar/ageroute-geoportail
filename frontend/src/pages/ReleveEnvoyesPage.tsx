import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MapPin, RotateCcw } from "lucide-react";
import { useAuth } from "../lib/auth";
import { FILTRES_VIDES, useReleveEnvoyes, type AgentReleve } from "../lib/roulageEnvoyes";
import {
  classerErreur, fusionnerAgents, libelleDateHeure, libelleDistance, libelleDureeReleve, libelleNombre, libelleTaux, libelleTotal,
  messageErreur, peutReessayer, periodeVersParametres, suiteNomLienReleve, voitPlusieursAgents,
} from "../lib/roulageEnvoyesVue";
import { Button } from "../components/ui/Button";

/**
 * Releves envoyes : la liste des releves en roulant que le serveur a recus.
 *
 * POURQUOI CET ECRAN EXISTE. Le serveur enregistrait deja chaque session envoyee, mais rien ne la relisait : l'agent qui
 * avait appuye sur « Envoyer la session au serveur » ne la voyait nulle part, et ne pouvait pas savoir si l'envoi avait
 * servi a quelque chose. Cet ecran la montre, et son detail (trace, reperes, segments) est a un lien de la.
 *
 * CE QUE L'ECRAN GARANTIT
 *   - un ECHEC DE CHARGEMENT n'est jamais presente comme « aucun releve » : il a son propre message (`role="alert"`) et,
 *     quand cela a un sens, un bouton « Reessayer » ;
 *   - un vide dit la verite : un releve enregistre mais PAS ENCORE ENVOYE reste sur le telephone et n'apparait pas ici ;
 *   - un taux de rattachement non evalue se lit « non evalue », jamais « 0 % » ;
 *   - la colonne et le filtre « agent » n'existent que pour les roles qui voient plusieurs agents.
 */

const CHAMP = "mt-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm";
const TH = "px-2 py-2 text-left text-xs font-semibold text-gray-700";
const TD = "px-2 py-2 align-top text-sm whitespace-nowrap";

export function ReleveEnvoyesPage() {
  const { user } = useAuth();
  const multi = voitPlusieursAgents(user?.role);
  const [filtres, setFiltres] = useState(FILTRES_VIDES);
  const [appliquee, setAppliquee] = useState<{ depuis: string | null; jusqua: string | null }>({ depuis: null, jusqua: null });
  const [agentsConnus, setAgentsConnus] = useState<AgentReleve[]>([]);

  // Une saisie incoherente (debut apres la fin) n'est pas envoyee : la derniere periode valide reste appliquee et l'ecran dit pourquoi.
  const periode = useMemo(() => periodeVersParametres(filtres.depuis, filtres.jusqua), [filtres.depuis, filtres.jusqua]);
  useEffect(() => {
    if (!periode.erreur) setAppliquee({ depuis: periode.depuis, jusqua: periode.jusqua });
  }, [periode]);

  const q = useReleveEnvoyes(appliquee, filtres.userId);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const total = q.data?.pages[q.data.pages.length - 1]?.total ?? 0;

  useEffect(() => {
    if (items.length > 0) setAgentsConnus((connus) => fusionnerAgents(connus, items));
  }, [items]);

  const filtreActif = filtres.depuis !== "" || filtres.jusqua !== "" || filtres.userId !== "";
  const montrerAgent = multi || items.some((i) => i.agent.id !== user?.id);
  const genre = q.isError ? classerErreur(q.error) : null;
  // Un echec de la page SUIVANTE (ou d'un rechargement) ne fait pas disparaitre ce qui est deja affiche.
  const echecPageSuivante = q.isFetchNextPageError;
  const relancer = () => void (echecPageSuivante ? q.fetchNextPage() : q.refetch());
  const alerteErreur = genre !== null && (
    <div role="alert" className="space-y-2 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-950">
      <p>{messageErreur(genre, "liste")}{items.length > 0 ? " Les relevés déjà chargés restent affichés." : ""}</p>
      {peutReessayer(genre) && (
        <Button size="sm" onClick={relancer} disabled={q.isFetching}><RotateCcw className="h-4 w-4" aria-hidden="true" />Réessayer</Button>
      )}
    </div>
  );
  const autresAgents = agentsConnus.filter((a) => a.id !== user?.id);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Relevés envoyés</h1>
        <p className="mt-1 text-sm text-gray-700">
          Les relevés en roulant que le serveur a reçus. Ouvrir un relevé montre sa trace, ses repères et ses segments.
          Un relevé enregistré mais pas encore envoyé reste sur le téléphone et n'apparaît pas ici.
        </p>
        <p className="mt-1 text-sm">
          <Link className="underline" to="/inspections/releve/enregistrer">Enregistrer un relevé en roulant</Link>
        </p>
      </header>

      <form className="flex flex-wrap items-end gap-3" aria-label="Filtres des relevés envoyés" onSubmit={(e) => e.preventDefault()}>
        <div>
          <label htmlFor="re-depuis" className="block text-xs text-gray-700">Du</label>
          <input id="re-depuis" type="date" value={filtres.depuis} onChange={(e) => setFiltres((f) => ({ ...f, depuis: e.target.value }))} className={CHAMP} />
        </div>
        <div>
          <label htmlFor="re-jusqua" className="block text-xs text-gray-700">Au (jour inclus)</label>
          <input id="re-jusqua" type="date" value={filtres.jusqua} onChange={(e) => setFiltres((f) => ({ ...f, jusqua: e.target.value }))} className={CHAMP} />
        </div>
        {multi && (
          <div>
            <label htmlFor="re-agent" className="block text-xs text-gray-700">Agent</label>
            <select id="re-agent" value={filtres.userId} onChange={(e) => setFiltres((f) => ({ ...f, userId: e.target.value }))} className={CHAMP}>
              <option value="">Tous les agents</option>
              {user?.id && <option value={user.id}>Mes relevés</option>}
              {autresAgents.map((a) => <option key={a.id} value={a.id}>{a.nom || "Agent sans nom"}</option>)}
            </select>
          </div>
        )}
        {filtreActif && (
          <Button type="button" variant="outline" size="sm" onClick={() => setFiltres(FILTRES_VIDES)}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />Réinitialiser les filtres
          </Button>
        )}
      </form>
      {multi && autresAgents.length === 0 && (
        <p className="-mt-3 text-xs text-gray-600">La liste des agents se remplit avec les relevés déjà affichés : le serveur ne fournit pas de liste d'agents.</p>
      )}
      {periode.erreur && <p role="alert" className="text-sm text-red-900">{periode.erreur} Les filtres de date précédents restent appliqués.</p>}

      {q.isPending && <p role="status" className="text-sm text-gray-700">Chargement des relevés envoyés…</p>}

      {items.length === 0 && alerteErreur}

      {q.isSuccess && items.length === 0 && (
        filtreActif ? (
          <div className="space-y-2 rounded-lg border border-gray-300 bg-white p-4 text-sm">
            <p><strong>Aucun relevé ne correspond à ces filtres.</strong> Ce n'est pas un échec de chargement : le serveur n'a aucun relevé envoyé dans cette sélection.</p>
            <Button size="sm" variant="outline" onClick={() => setFiltres(FILTRES_VIDES)}>Réinitialiser les filtres</Button>
          </div>
        ) : (
          <section aria-labelledby="re-vide" className="space-y-2 rounded-lg border border-gray-300 bg-white p-4 text-sm">
            <h2 id="re-vide" className="font-semibold">{multi ? "Aucun relevé envoyé n'est visible avec ce compte" : "Aucun relevé envoyé depuis ce compte"}</h2>
            <p>
              Pour en envoyer un : enregistrer un relevé en roulant, l'arrêter, puis choisir « Envoyer la session au serveur ». Tant que l'envoi n'est pas confirmé,
              le relevé reste sur le téléphone.
            </p>
            <p>
              <Link className="inline-flex items-center gap-1 underline" to="/inspections/releve/enregistrer"><MapPin className="h-4 w-4" aria-hidden="true" />Enregistrer un relevé en roulant</Link>
            </p>
          </section>
        )
      )}

      {items.length > 0 && (
        <section aria-labelledby="re-liste" className="space-y-3">
          <h2 id="re-liste" className="sr-only">Liste des relevés envoyés</h2>
          <p className="text-sm text-gray-700" aria-live="polite">{libelleTotal(items.length, total)}</p>
          {/* Region defilante focalisable : le clavier atteint le tableau quand il deborde sur petit ecran (WCAG 2.1.1).
              `relative` : sans lui, les textes `sr-only` (position absolue) des cellules ne sont pas rognes par ce conteneur et
              elargissent la PAGE (meme piege que ListeLots, mesure au navigateur). */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <div role="region" aria-label="Tableau des relevés envoyés" tabIndex={0} className="relative overflow-x-auto rounded-lg border border-gray-300 bg-white">
            <table className="w-full min-w-[44rem] border-collapse text-left">
              <caption className="sr-only">Relevés en roulant envoyés au serveur, du plus récent au plus ancien</caption>
              <thead>
                <tr className="border-b border-gray-300 bg-gray-50">
                  <th scope="col" className={TH}>Date et heure</th>
                  {/* Le lien suit la date : sur telephone, le tableau defile et une derniere colonne serait hors de vue. */}
                  <th scope="col" className={TH}>Détail</th>
                  <th scope="col" className={TH}>Durée</th>
                  <th scope="col" className={TH}>Distance parcourue</th>
                  <th scope="col" className={TH}>Positions</th>
                  <th scope="col" className={TH}>Repères</th>
                  <th scope="col" className={TH}>Rattachement au réseau</th>
                  {montrerAgent && <th scope="col" className={TH}>Agent</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="border-b border-gray-100">
                    <th scope="row" className={`${TD} font-medium`}>{libelleDateHeure(r.debutA)}</th>
                    <td className={TD}>
                      <Link className="underline" to={`/inspections/releve/envoyes/${encodeURIComponent(r.id)}`}>
                        Voir le relevé<span className="sr-only">{suiteNomLienReleve(r)}</span>
                      </Link>
                    </td>
                    <td className={TD}>{libelleDureeReleve(r.dureeS)}</td>
                    <td className={TD}>{libelleDistance(r.longueurM)}</td>
                    <td className={TD}>{libelleNombre(r.nbPoints)}</td>
                    <td className={TD}>{libelleNombre(r.nbMarqueurs)}</td>
                    <td className={TD}>{libelleTaux(r.tauxRattachement)}</td>
                    {montrerAgent && <td className={TD}>{r.agent.nom || "nom non communiqué"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {alerteErreur}
          {q.hasNextPage && genre === null && (
            <Button variant="outline" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? "Chargement…" : "Charger plus"}
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
