import { useId, useState } from "react";
import { Button } from "../../ui/Button";
import type { Delta, ReponseDepot } from "../../../lib/projetsVoirieApi";
import { JUSTIFICATION_MIN, MESSAGE_QUARANTAINE, formaterDate, formaterNombre } from "../../../lib/projetsVoirie";
import { justificationValide, texteAttribut, type DeltaDetail } from "../../../lib/projetsVoirieImport";
import { ChampJustification, Encart, ListeAvertissements } from "./commun";

/** Les quatre compteurs du delta. Les suppressions sont dites « a revoir » : jamais appliquees d'office. */
export function CompteursDelta({ delta }: { delta: Delta }) {
  return (
    <dl data-testid="delta" aria-label="Comparaison avec la version autorisée" className="grid grid-cols-2 gap-x-3 gap-y-1 rounded border border-gray-200 bg-white p-3 text-sm sm:grid-cols-4">
      <div><dt className="text-gray-700">Ajoutés</dt><dd className="text-base font-semibold" data-testid="delta-ajoutes">{formaterNombre(delta.ajoutes, 0)}</dd></div>
      <div><dt className="text-gray-700">Modifiés</dt><dd className="text-base font-semibold" data-testid="delta-modifies">{formaterNombre(delta.modifies, 0)}</dd></div>
      <div><dt className="text-gray-700">Retirés (à revoir)</dt><dd className="text-base font-semibold" data-testid="delta-retires">{formaterNombre(delta.retires, 0)}</dd></div>
      <div><dt className="text-gray-700">Identiques</dt><dd className="text-base font-semibold" data-testid="delta-identiques">{formaterNombre(delta.identiques, 0)}</dd></div>
    </dl>
  );
}

function Echantillon({ titre, lignes }: { titre: string; lignes: string[] }) {
  if (lignes.length === 0) return null;
  return (
    <div>
      <h5 className="text-xs font-semibold text-gray-900">{titre} (20 au plus, aucune géométrie)</h5>
      <ul className="list-disc pl-5 text-xs text-gray-800">{lignes.map((l, i) => <li key={i} className="break-all">{l}</li>)}</ul>
    </div>
  );
}

/**
 * Etape 6 : comparaison avec la version AUTORISEE precedente (ajoutes, modifies, retires, identiques).
 *
 *   - avant le depot : resultat de la SIMULATION (rien n'est ecrit) ; « Enregistrer en quarantaine » est un geste explicite ;
 *   - apres le depot (ou en reprise d'un jeu existant) : delta detaille du serveur, et REVUE DES SUPPRESSIONS : les objets retires ne sont jamais
 *     appliques silencieusement ; accepter ou refuser exige une justification, auditee. Une nouvelle revue remplace la precedente (toutes sont conservees).
 */
