/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement horizontal focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useEffect, useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { CODES_LOGIQUE, LIBELLE_LOGIQUE, basculer, droitExportScenario, MENTION_SIMULATION, relancer, type CodeLogique } from "../../../lib/aideDecisionScenarios";
import { comparerScenarios, listerScenarios } from "../../../lib/aideDecisionScenariosApi";
import { formaterGnf } from "../../../lib/moteurProgrammation";
import { jourFr } from "../../../lib/tableauDeBord";
import type { Region } from "../../../types";
import { Button } from "../../ui/Button";
import type { PropsOnglet } from "../types";
import { ComparaisonTableau } from "../simulation/ComparaisonTableau";
import { DetailScenarioVue } from "../simulation/DetailScenarioVue";
import { BandeauNonEngageant, EtatChargement, EtatErreur, EtatVide, lireErreur } from "../simulation/EtatsSimulation";
import { CaseACocher } from "../simulation/CaseACocher";

/**
 * Onglet « Scenarios » : retrouver les scenarios enregistres (filtre par nom ou par logique), ouvrir leur detail (entrees, version
 * des parametres et des baremes, resultat), les REJOUER avec verification d'empreinte, en comparer de 2 a 5 (tableau accessible
 * et barres), les exporter, les supprimer (suppression logique, selon les droits).
 *
 * Une simulation n'engage rien. Les droits (module, role, perimetre territorial) sont controles par le serveur : l'ecran dit
 * « acces refuse » pour un 403 et ne le confond ni avec un vide ni avec une panne.
 */
const MIN = 2;
const MAX = 5;

