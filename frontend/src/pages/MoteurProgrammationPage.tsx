import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calculator } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { messageErreur } from "../lib/exploitation";
import type { StatutPraticabilite } from "../lib/moteurProgrammation";
import { BandeauPraticabilite, BandeauProvisoire } from "./moteur/Bandeaux";
import { FichesFigeesPanel } from "./moteur/FichesFigeesPanel";
import { PlanPluriannuelPanel } from "./moteur/PlanPluriannuelPanel";
import { ScenarioAnnuelPanel } from "./moteur/ScenarioAnnuelPanel";
import { useParametresMoteur } from "./moteur/PerimetreChamps";

/**
 * Moteur de programmation (paragraphe 7.7, A22) : l'ecran du moteur de risque et de programmation.
 *
 * TROIS ONGLETS : le scenario annuel (PAE), le plan pluriannuel (PPE, minimal) et les fiches figees.
 *
 * CE QUE L'ECRAN GARANTIT
 *  - « PROVISOIRE, non approuvé » est visible tant qu'aucune version des parametres n'est approuvee, et sur chaque
 *    resultat provisoire ;
 *  - un resultat ou tous les troncons sont ecartes dit pourquoi (facteurs manquants, minimum requis) ;
 *  - la praticabilite (D-02) dit si elle est branchee : « non branchée : aucune valeur approuvée » sinon ;
 *  - rien n'est officiel, rien n'est engage : aucun marche, ordre de travaux ni engagement n'est cree d'ici.
 */

type Onglet = "scenario" | "plan" | "fiches";
const ONGLETS: { id: Onglet; libelle: string }[] = [
  { id: "scenario", libelle: "Scénario annuel" },
  { id: "plan", libelle: "Plan pluriannuel" },
  { id: "fiches", libelle: "Fiches figées" },
];

export function MoteurProgrammationPage() {
  const { user } = useAuth();
  const peutEcrire = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";
  const [onglet, setOnglet] = useState<Onglet>("scenario");

  const parametres = useParametresMoteur();
  const praticabilite = useQuery({
    queryKey: ["v2", "moteur", "praticabilite"],
    queryFn: async () => (await api.get<StatutPraticabilite>("/v2/programmation/moteur/praticabilite")).data,
  });

  const versions = parametres.data ?? [];
  const aucuneApprouvee = versions.length > 0 && versions.every((v) => v.provisoire);

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-gradient-to-r from-navy via-navy2 to-[#1e3a5f] p-5 text-white">
        <h2 className="flex items-center gap-2 text-xl font-bold"><Calculator className="h-5 w-5 text-gold" aria-hidden="true" />Moteur de programmation</h2>
        <p className="mt-1 text-sm text-white/70">
          Calcul d'un scénario annuel ou d'un plan pluriannuel sous enveloppe, ligne par ligne, avec sa justification. Aucun marché, ordre de travaux ni engagement n'est créé d'ici.
        </p>
      </div>

      {parametres.isLoading && <p role="status" className="text-sm text-gray-700">Chargement des paramètres du moteur…</p>}
      {parametres.isError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">Les paramètres du moteur n'ont pas pu être chargés. {messageErreur(parametres.error, "Réessayez dans un instant.")}</p>}
      {aucuneApprouvee && <BandeauProvisoire etiquette={versions[0].etiquette} detail={`Aucune des ${versions.length} version(s) des paramètres n'est approuvée : toute pondération, correspondance état vers risque et tout seuil est un amorçage de simulation sans source. Les résultats ci-dessous ne sont pas officiels.`} />}
      <BandeauPraticabilite statut={praticabilite.data} />
      {praticabilite.isError && <p role="alert" className="text-sm text-red-800">L'état de la praticabilité (D-02) n'a pas pu être lu : {messageErreur(praticabilite.error, "réessayez.")}</p>}

      <div role="tablist" aria-label="Sections du moteur" className="flex gap-1 border-b">
        {ONGLETS.map((o) => (
          <button key={o.id} id={`onglet-${o.id}`} type="button" role="tab" aria-selected={onglet === o.id} aria-controls={`panneau-${o.id}`} tabIndex={onglet === o.id ? 0 : -1}
            onClick={() => setOnglet(o.id)}
            onKeyDown={(e) => {
              const i = ONGLETS.findIndex((x) => x.id === onglet);
              if (e.key === "ArrowRight") setOnglet(ONGLETS[(i + 1) % ONGLETS.length].id);
              if (e.key === "ArrowLeft") setOnglet(ONGLETS[(i + ONGLETS.length - 1) % ONGLETS.length].id);
            }}
            className={`rounded-t px-4 py-2 text-sm ${onglet === o.id ? "border-x border-t bg-white font-semibold text-navy" : "text-gray-700 hover:bg-gray-50"}`}>
            {o.libelle}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panneau-${onglet}`} aria-labelledby={`onglet-${onglet}`}>
        {onglet === "scenario" && <ScenarioAnnuelPanel parametres={versions} peutEcrire={peutEcrire} praticabiliteBranchee={praticabilite.data?.branchee === true} />}
        {onglet === "plan" && <PlanPluriannuelPanel parametres={versions} peutEcrire={peutEcrire} praticabiliteBranchee={praticabilite.data?.branchee === true} />}
        {onglet === "fiches" && <FichesFigeesPanel />}
      </div>
    </div>
  );
}
