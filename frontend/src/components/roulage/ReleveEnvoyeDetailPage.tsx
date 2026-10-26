import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";
import { useAuth } from "../../lib/auth";
import { useReleveEnvoye, type DetailReleveEnvoye } from "../../lib/roulageEnvoyes";
import {
  aDesPortionsNonListees, classerErreur, etatTrace, etiquetteMarqueur, libelleDateHeure, libelleHeure, libellePortion, libelleProvenance,
  libelleQualification, libelleRattachementMarqueur, libelleResultatEvenement, libelleSourcePosition, libelleStatutAppareil, libelleTroncon,
  lignesResume, lignesSeuils, lireAnalyseServeur, messageErreur, noteMarqueur, noteSurPositions, noteTronconsManquants, peutReessayer,
  repartirMarqueurs, tronconsRattaches, voitPlusieursAgents,
} from "../../lib/roulageEnvoyesVue";
import { TronconFicheModal } from "../TronconFicheModal";
import { Button } from "../ui/Button";
import { CarteReleveEnvoye } from "./CarteReleveEnvoye";

/**
 * Detail d'un releve en roulant ENVOYE au serveur : ce que le serveur a gardé de la session, et rien d'autre.
 *
 * CE QUE L'ECRAN GARANTIT
 *   - la trace affichee est celle du serveur ; si elle est SIMPLIFIEE, absente, ou si des positions detaillees manquent,
 *     une phrase le dit a cote de la carte (jamais une trace presentee comme complete quand elle ne l'est pas) ;
 *   - un repere a position perimee est signale sur la carte (pointille) et dans la liste, avec la raison ;
 *   - un chiffre inconnu est dit « non evalue », « non calculee » ou « non communique », jamais remplace par zero ;
 *   - les qualifications des segments sont des CHOIX de l'agent (codes de referentiel), pas des mesures de l'etat de la route ;
 *   - une portion « proposee » n'est pas une portion validee : elle reste a valider par un tiers (ecran Portions terrain).
 *
 * Aucune donnee n'est fabriquee : tout vient de `GET /api/v2/roulage/sessions/:id`.
 */

function Section({ id, titre, children }: { id: string; titre: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3 rounded-lg border border-gray-300 bg-white p-4">
      <h2 id={id} className="text-lg font-semibold">{titre}</h2>
      {children}
    </section>
  );
}

/** Tableau defilable au clavier sur petit ecran (region nommee et focalisable, sinon un lecteur d'ecran ne l'atteint pas). */
function TableauDefilant({ nom, children }: { nom: string; children: React.ReactNode }) {
  return (
    // Region defilante : focalisable pour que le clavier atteigne le tableau quand il deborde (WCAG 2.1.1), comme ListeLots.
    // `relative` : les textes `sr-only` (position absolue) des cellules ne doivent pas elargir la page.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div role="region" aria-label={nom} tabIndex={0} className="relative overflow-x-auto">
      {children}
    </div>
  );
}

const TH = "px-2 py-2 text-left text-xs font-semibold text-gray-700";
const TD = "px-2 py-2 align-top text-sm";