export function OngletScenarios(_props: PropsOnglet) {
  const { user } = useAuth();
  const peutEcrire = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";
  const idQ = useId(); const idLogique = useId();
  const [saisieQ, setSaisieQ] = useState("");
  const [q, setQ] = useState("");
  const [logique, setLogique] = useState<CodeLogique | "">("");
  const [page, setPage] = useState(1);
  const [coches, setCoches] = useState<string[]>([]);
  const [ouvert, setOuvert] = useState<string | null>(null);

  const regions = useQuery({ queryKey: ["regions"], queryFn: async () => (await api.get<Region[]>("/regions")).data, retry: relancer });
  const liste = useQuery({
    queryKey: ["ad", "scenarios", "liste", q, logique, page],
    queryFn: () => listerScenarios({ q, logique, page, pageSize: 20 }), retry: relancer,
  });
  const comparer = useMutation({ mutationFn: (ids: string[]) => comparerScenarios(ids) });

  const lignes = liste.data?.data ?? [];
  const total = liste.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (liste.data?.pageSize ?? 20)));
  const filtre = q !== "" || logique !== "";
  // Page vide alors qu'il reste des scenarios (derniere ligne d'une page supprimee) : retour a la derniere page existante.
  const pageVide = liste.data !== undefined && lignes.length === 0 && total > 0 && page > 1;
  useEffect(() => { if (pageVide) setPage(Math.max(1, Math.min(page - 1, pages))); }, [pageVide, pages, page]);
  const aucunScenario = liste.data !== undefined && total === 0;

  const apresSuppression = (id: string) => {
    setCoches((c) => c.filter((x) => x !== id));
    setOuvert(null);
    // Une comparaison qui montre un scenario supprime n'est plus vraie : elle disparait.
    if (comparer.data?.scenarios.some((c) => c.id === id)) comparer.reset();
  };

  return (
    <section aria-labelledby="scenarios-titre" className="space-y-4">
      <div>
        <h3 id="scenarios-titre" className="text-lg font-semibold text-navy">Scénarios enregistrés</h3>
        <p className="text-sm text-gray-700">Retrouvez, rejouez, comparez et exportez les simulations enregistrées. Un scénario enregistré ne se modifie pas.</p>
      </div>
      <BandeauNonEngageant mention={MENTION_SIMULATION} />

      <form className="flex flex-wrap items-end gap-3" role="search" aria-label="Filtrer les scénarios" onSubmit={(e) => { e.preventDefault(); setQ(saisieQ.trim()); setPage(1); }}>
        <div>
          <label htmlFor={idQ} className="block text-xs text-gray-700">Nom du scénario</label>
          <input id={idQ} type="search" value={saisieQ} onChange={(e) => setSaisieQ(e.target.value)} className="min-h-[44px] w-64 max-w-full rounded border px-2 py-1.5 text-sm xl:min-h-0" />
        </div>
        <div>
          <label htmlFor={idLogique} className="block text-xs text-gray-700">Logique de priorité</label>
          <select id={idLogique} value={logique} onChange={(e) => { setLogique(e.target.value as CodeLogique | ""); setPage(1); }} className="min-h-[44px] rounded border px-2 py-1.5 text-sm xl:min-h-0">
            <option value="">Toutes</option>
            {CODES_LOGIQUE.map((c) => <option key={c} value={c}>{LIBELLE_LOGIQUE[c]}</option>)}
          </select>
        </div>
        <Button type="submit" variant="outline" className="min-h-[44px] xl:min-h-0">Filtrer</Button>
        {filtre && <Button type="button" variant="ghost" className="min-h-[44px] xl:min-h-0" onClick={() => { setSaisieQ(""); setQ(""); setLogique(""); setPage(1); }}>Effacer les filtres</Button>}
      </form>

      {liste.isLoading && <EtatChargement libelle="Chargement des scénarios…" />}
      {liste.isError && <EtatErreur panneau="Liste des scénarios" erreur={lireErreur(liste.error)} onReessayer={() => void liste.refetch()} reessaiEnCours={liste.isFetching} />}
      {pageVide && <EtatChargement libelle="Retour à la page précédente…" />}
      {aucunScenario && (
        <EtatVide titre={filtre ? "Aucun scénario ne correspond aux filtres" : "Aucun scénario enregistré"} detail={filtre ? "Effacez les filtres pour voir tous les scénarios." : "Lancez une simulation depuis l'onglet Simulation, puis enregistrez-la sous un nom."} />
      )}
      {liste.data && total > 0 && !pageVide && (
        <div className="space-y-2">
          <p className="text-xs text-gray-700" aria-live="polite">{total} scénario(s) · {coches.length} coché(s) pour la comparaison ({MIN} à {MAX} attendus).</p>
          {lignes.length > 0 && (
          <div className="relative overflow-x-auto" role="region" tabIndex={0} aria-label="Liste des scénarios (défilement horizontal)">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Scénarios enregistrés</caption>
              <thead className="text-xs uppercase text-gray-700">
                <tr><th scope="col" className="py-1 pr-2">Comparer</th><th scope="col" className="pr-2">Scénario</th><th scope="col" className="pr-2">Auteur et date</th><th scope="col" className="pr-2">Période et logique</th><th scope="col" className="pr-2">Enveloppe</th><th scope="col" className="pr-2">Consommé</th><th scope="col" className="pr-2">Déficit</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {lignes.map((s) => (
                  <tr key={s.id} className="border-t align-top">
                    <td className="py-1 pr-2">
                      <CaseACocher aria-label={`Comparer ${s.intitule}`} checked={coches.includes(s.id)} disabled={!s.simulateur || (!coches.includes(s.id) && coches.length >= MAX)}
                        onChange={() => setCoches(basculer(coches, s.id))} />
                    </td>
                    <td className="pr-2">{s.intitule}<span className="block text-xs text-gray-700">{s.etiquette}{!s.simulateur ? " · calculé avant le simulateur" : ""}</span></td>
                    <td className="pr-2 text-xs">{s.auteurNom ?? `compte ${s.creeParId}`}<span className="block text-gray-700">{jourFr(s.creeLe)}</span></td>
                    <td className="pr-2 text-xs">{s.periode ? `${jourFr(s.periode.debut)} au ${jourFr(s.periode.fin)}` : `année ${s.annee}, période non renseignée`}<span className="block text-gray-700">{s.logique ? LIBELLE_LOGIQUE[s.logique] : "logique historique (ratio)"}</span></td>
                    <td className="whitespace-nowrap pr-2 tabular-nums">{formaterGnf(s.budgetGnf)}</td>
                    <td className="whitespace-nowrap pr-2 tabular-nums">{formaterGnf(s.montantEngageGnf)}<span className="block text-xs text-gray-700">{s.nbRetenues} retenue(s)</span></td>
                    <td className="whitespace-nowrap pr-2 tabular-nums">
                      {s.deficitGnf === null ? <span className="text-gray-700">non calculé</span>
                        : s.deficitGnf === "0" ? <>aucun{s.deficitMinorant ? <span className="block text-xs">coûts non fiables non comptés</span> : null}</>
                        : <span className="font-semibold text-red-900">{formaterGnf(s.deficitGnf)}{s.deficitMinorant ? <span className="block text-xs font-normal">minimum</span> : null}</span>}
                    </td>
                    <td>
                      <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-0" aria-pressed={ouvert === s.id} onClick={() => setOuvert(ouvert === s.id ? null : s.id)}>
                        {ouvert === s.id ? "Fermer" : "Ouvrir"}<span className="sr-only"> {s.intitule}</span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" className="min-h-[44px] xl:min-h-0" disabled={coches.length < MIN || coches.length > MAX || comparer.isPending} onClick={() => comparer.mutate(coches)}>
              {comparer.isPending ? "Comparaison en cours…" : `Comparer les ${coches.length} scénarios cochés`}
            </Button>
            {coches.length < MIN && <span className="text-xs text-gray-700">Cochez au moins {MIN} scénarios.</span>}
            {pages > 1 && (
              <span className="ml-auto flex items-center gap-2 text-sm">
                <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-0" disabled={page <= 1} onClick={() => setPage(page - 1)}>Page précédente</Button>
                <span aria-live="polite">Page {page} sur {pages}</span>
                <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-0" disabled={page >= pages} onClick={() => setPage(page + 1)}>Page suivante</Button>
              </span>
            )}
          </div>
        </div>
      )}

      {comparer.isError && <EtatErreur panneau="Comparaison" erreur={lireErreur(comparer.error, "La comparaison a été refusée.")} />}
      {comparer.data && <ComparaisonTableau comparaison={comparer.data} regions={regions.data ?? []} />}

      {ouvert && (
        <DetailScenarioVue
          id={ouvert} peutEcrire={peutEcrire} droitExport={droitExportScenario(user)} regions={regions.data ?? []} onFerme={() => setOuvert(null)}
          onSupprime={apresSuppression}
        />
      )}
    </section>
  );
}
