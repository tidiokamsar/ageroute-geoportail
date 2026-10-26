import { forwardRef, useRef, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Loader2, ShieldCheck } from "lucide-react";
import { classerErreur, type ErreurTd, type SourceObservation } from "../../lib/teledetectionApi";
import { useVerificationSource } from "../../lib/teledetectionHooks";
import { formaterDate, formaterDateHeure, formaterResolution, infoEtatSource } from "../../lib/teledetectionAffichage";
import { Button } from "../ui/Button";
import { BandeauPerime, EtatChargement, EtatErreur, EtatVide } from "./EtatsPanneau";
import { PastilleEtatSource } from "./Pastilles";

const ORDRE_ECHELLE = [
  "NON_CONFIGUREE", "CONFIGUREE", "AUTHENTIFIEE", "ACCESSIBLE", "PRODUIT_DISPONIBLE", "TRAITEMENT_OPERATIONNEL", "EN_ERREUR", "EN_ATTENTE_CONFIGURATION",
] as const;

/**
 * Sources d'observation et echelle d'etat du contrat (paragraphe 4). « Active » ne s'affiche que
 * pour TRAITEMENT_OPERATIONNEL : un nom de fournisseur en base, ou un catalogue qui repond, ne
 * suffit pas. Le bouton « Verifier » (ADMIN) lance le test de connectivite REEL cote serveur ; les
 * identifiants ne passent jamais par cet ecran.
 */