function Corps({ d }: { d: DetailReleveEnvoye }) {
  const { user } = useAuth();
  const [ficheId, setFicheId] = useState<string | null>(null);
  const trace = useMemo(() => etatTrace(d), [d]);
  const { surCarte, sansPosition } = useMemo(() => repartirMarqueurs(d.marqueurs), [d.marqueurs]);
  const troncons = useMemo(() => tronconsRattaches(d.evenements, d.marqueurs), [d.evenements, d.marqueurs]);
  const analyseServeur = useMemo(() => lireAnalyseServeur(d.analyse.serveur), [d.analyse.serveur]);
  const seuils = useMemo(() => lignesSeuils(d.parametres.seuils), [d.parametres.seuils]);
  const noteTroncons = noteTronconsManquants(d.nbTronconsTraverses, troncons.length);
  const notePositions = noteSurPositions(d.trace);
  const resume = lignesResume(d);
  const montrerAgent = voitPlusieursAgents(user?.role) || (user?.id !== undefined && d.agent.id !== user.id);
  const carteUtile = trace.lignes.length > 0 || surCarte.length > 0;

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2" aria-label="Origine du relevé">
        {montrerAgent && <div className="flex justify-between gap-2"><dt className="text-gray-600">Agent</dt><dd>{d.agent.nom || "nom non communiqué"}</dd></div>}
        <div className="flex justify-between gap-2"><dt className="text-gray-600">Mission</dt><dd>{d.missionId ? `liée (identifiant ${d.missionId.slice(0, 8)})` : "aucune mission liée"}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-gray-600">Reçu par le serveur le</dt><dd>{libelleDateHeure(d.creeLe)}</dd></div>
      </dl>

      <Section id="carte" titre="Trace et repères">
        {trace.message && (
          <p role="status" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{trace.message}</span>
          </p>
        )}
        {notePositions && <p role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{notePositions}</p>}
        {carteUtile
          ? <CarteReleveEnvoye lignes={trace.lignes} marqueurs={surCarte} />
          : <p className="rounded-md border border-gray-300 bg-gray-50 p-3 text-sm text-gray-800">Aucune carte à afficher : ni trace, ni repère placé.</p>}
      </Section>

      <Section id="resume" titre="Résumé du relevé">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {resume.map((l) => (
            <div key={l.libelle} className="flex justify-between gap-2 border-b border-gray-100 py-1">
              <dt className="text-gray-600">{l.libelle}</dt>
              <dd className="text-right font-medium">{l.valeur}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-gray-600">
          La distance parcourue est celle que l'analyse du serveur a calculée à l'envoi sur les positions retenues : ce n'est pas la longueur du tracé dessiné sur la carte. Le rattachement dit quelle part de ces positions a pu être placée sur le réseau routier de référence : ce n'est pas une mesure de l'exactitude de la position.
        </p>
        {analyseServeur.avertissements.length > 0 && (
          <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />Avertissements de l'analyse du serveur</p>
            <ul className="list-disc space-y-1 pl-5">
              {analyseServeur.avertissements.map((a) => <li key={a}>{a}</li>)}
            </ul>
            <p className="text-xs">Ces phrases sont celles du serveur, reproduites telles quelles.</p>
          </div>
        )}
        {(d.parametres.provenance || d.parametres.versionContrat !== null) && (
          <p className="text-xs text-gray-600">
            Paramètres de l'enregistrement{d.parametres.provenance ? ` : ${libelleProvenance(d.parametres.provenance)}` : ""}{d.parametres.versionContrat !== null ? ` (version du contrat ${d.parametres.versionContrat})` : ""}.
          </p>
        )}
        {seuils.length > 0 && (
          <details className="text-xs text-gray-700">
            <summary className="cursor-pointer underline">Seuils appliqués par le téléphone ({seuils.length})</summary>
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
              {seuils.map((l) => (
                <div key={l.libelle} className="flex justify-between gap-2 border-b border-gray-100 py-0.5">
                  <dt className="font-mono">{l.libelle}</dt><dd className="text-right">{l.valeur}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-1">Noms et valeurs tels qu'enregistrés. Tant que la provenance est « seuils provisoires, non calibrés », ces valeurs ne sont pas validées sur le terrain.</p>
          </details>
        )}
      </Section>

      <Section id="reperes" titre={`Repères posés (${d.marqueurs.length})`}>
        {d.marqueurs.length === 0 ? (
          <p className="text-sm text-gray-700">Aucun repère n'a été posé pendant ce relevé.</p>
        ) : (
          <TableauDefilant nom="Repères posés pendant le relevé">
            <table className="w-full min-w-[34rem] border-collapse text-left">
              <caption className="sr-only">Repères posés pendant le relevé, avec leur heure, leur position et leur rattachement</caption>
              <thead><tr className="border-b border-gray-300">
                <th scope="col" className={TH}>Repère</th><th scope="col" className={TH}>Note</th><th scope="col" className={TH}>Position</th><th scope="col" className={TH}>Rattachement</th>
              </tr></thead>
              <tbody>
                {d.marqueurs.map((m) => {
                  const note = noteMarqueur(m);
                  return (
                    <tr key={m.id} className="border-b border-gray-100">
                      <th scope="row" className={`${TD} font-medium`}>{etiquetteMarqueur(m)}</th>
                      <td className={TD}>{m.note ?? "aucune note"}</td>
                      <td className={TD}>
                        {typeof m.lat === "number" && typeof m.lon === "number"
                          ? `${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}${typeof m.precisionM === "number" ? ` (± ${Math.round(m.precisionM)} m)` : ""}`
                          : "aucune position"}
                        {libelleSourcePosition(m.sourcePosition) && <span className="block text-xs text-gray-600">{libelleSourcePosition(m.sourcePosition)}</span>}
                        {note && <span className="mt-1 block text-xs text-amber-900">{note}</span>}
                      </td>
                      <td className={TD}>{libelleRattachementMarqueur(m)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableauDefilant>
        )}
        {sansPosition.length > 0 && (
          <p className="text-xs text-gray-700">{sansPosition.length} repère(s) sans position ne sont pas placés sur la carte.</p>
        )}
      </Section>

      <Section id="segments" titre={`Segments relevés (${d.evenements.length})`}>
        {d.evenements.length === 0 ? (
          <p className="text-sm text-gray-700">Aucun segment n'a été relevé pendant ce trajet.</p>
        ) : (
          <>
            <TableauDefilant nom="Segments relevés pendant le trajet">
              <table className="w-full min-w-[40rem] border-collapse text-left">
                <caption className="sr-only">Segments relevés, avec leur heure, le choix de l'agent et le résultat du rattachement par le serveur</caption>
                <thead><tr className="border-b border-gray-300">
                  <th scope="col" className={TH}>Segment</th><th scope="col" className={TH}>Début</th><th scope="col" className={TH}>Fin</th>
                  <th scope="col" className={TH}>Choix de l'agent</th><th scope="col" className={TH}>Résultat côté serveur</th>
                </tr></thead>
                <tbody>
                  {d.evenements.map((e) => (
                    <tr key={e.id} className="border-b border-gray-100">
                      <th scope="row" className={`${TD} font-medium`}>
                        {e.code}
                        <span className="block text-xs font-normal text-gray-600">{libelleStatutAppareil(e.statutAppareil)}</span>
                        {e.note && <span className="block text-xs font-normal text-gray-700">{e.note}</span>}
                      </th>
                      <td className={TD}>{libelleHeure(e.debutA)}</td>
                      <td className={TD}>{e.finA ? libelleHeure(e.finA) : "non terminé"}</td>
                      <td className={TD}>{libelleQualification(e.qualification)}</td>
                      <td className={TD}>{libelleResultatEvenement(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableauDefilant>
            <p className="text-xs text-gray-600">
              Le choix de l'agent est ce qu'il a sélectionné sur le terrain (codes du référentiel), pas une mesure. Une portion proposée reste à valider par un tiers avant d'entrer dans le référentiel.
            </p>
            {aDesPortionsNonListees(d.evenements) && (
              <p className="text-xs text-gray-600">
                Certaines portions ont été refusées par le serveur (territoire, code de référentiel inconnu, chevauchement d'une portion validée) : la consultation ne les détaille pas. Seules les portions créées sont listées dans les tronçons ci-dessous.
              </p>
            )}
          </>
        )}
      </Section>

      <Section id="troncons" titre={`Tronçons rattachés (${troncons.length})`}>
        {noteTroncons && <p role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{noteTroncons}</p>}
        {troncons.length === 0 ? (
          <p className="text-sm text-gray-700">Aucun tronçon n'est rattaché à un segment ou à un repère de ce relevé.</p>
        ) : (
          <ul className="space-y-3">
            {troncons.map((t) => (
              <li key={t.tronconId} className="rounded-md border border-gray-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{libelleTroncon(t)}</p>
                  <Button size="sm" variant="outline" onClick={() => setFicheId(t.tronconId)}>
                    Ouvrir la fiche<span className="sr-only"> du tronçon {libelleTroncon(t)}</span>
                  </Button>
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-800">
                  {t.passages.map((p) => (
                    <li key={`${p.evenementId}-${p.rang}`}>Segment {p.evenementCode} : {libellePortion(p.portion)}</li>
                  ))}
                  {t.reperes.map((m) => (
                    <li key={m.id}>Repère {etiquetteMarqueur(m)} : {libelleRattachementMarqueur(m)}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {ficheId && <TronconFicheModal open onClose={() => setFicheId(null)} tronconId={ficheId} />}
    </div>
  );
}

export function ReleveEnvoyeDetailPage() {
  const { id } = useParams();
  const q = useReleveEnvoye(id);
  const genre = q.isError ? classerErreur(q.error) : null;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm">
          <Link className="inline-flex items-center gap-1 underline" to="/inspections/releve/envoyes"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Relevés envoyés</Link>
        </p>
        <h1 className="mt-2 text-2xl font-semibold">
          {q.data ? `Relevé du ${libelleDateHeure(q.data.debutA)}` : "Relevé envoyé"}
        </h1>
        <p className="mt-1 text-sm text-gray-700">Ce que le serveur a gardé de ce relevé en roulant.</p>
      </header>

      {q.isPending && !q.isError && <p role="status" className="text-sm text-gray-700">Chargement du relevé…</p>}

      {genre !== null && (
        <div role="alert" className="space-y-2 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-950">
          <p>{messageErreur(genre, "detail")}</p>
          <div className="flex flex-wrap gap-2">
            {peutReessayer(genre) && (
              <Button size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}><RotateCcw className="h-4 w-4" aria-hidden="true" />Réessayer</Button>
            )}
            <Link className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm underline" to="/inspections/releve/envoyes">Retour à la liste</Link>
          </div>
        </div>
      )}

      {q.data && <Corps d={q.data} />}
    </div>
  );
}
