import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { toast } from "../../../lib/toast";
import {
  MENTION_SIMULATION, construireDemande, droitExportScenario, formulaireVide, relancer, validerPeriode,
  type DemandeSimulateur, type FormulaireSimulation, type ScenarioSim,
} from "../../../lib/aideDecisionScenarios";
import { chargerCandidats, chargerOptions, enregistrerScenario, remettreFichier, simuler, telechargerExport } from "../../../lib/aideDecisionScenariosApi";
import { useParametresMoteur } from "../../../pages/moteur/PerimetreChamps";
import type { Region } from "../../../types";
import type { PropsOnglet } from "../types";
import { ActionsScenario, type ScenarioEnregistre } from "../simulation/ActionsScenario";
import { BandeauNonEngageant, EtatChargement, EtatErreur, lireErreur } from "../simulation/EtatsSimulation";
import { FormulaireSimulationVue } from "../simulation/FormulaireSimulation";
import { ResultatSimulationVue } from "../simulation/ResultatSimulationVue";

/**
 * Onglet « Simulation budgetaire » : saisir une enveloppe en GNF et une periode, choisir la logique de priorite, les baremes et les
 * interventions candidates, poser des contraintes, simuler, lire le resultat (consomme, reste, deficit, retenues et exclues,
 * kilometres, distribution territoriale, avertissements), enregistrer sous un nom et exporter.
 *
 * UNE SIMULATION N'ENGAGE RIEN : « simulation non engageante » est visible en permanence. Aucune donnee officielle (budget,
 * marche, chantier, bareme) n'est modifiee ; seul l'enregistrement d'un scenario ecrit, dans la table des scenarios.
 * Le serveur decide de tout (droits, perimetre, calcul) ; l'ecran valide la saisie et dit ce qu'il recoit.
 */