export function EtapeDelta({ simulation, depot, delta, chargementDelta, occupe, enLigne, onEnregistrer, onRevue, onRecharger }: {
  simulation: ReponseDepot | null; depot: ReponseDepot | null; delta: DeltaDetail | null; chargementDelta: boolean; occupe: boolean; enLigne: boolean;
  onEnregistrer: () => void; onRevue: (decision: "ACCEPTER" | "REFUSER", justification: string) => Promise<boolean>; onRecharger: () => void;
}) {
  const id = useId();
  const [justification, setJustification] = useState("");
  const source = depot ?? simulation;
  const suppressions = delta?.suppressions ?? source?.suppressions ?? null;
  const peutRevoir = delta !== null && (delta.jeu.statut === "CONTROLE" || delta.jeu.statut === "RECU") && delta.suppressions.nb > 0;
  const refusDefinitif = delta !== null && delta.suppressions.statut === "REFUSEES";
  const ok = justificationValide(justification);

  async function revue(d: "ACCEPTER" | "REFUSER") {
    if (await onRevue(d, justification.trim())) setJustification("");
  }

  return (
    <div className="space-y-4">
      {!depot && simulation && (
        <section className="space-y-3" aria-label="Résultat de la simulation">
          <Encart testid="simulation-seule" titre="Simulation seulement : rien n'a été écrit">
            <p>Le serveur a rejoué le dépôt complet dans une transaction annulée. {MESSAGE_QUARANTAINE}</p>
          </Encart>
          <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded border border-gray-200 bg-white p-3 text-sm">
            <dt className="text-gray-700">Version prévue</dt><dd>{simulation.version ?? "Non indiquée"}</dd>
            <dt className="text-gray-700">Objets enregistrés</dt><dd>{formaterNombre(simulation.resume.nbObjets, 0)}</dd>
            {simulation.remplace
              ? (<><dt className="text-gray-700">Remplacera</dt><dd>la version {simulation.remplace.version} autorisée, une fois cette version autorisée à son tour</dd></>)
              : (<><dt className="text-gray-700">Comparaison</dt><dd>Première version de ce jeu : aucune version autorisée à comparer.</dd></>)}
          </dl>
          {simulation.delta && <CompteursDelta delta={simulation.delta} />}
          {simulation.suppressions && simulation.suppressions.nb > 0 && (
            <Encart ton="attention" testid="suppressions-a-revoir" titre={`${formaterNombre(simulation.suppressions.nb, 0)} suppression(s) à revoir`}>
              <p>Cette version retire des objets de la version autorisée. Ils ne sont jamais supprimés d&apos;office : après l&apos;enregistrement, une revue humaine justifiée (accepter ou refuser) sera exigée avant toute autorisation.</p>
            </Encart>
          )}
          {simulation.validationGeometrique && simulation.validationGeometrique.nbProblemes > 0 && (
            <p className="text-xs text-gray-800">{formaterNombre(simulation.validationGeometrique.nbProblemes, 0)} géométrie(s) invalide(s) réparée(s) par la base à l&apos;enregistrement.</p>
          )}
          <ListeAvertissements liste={simulation.avertissements} />
          <div className="flex justify-end">
            <Button type="button" disabled={occupe || !enLigne} onClick={onEnregistrer}>Enregistrer en quarantaine</Button>
          </div>
          <p className="text-right text-xs text-gray-700">L&apos;enregistrement crée un jeu « à autoriser » et consigne l&apos;opération dans le journal d&apos;audit.</p>
        </section>
      )}

      {depot && (
        <Encart testid="depot-enregistre" titre={`Fichier enregistré en quarantaine${depot.version !== null ? `, version ${depot.version}` : ""}`}>
          <p>{MESSAGE_QUARANTAINE} Les étapes précédentes ne peuvent plus être modifiées.</p>
        </Encart>
      )}

      {(depot || (!simulation && !depot)) && chargementDelta && !delta && <p role="status" className="text-sm text-gray-700">Chargement de la comparaison détaillée…</p>}
      {(depot || (!simulation && !depot)) && !chargementDelta && !delta && (
        <div className="flex items-center gap-2">
          <p className="text-sm text-gray-800">La comparaison détaillée n&apos;est pas chargée.</p>
          <Button type="button" size="sm" variant="outline" className="min-h-[44px] sm:min-h-8" disabled={occupe} onClick={onRecharger}>Charger la comparaison</Button>
        </div>
      )}

      {delta && (
        <section className="space-y-3" aria-label="Comparaison détaillée" data-testid="delta-detail">
          <h4 className="text-sm font-semibold text-navy">Version {delta.jeu.version}{delta.comparaison ? ` comparée à la version ${delta.comparaison.version} (${delta.comparaison.statut === "AUTORISE" ? "autorisée" : delta.comparaison.statut.toLowerCase()})` : ""}</h4>
          {!delta.comparaison || !delta.delta ? (
            <p className="text-sm text-gray-800">Première version de ce jeu : aucune version précédente à comparer, donc aucune suppression à revoir.</p>
          ) : (
            <>
              <CompteursDelta delta={delta.delta} />
              <p className="text-xs text-gray-700">
                Les objets sont rapprochés par {delta.cleComparaison === "identifiant" ? "la colonne « identifiant » de la correspondance de champs" : "leur nom (aucun identifiant n'a été associé)"}.
                {delta.clesAmbigues > 0 && ` ${formaterNombre(delta.clesAmbigues, 0)} clé(s) apparaissent plusieurs fois : leurs objets sont comptés comme ajoutés et retirés.`}
              </p>
              <Echantillon titre="Ajoutés" lignes={delta.echantillons.ajoutes.map((a) => texteAttribut(a.nom ?? "Objet sans nom", 80))} />
              <Echantillon titre="Modifiés" lignes={delta.echantillons.modifies.map((m) => `${texteAttribut(m.cle, 40)} : « ${texteAttribut(m.nomAvant ?? "sans nom", 60)} » devient « ${texteAttribut(m.nomApres ?? "sans nom", 60)} »`)} />
              <Echantillon titre="Retirés (à revoir)" lignes={delta.echantillons.retires.map((r) => texteAttribut(r.nom ?? "Objet sans nom", 80))} />
            </>
          )}

          {delta.suppressions.nb > 0 && (
            <div className="space-y-2 rounded-md border-2 border-amber-300 bg-amber-50 p-3" data-testid="revue-suppressions" data-statut={delta.suppressions.statut}>
              <h4 className="text-sm font-semibold text-amber-900">
                Suppressions : {delta.suppressions.statut === "A_REVOIR" ? "à revoir" : delta.suppressions.statut === "ACCEPTEES" ? "acceptées" : delta.suppressions.statut === "REFUSEES" ? "refusées" : "aucune"}
              </h4>
              <p className="text-sm text-amber-900">
                {formaterNombre(delta.suppressions.nb, 0)} objet(s) de la version autorisée ne figurent plus dans cette version. Rien n&apos;est supprimé tant qu&apos;une personne n&apos;a pas revu et accepté : accepter signifie que
                cette version remplace l&apos;ancienne telle quelle (l&apos;ancienne reste conservée, statut « remplacé »). Refuser interdit l&apos;autorisation de cette version.
              </p>
              {delta.suppressions.revue && (
                <p className="text-sm text-gray-900" data-testid="derniere-revue">
                  Dernière revue : <strong>{delta.suppressions.revue.decision === "ACCEPTER" ? "acceptée" : "refusée"}</strong> par {delta.suppressions.revue.par?.nomComplet ?? "un compte inconnu"}
                  {delta.suppressions.revue.le ? ` le ${formaterDate(delta.suppressions.revue.le)}` : ""} : « {texteAttribut(delta.suppressions.revue.justification, 300)} ».{" "}
                  {refusDefinitif
                    ? "Ce refus est définitif pour ces suppressions : la version ne peut plus qu'être rejetée ou retirée, ou remplacée par un fichier corrigé. Toutes les revues sont conservées."
                    : "Une nouvelle revue remplace celle-ci ; toutes sont conservées."}
                </p>
              )}
              {peutRevoir ? (
                <>
                  <ChampJustification id={`${id}-justif`} libelle="Justification de la revue" valeur={justification} onChange={setJustification} disabled={occupe} minimum={JUSTIFICATION_MIN} />
                  <div className="flex flex-wrap gap-2">
                    {/* Regle O1 du serveur : apres un refus, l'acceptation est refusee (409 SUPPRESSIONS_REFUSEES) ; ne pas proposer un geste impossible (defaut C1-02). */}
                    {!refusDefinitif && <Button type="button" disabled={occupe || !enLigne || !ok} onClick={() => void revue("ACCEPTER")}>Accepter les suppressions</Button>}
                    <Button type="button" variant="outline" disabled={occupe || !enLigne || !ok} onClick={() => void revue("REFUSER")}>Refuser les suppressions</Button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-gray-800">La revue n&apos;est possible que pour une version en quarantaine.</p>
              )}
            </div>
          )}
          {suppressions && suppressions.nb === 0 && delta.comparaison && <p className="text-sm text-green-900">Aucune suppression : rien à revoir.</p>}
        </section>
      )}
    </div>
  );
}
