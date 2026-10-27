import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { messageErreur } from "../lib/exploitation";

/**
 * Tableau de bord du référentiel des tronçons (BDRI, lot B), sur `GET /api/v2/referentiel/troncons/synthese`.
 *
 * Peu de chiffres, chacun avec son périmètre : le RÉSEAU CLASSÉ (comme la liste). Le nombre de tronçons est compté
 * par le serveur. Les deux longueurs ne s'additionnent pas : la déclarée est saisie, celle du tracé est mesurée
 * (méthode affichée). Les manques (PK, tracé) sont des liens qui appliquent le filtre correspondant à la liste ;
 * les anomalies renvoient au registre, avec la date de la dernière analyse (sans analyse, le registre est vide et
 * l'écran le dit, au lieu d'afficher « 0 anomalie »).
 */

interface Ventilation { cle: string; troncons: number; kmDeclares: number }
interface Synthese {
  troncons: number;
  longueur: { declareeKm: number; geometriqueKm: number; methodeGeometrique: string; tronconsSansGeometrie: number };
  completude: { pkNonRenseignes: number; sansGeometrie: number; geometriesInvalides: number; classeNonRenseignee: number; revetementNonRenseigne: number; etatNonEvalue: number };
  parRegion: Ventilation[]; parClasse: Ventilation[]; parRevetement: Ventilation[]; parEtat: Ventilation[]; validation: Ventilation[];
  registre: { derniereAnalyse: string | null; ouvertes: number; doublonsPotentiels: number };
  activite: { inspections90j: number; chantiersEnCours: number };
}

const nf = (v: number, d = 0) => v.toLocaleString("fr-FR", { maximumFractionDigits: d });
const LIBELLES: Record<string, string> = {
  RN: "Route nationale", RR: "Route préfectorale", RU: "Voirie urbaine", PISTE: "Piste rurale", NON_CLASSEE: "Non classée",
  BITUME: "Bitume", TERRE: "Terre", LATERITE: "Latérite", PAVE: "Pavé", NON_RENSEIGNE: "Non renseigné",
  BON: "Bon", MOYEN: "Moyen", MAUVAIS: "Mauvais", CRITIQUE: "Critique", NON_EVALUE: "Non évalué",
  VALIDE: "Validé", A_VALIDER: "À valider", REJETE: "Rejeté", A_CORRIGER: "À corriger",
};

function Chiffre({ libelle, valeur, detail, action }: { libelle: string; valeur: string; detail?: string; action?: React.ReactNode }) {
  return (
    <div className="min-w-[8.5rem] flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-gray-600">{libelle}</p>
      <p className="text-lg font-semibold text-navy tabular-nums">{valeur}</p>
      {detail && <p className="text-[11px] text-gray-600">{detail}</p>}
      {action}
    </div>
  );
}

function Table({ titre, lignes }: { titre: string; lignes: Ventilation[] }) {
  return (
    <table className="w-full text-xs">
      <caption className="pb-1 text-left font-medium text-gray-700">{titre}</caption>
      <thead><tr className="text-left text-gray-600"><th className="font-normal">Valeur</th><th className="text-right font-normal">Tronçons</th><th className="text-right font-normal">km déclarés</th></tr></thead>
      <tbody>
        {lignes.map((l) => (
          <tr key={l.cle} className="border-t border-gray-100">
            <td>{LIBELLES[l.cle] ?? l.cle}</td><td className="text-right tabular-nums">{nf(l.troncons)}</td><td className="text-right tabular-nums">{nf(l.kmDeclares, 1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SyntheseReferentiel({ regionId, onFiltre }: { regionId?: number; onFiltre: (cle: "pk" | "geometrie", valeur: string) => void }) {
  const q = useQuery({
    queryKey: ["referentiel", "synthese", regionId ?? null],
    queryFn: async () => (await api.get<Synthese>("/v2/referentiel/troncons/synthese", { params: regionId ? { regionId } : {} })).data,
    staleTime: 60_000,
  });
  if (q.isLoading) return <p className="text-sm text-gray-500">Synthèse du référentiel…</p>;
  if (q.isError || !q.data) return <p className="text-sm text-amber-800">{messageErreur(q.error, "Synthèse du référentiel indisponible.")}</p>;
  const s = q.data;
  const lien = (cle: "pk" | "geometrie", valeur: string, n: number) => n > 0 && (
    <button type="button" className="text-[11px] text-navy underline" onClick={() => onFiltre(cle, valeur)}>Afficher dans la liste</button>
  );
  return (
    <section aria-labelledby="titre-synthese" className="space-y-2" data-testid="synthese-referentiel">
      <h2 id="titre-synthese" className="text-sm font-semibold text-gray-700">Référentiel {regionId ? "de la région" : "du réseau classé"}</h2>
      <div className="flex flex-wrap gap-2">
        <Chiffre libelle="Tronçons" valeur={nf(s.troncons)} detail="réseau classé, compté en base" />
        <Chiffre libelle="Longueur déclarée" valeur={`${nf(s.longueur.declareeKm, 1)} km`} detail="saisie, somme des tronçons" />
        <Chiffre libelle="Longueur du tracé" valeur={`${nf(s.longueur.geometriqueKm, 1)} km`} detail={`${s.longueur.methodeGeometrique} ; ${nf(s.longueur.tronconsSansGeometrie)} sans tracé`} />
        <Chiffre libelle="PK non renseignés" valeur={nf(s.completude.pkNonRenseignes)} action={lien("pk", "non_renseigne", s.completude.pkNonRenseignes)} />
        <Chiffre libelle="Sans tracé" valeur={nf(s.completude.sansGeometrie)} detail={`${nf(s.completude.geometriesInvalides)} tracé(s) invalide(s)`} action={lien("geometrie", "absente", s.completude.sansGeometrie)} />
        <Chiffre
          libelle="Anomalies à traiter"
          valeur={s.registre.derniereAnalyse ? nf(s.registre.ouvertes) : "—"}
          detail={s.registre.derniereAnalyse ? `${nf(s.registre.doublonsPotentiels)} doublon(s) potentiel(s) · analyse du ${new Date(s.registre.derniereAnalyse).toLocaleDateString("fr-FR")}` : "aucune analyse enregistrée"}
          action={<Link className="text-[11px] text-navy underline" to="/troncons/audit">Ouvrir le registre</Link>}
        />
        <Chiffre libelle="Activité" valeur={`${nf(s.activite.chantiersEnCours)} chantier(s)`} detail={`en cours · ${nf(s.activite.inspections90j)} inspection(s) sur 90 jours`} />
      </div>
      <details className="rounded-lg border border-gray-200 bg-white p-2">
        <summary className="cursor-pointer text-sm text-gray-700">Répartitions (région, classe, revêtement, état, validation)</summary>
        <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Table titre="Par région" lignes={s.parRegion} />
          <Table titre="Par classe" lignes={s.parClasse} />
          <Table titre="Par revêtement" lignes={s.parRevetement} />
          <Table titre="Par état" lignes={s.parEtat} />
          <Table titre="Par statut de validation" lignes={s.validation} />
        </div>
        <p className="mt-2 text-[11px] text-gray-600">
          Non renseignés : {nf(s.completude.classeNonRenseignee)} classe(s), {nf(s.completude.revetementNonRenseigne)} revêtement(s), {nf(s.completude.etatNonEvalue)} état(s) non évalué(s).
        </p>
      </details>
    </section>
  );
}