export function OngletSimulation({ filtres }: PropsOnglet) {
  const { user } = useAuth();
  const peutEcrire = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";
  const [form, setForm] = useState<FormulaireSimulation>(() => ({
    ...formulaireVide(new Date().getFullYear()),
    regionId: filtres.regionId ? String(filtres.regionId) : "",
    classe: filtres.classe && filtres.classe.length === 1 ? filtres.classe[0] : "",
  }));
  const [tentative, setTentative] = useState(false);
  const [calcul, setCalcul] = useState<{ resultat: ScenarioSim; demande: string } | null>(null);
  const [enregistre, setEnregistre] = useState<ScenarioEnregistre | null>(null);

  // Les filtres partages (region, classe) donnent le perimetre de depart ; un changement ulterieur du filtre repart de zero.
  useEffect(() => {
    setForm((f) => (
      (f.regionId === (filtres.regionId ? String(filtres.regionId) : f.regionId) && f.classe === (filtres.classe && filtres.classe.length === 1 ? filtres.classe[0] : f.classe))
        ? f
        : { ...f, regionId: filtres.regionId ? String(filtres.regionId) : f.regionId, classe: filtres.classe && filtres.classe.length === 1 ? filtres.classe[0] : f.classe, selection: null, obligatoires: [], groupes: [], ordrePersonnalise: [] }
    ));
  }, [filtres.regionId, filtres.classe]);

  const regions = useQuery({ queryKey: ["regions"], queryFn: async () => (await api.get<Region[]>("/regions")).data, retry: relancer });
  const parametres = useParametresMoteur();
  const periode = validerPeriode(form.debut, form.fin);
  const options = useQuery({
    queryKey: ["ad", "scenarios", "options", form.debut, form.fin], enabled: periode.ok,
    queryFn: () => chargerOptions({ debut: form.debut, fin: form.fin }), retry: relancer,
  });
  const regionNum = form.regionId ? Number(form.regionId) : undefined;
  const candidats = useQuery({
    queryKey: ["ad", "scenarios", "candidats", regionNum ?? null, form.classe || null],
    queryFn: () => chargerCandidats({ regionId: regionNum, classe: form.classe || undefined }), retry: relancer,
  });

  const verdict = useMemo(() => construireDemande(form), [form]);
  const erreurs = verdict.ok ? {} : verdict.erreurs;

  const calculer = useMutation({
    mutationFn: async (d: DemandeSimulateur) => simuler(d),
    onSuccess: (r, d) => { setCalcul({ resultat: r.resultat, demande: JSON.stringify(d) }); setEnregistre(null); },
  });

  const enregistrer = useMutation({
    mutationFn: async (nom: string) => {
      if (!verdict.ok) throw new Error("Saisie invalide.");
      return enregistrerScenario(verdict.demande, nom);
    },
    onSuccess: (r) => {
      setCalcul((c) => ({ resultat: r.resultat, demande: c?.demande ?? "" }));
      setEnregistre({ id: r.scenario.id, intitule: r.scenario.intitule, creeLe: r.scenario.creeLe, auteurNom: user?.nomComplet ?? null, creeParId: r.scenario.creeParId, empreinteResultat: r.scenario.empreinteResultat });
      toast.success("Scénario enregistré (immuable, audité).");
    },
  });

  const exporter = useMutation({
    mutationFn: async (format: "csv" | "json") => {
      if (!enregistre) throw new Error("Enregistrez d'abord le scénario.");
      const f = await telechargerExport(enregistre.id, format);
      remettreFichier(f.blob, f.nom);
    },
  });

  const lancer = () => {
    setTentative(true);
    if (!verdict.ok || !peutEcrire) return;
    calculer.mutate(verdict.demande);
  };

  const perime = calcul !== null && verdict.ok && calcul.demande !== "" && JSON.stringify(verdict.demande) !== calcul.demande;
  const mention = options.data?.mention ?? MENTION_SIMULATION;

  return (
    <section aria-labelledby="simulation-titre" className="space-y-4">
      <div>
        <h3 id="simulation-titre" className="text-lg font-semibold text-navy">Simulation budgétaire</h3>
        <p className="text-sm text-gray-700">Répartissez une enveloppe entre des interventions candidates selon une logique de priorité, avec des barèmes et des contraintes explicites.</p>
      </div>
      <BandeauNonEngageant mention={mention} />

      <FormulaireSimulationVue
        form={form} onForm={setForm} erreurs={erreurs} tentative={tentative}
        options={options.data} optionsChargement={options.isLoading} optionsErreur={options.isError ? lireErreur(options.error) : null} onReessayerOptions={() => void options.refetch()}
        candidats={candidats.data} candidatsChargement={candidats.isLoading} candidatsErreur={candidats.isError ? lireErreur(candidats.error) : null} onReessayerCandidats={() => void candidats.refetch()}
        parametres={parametres.data ?? []} regions={regions.data ?? []} onSimuler={lancer} enCours={calculer.isPending} peutEcrire={peutEcrire}
      />

      {calculer.isPending && <EtatChargement libelle="Simulation en cours…" />}
      {calculer.isError && <EtatErreur panneau="Simulation" erreur={lireErreur(calculer.error, "Le calcul a été refusé.")} onReessayer={lancer} reessaiEnCours={calculer.isPending} />}

      {calcul && (
        <div className="space-y-2" aria-live="polite">
          {perime && <p role="status" data-testid="resultat-perime" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">La saisie a changé depuis ce calcul : le résultat ci-dessous ne lui correspond plus. Relancez la simulation.</p>}
          <ResultatSimulationVue
            resultat={calcul.resultat} regions={regions.data ?? []}
            actions={(
              <ActionsScenario
                peutEcrire={peutEcrire} enregistre={enregistre} onEnregistrer={(nom) => enregistrer.mutate(nom)} enregistrement={enregistrer.isPending}
                erreurEnregistrement={enregistrer.isError ? lireErreur(enregistrer.error, "L'enregistrement a été refusé.") : null}
                onExporter={(f) => exporter.mutate(f)} exportEnCours={exporter.isPending} erreurExport={exporter.isError ? lireErreur(exporter.error, "L'export a échoué.") : null} droitExport={droitExportScenario(user)}
              />
            )}
          />
        </div>
      )}
      {!calcul && !calculer.isPending && !calculer.isError && (
        <p className="text-sm text-gray-700" data-testid="aide-simulation">Aucun résultat pour l'instant : renseignez l'enveloppe, la période et la logique, puis lancez la simulation. Rien n'est calculé ni proposé d'avance.</p>
      )}
    </section>
  );
}