export const TableauSources = forwardRef<HTMLHeadingElement, { sources: UseQueryResult<SourceObservation[], unknown>; peutVerifier: boolean }>(
  function TableauSources({ sources, peutVerifier }, refTitre) {
    const { data, isPending, isError, error, refetch, isFetching, dataUpdatedAt } = sources;
    const verifier = useVerificationSource();
    // Verrou synchrone : deux clics du meme tick (ou un double clic) ne lancent qu'un test de connectivite reel.
    const verrou = useRef(false);
    const [dernier, setDernier] = useState<{ code: string; nom: string; erreur: ErreurTd | null } | null>(null);
    const erreur = isError ? classerErreur(error) : null;
    const actives = data?.filter((s) => infoEtatSource(s.etat).active).length ?? 0;

    function lancer(s: SourceObservation) {
      if (verrou.current) return;
      verrou.current = true;
      setDernier(null);
      verifier.mutateAsync(s.code).then(
        () => setDernier({ code: s.code, nom: s.nom, erreur: null }),
        (e: ErreurTd) => setDernier({ code: s.code, nom: s.nom, erreur: e }),
      ).finally(() => { verrou.current = false; });
    }

    return (
      <section id="sources-observation" aria-labelledby="titre-sources" className="scroll-mt-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="titre-sources" ref={refTitre} tabIndex={-1} className="text-base font-semibold text-navy focus:outline-none">Sources d&apos;observation</h2>
          {data && data.length > 0 && (
            <p className="text-xs text-gray-600">{actives} {actives > 1 ? "actives" : "active"} sur {data.length} {data.length > 1 ? "enregistrées" : "enregistrée"}</p>
          )}
        </div>

        {isPending && <EtatChargement libelle="Chargement des sources…" />}
        {erreur && !data && <div className="mt-2"><EtatErreur panneau="Sources" erreur={erreur} onReessayer={() => void refetch()} reessaiEnCours={isFetching} /></div>}
        {erreur && data && <div className="mt-2"><BandeauPerime panneau="Sources" misAJourLe={dataUpdatedAt} onReessayer={() => void refetch()} /></div>}

        {dernier && (
          dernier.erreur ? (
            <p role="alert" className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-900">
              Vérification de {dernier.nom} impossible : {dernier.erreur.message}
            </p>
          ) : (
            <p role="status" className="mt-2 rounded border border-green-200 bg-green-50 p-2 text-sm text-green-900">
              Vérification de {dernier.nom} terminée. L&apos;état affiché est celui que le serveur a mesuré.
            </p>
          )
        )}

        {data && data.length === 0 && <div className="mt-2"><EtatVide titre="Aucune source d'observation enregistrée" detail="Les sources se déclarent côté serveur." /></div>}

        {data && data.length > 0 && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Sources d&apos;observation de la Terre, avec leur état, leur résolution et leurs dernières dates</caption>
              <thead>
                <tr className="border-b text-xs text-gray-600">
                  <th scope="col" className="py-2 pr-2 font-medium">Source</th>
                  <th scope="col" className="py-2 pr-2 font-medium">État</th>
                  <th scope="col" className="hidden py-2 pr-2 font-medium md:table-cell">Résolution</th>
                  <th scope="col" className="hidden py-2 pr-2 font-medium md:table-cell">Dernière acquisition</th>
                  <th scope="col" className="hidden py-2 pr-2 font-medium lg:table-cell">Dernière vérification</th>
                </tr>
              </thead>
              <tbody>
                {data.map((s) => {
                  const enCours = verifier.isPending && verifier.variables === s.code;
                  return (
                    <tr key={s.code} className="border-b last:border-0 align-top">
                      <th scope="row" className="py-2 pr-2 font-medium text-gray-900">
                        {s.nom}
                        <span className="block text-xs font-normal text-gray-600">{[s.fournisseur, s.capteur].filter(Boolean).join(" · ") || "Fournisseur non renseigné"}</span>
                        <span className="block text-xs font-normal text-gray-600 md:hidden">
                          {formaterResolution(s.resolutionM)} · acquisition {s.derniereAcquisition ? formaterDate(s.derniereAcquisition) : "aucune"}
                        </span>
                      </th>
                      <td className="py-2 pr-2">
                        <PastilleEtatSource etat={s.etat} />
                        {s.message && <span className="mt-1 block max-w-[16rem] text-xs text-gray-600">{s.message}</span>}
                        {s.requiertIdentifiants && !infoEtatSource(s.etat).active && (
                          <span className="mt-1 block text-xs text-gray-600">Identifiants requis côté serveur</span>
                        )}
                        {peutVerifier && (
                          <Button
                            type="button" size="sm" variant="outline" className="mt-2 min-h-[44px] xl:min-h-0"
                            aria-label={`Vérifier la source ${s.nom}`} disabled={verifier.isPending} onClick={() => lancer(s)}
                          >
                            {enCours ? <Loader2 aria-hidden="true" className="animate-spin" /> : <ShieldCheck aria-hidden="true" />}
                            {enCours ? "Vérification…" : "Vérifier"}
                          </Button>
                        )}
                      </td>
                      <td className="hidden py-2 pr-2 md:table-cell">{formaterResolution(s.resolutionM)}</td>
                      <td className="hidden py-2 pr-2 md:table-cell">{s.derniereAcquisition ? formaterDate(s.derniereAcquisition) : "Aucune"}</td>
                      <td className="hidden py-2 pr-2 lg:table-cell">{s.derniereVerification ? formaterDateHeure(s.derniereVerification) : "Jamais vérifiée"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {verifier.isPending && <p role="status" className="sr-only">Vérification de la source en cours…</p>}

        <details className="mt-3 text-xs text-gray-700">
          <summary className="flex min-h-[44px] cursor-pointer items-center py-2 font-medium text-navy xl:min-h-0">Échelle d&apos;état des sources</summary>
          <ul className="mt-1 space-y-1">
            {ORDRE_ECHELLE.map((e) => {
              const i = infoEtatSource(e);
              return <li key={e}><strong>{i.libelle}</strong> : {i.explication}</li>;
            })}
          </ul>
          <p className="mt-2">Seule la mention « Active » signifie qu&apos;un traitement réel alimente des propositions. Les identifiants des fournisseurs se configurent sur le serveur : cet écran ne les affiche ni ne les saisit.</p>
        </details>
      </section>
    );
  },
);
