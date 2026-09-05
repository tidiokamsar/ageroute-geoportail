import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Calculator, CalendarOff, HelpCircle, ShieldCheck, XCircle } from "lucide-react";
import { api } from "../lib/api";
import type { StatutValeur } from "../components/QualiteBadge";

/**
 * Ce que la base sait reellement, et ce qu'elle ignore.
 *
 * POURQUOI CET ECRAN
 *
 * L'appareil de tracabilite existait — 1,2 million de lignes de `valeurs_qualite`,
 * une API de repartition, un badge par valeur dans les fiches — mais aucune vue
 * d'ensemble. On pouvait verifier une valeur a la fois, jamais savoir ou se
 * concentrer.
 *
 * Il ne sert donc pas a rassurer. Il sert a decider ou envoyer les inspecteurs : les
 * champs les plus rouges sont ceux dont dependent les decisions les moins fondees.
 *
 * CE QU'IL AFFICHE ET QUI SURPREND
 *
 * Un tableau de qualite ordinaire compte les valeurs non nulles et annonce
 * « revetement : 100 % renseigne ». C'est exact et sans interet : le champ vaut
 * BITUME partout parce qu'une colonne obligatoire a ete remplie a l'import.
 *
 * Ici, un champ rempli mais jamais verifie compte comme non fiable, et un champ sur
 * lequel AUCUNE ligne de qualite n'existe apparait quand meme — a zero. Une dimension
 * dont on ne sait rien ne doit pas se lire comme une dimension sans probleme.
 */

interface RepartitionChamp {
  champ: string;
  total: number;
  parStatut: Partial<Record<StatutValeur, number>>;
  datees: number;
}

interface Repartition {
  entityType: string;
  champs: RepartitionChamp[];
  fraicheur: { datees: number; total: number; pct: number };
}

/**
 * Ecart entre le referentiel des regions et les limites administratives chargees.
 *
 * Le decret du 05/09/2026 cree les regions de Siguiri et de Beyla : elles figurent au
 * referentiel, aucune limite ne les couvre. Ce n'est pas une panne — la carte cesse
 * d'y poser des epingles et la liste « sans localisation » recueille leurs chantiers.
 * C'est une dette, et elle n'apparaissait nulle part.
 */
interface ReferentielAdmin {
  regions: { nom: string; aUneLimite: boolean; objetsRattaches: number }[];
  limites: { niveau: number; entites: number }[];
  ecart: { regionsSansLimite: string[]; objetsConcernes: number; resolution: string | null };
}

const NIVEAU_LIBELLE: Record<number, string> = {
  1: "Régions", 2: "Préfectures", 3: "Sous-préfectures",
};

function EcartReferentiel() {
  const { data, isLoading } = useQuery<ReferentielAdmin>({
    queryKey: ["referentiel-administratif"],
    queryFn: async () => (await api.get("/qualite/referentiel-administratif")).data,
  });

  if (isLoading || !data) return null;

  const manquantes = data.ecart.regionsSansLimite;
  const bloquant = data.ecart.objetsConcernes > 0;

  return (
    <section
      className={`rounded-jeton-md border p-4 ${
        manquantes.length === 0
          ? "border-etat-bon/30 bg-etat-bon-fond"
          : bloquant
            ? "border-etat-mauvais/40 bg-etat-mauvais-fond"
            : "border-etat-moyen/40 bg-etat-moyen-fond"
      }`}
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold text-navy">
        {manquantes.length === 0
          ? <ShieldCheck className="h-4 w-4 text-etat-bon" aria-hidden="true" />
          : <AlertTriangle className={`h-4 w-4 ${bloquant ? "text-etat-mauvais" : "text-etat-moyen"}`} aria-hidden="true" />}
        Découpage administratif
      </h2>

      {manquantes.length === 0 ? (
        <p className="mt-1 text-[13px] text-slate-700">
          Chaque région du référentiel dispose de sa limite officielle.
        </p>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-slate-700">
            <strong className="chiffres">{manquantes.length}</strong>{" "}
            {manquantes.length > 1 ? "régions n'ont" : "région n'a"} pas de limite chargée :{" "}
            <strong>{manquantes.join(", ")}</strong>.
          </p>
          <p className="mt-1 text-[13px] text-slate-700">
            {bloquant ? (
              <>
                <strong className="chiffres">{data.ecart.objetsConcernes}</strong> objets y sont
                rattachés : ils sortent de la carte et figurent dans la liste des chantiers sans
                localisation.
              </>
            ) : (
              // Distinguer les deux situations : une region vide n'empeche rien
              // aujourd'hui, et presenter les deux en rouge banaliserait l'alerte.
              <>Aucun objet n'y est rattaché : rien n'est masqué à ce jour.</>
            )}
          </p>
          {data.ecart.resolution && (
            <p className="mt-2 text-[12px] italic text-slate-600">{data.ecart.resolution}</p>
          )}
        </>
      )}

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-slate-600">
        {data.limites.map((l) => (
          <div key={l.niveau} className="flex gap-1.5">
            <dt>{NIVEAU_LIBELLE[l.niveau] ?? `Niveau ${l.niveau}`} :</dt>
            <dd className="chiffres font-medium text-navy">{l.entites}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const ENTITES = [
  { cle: "Troncon", libelle: "Tronçons" },
  { cle: "Ouvrage", libelle: "Ouvrages d'art" },
  { cle: "Chantier", libelle: "Chantiers" },
] as const;

const LIBELLE_CHAMP: Record<string, string> = {
  etat: "État de la chaussée",
  longueurKm: "Longueur",
  revetement: "Revêtement",
  traficMoyenJma: "Trafic moyen",
  criticiteStrategique: "Criticité stratégique",
  coutRehabEstime: "Coût de réhabilitation",
};

/**
 * Ordre de lecture : du plus solide au plus creux.
 *
 * Il commande aussi l'empilement de la barre, pour qu'on lise de gauche a droite ce
 * qui va du su au suppose.
 */
const ORDRE: { statut: StatutValeur; libelle: string; couleur: string; icone: typeof ShieldCheck }[] = [
  { statut: "OBSERVED", libelle: "Constaté", couleur: "#059669", icone: ShieldCheck },
  { statut: "DERIVED", libelle: "Calculé", couleur: "#0284c7", icone: Calculator },
  { statut: "IMPORTED_UNVERIFIED", libelle: "Importé, non vérifié", couleur: "#d97706", icone: AlertTriangle },
  { statut: "CONFLICTING", libelle: "Contredit", couleur: "#dc2626", icone: XCircle },
  { statut: "UNKNOWN", libelle: "Inconnu", couleur: "#9ca3af", icone: HelpCircle },
];

/** Part des valeurs sur lesquelles une decision peut s'appuyer sans reserve. */
function partFiable(c: RepartitionChamp): number {
  if (c.total === 0) return 0;
  return Math.round(((c.parStatut.OBSERVED ?? 0) / c.total) * 100);
}

function Barre({ c }: { c: RepartitionChamp }) {
  if (c.total === 0) {
    return (
      <div className="flex h-2.5 w-full items-center rounded-full bg-slate-100">
        <span className="sr-only">Aucune ligne de qualité</span>
      </div>
    );
  }
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100" role="img"
      aria-label={ORDRE.filter((o) => c.parStatut[o.statut])
        .map((o) => `${o.libelle} ${c.parStatut[o.statut]}`).join(", ")}>
      {ORDRE.map((o) => {
        const n = c.parStatut[o.statut] ?? 0;
        if (n === 0) return null;
        return (
          <span
            key={o.statut}
            style={{ width: `${(n / c.total) * 100}%`, backgroundColor: o.couleur }}
            title={`${o.libelle} — ${n.toLocaleString("fr-FR")}`}
          />
        );
      })}
    </div>
  );
}

export function QualitePage() {
  const [entite, setEntite] = useState<string>("Troncon");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["qualite", "repartition", entite],
    queryFn: async () =>
      (await api.get<Repartition>("/qualite/repartition", { params: { entityType: entite } })).data,
  });

  const champs = data?.champs ?? [];
  const pire = [...champs].filter((c) => c.total > 0).sort((a, b) => partFiable(a) - partFiable(b))[0];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-navy">Qualité des données</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Ce que la base sait réellement, champ par champ. Un champ rempli n'est pas un
          champ renseigné : une valeur posée par un import et jamais vérifiée compte ici
          comme non fiable.
        </p>
      </header>

      <EcartReferentiel />

      <div className="flex flex-wrap gap-2">
        {ENTITES.map((e) => (
          <button
            key={e.cle}
            type="button"
            onClick={() => setEntite(e.cle)}
            className={
              "rounded-full px-3 py-1.5 text-sm font-medium transition " +
              (entite === e.cle
                ? "bg-navy text-white"
                : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50")
            }
          >
            {e.libelle}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-slate-500">Chargement…</p>}
      {isError && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          Impossible de charger la répartition.
        </p>
      )}

      {data && (
        <>
          {/* La fraicheur en tete : c'est la dimension la plus degradee, et une
              moyenne des autres statuts la masquerait. */}
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-start gap-3">
              <CalendarOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
              <div>
                <p className="text-sm font-semibold text-navy">
                  {data.fraicheur.pct.toLocaleString("fr-FR")} % des valeurs portent une date de constat
                </p>
                <p className="mt-0.5 text-[13px] leading-snug text-slate-600">
                  {data.fraicheur.datees.toLocaleString("fr-FR")} sur{" "}
                  {data.fraicheur.total.toLocaleString("fr-FR")}. Sans date, deux valeurs ne
                  sont pas comparables : un « bon état » de cette année et un « bon état »
                  d'il y a dix ans occupent la même case.
                </p>
              </div>
            </div>
          </div>

          {pire && (
            <div className="rounded-lg border-l-4 border-amber-500 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">
                Où porter l'effort en premier : {LIBELLE_CHAMP[pire.champ] ?? pire.champ}
              </p>
              <p className="mt-0.5 text-[13px] leading-snug text-amber-800">
                {partFiable(pire)} % seulement des valeurs sont constatées, sur{" "}
                {pire.total.toLocaleString("fr-FR")} enregistrées.
              </p>
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2 font-semibold">Champ</th>
                  <th className="px-4 py-2 font-semibold">Répartition</th>
                  <th className="px-4 py-2 text-right font-semibold">Constaté</th>
                  <th className="px-4 py-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {champs.map((c) => (
                  <tr key={c.champ} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-navy">
                      {LIBELLE_CHAMP[c.champ] ?? c.champ}
                    </td>
                    <td className="px-4 py-3">
                      <Barre c={c} />
                      {c.total === 0 && (
                        <p className="mt-1 text-[11px] italic text-slate-400">
                          Aucune ligne de qualité — on ne sait rien de ce champ.
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {c.total === 0 ? "—" : `${partFiable(c)} %`}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                      {c.total.toLocaleString("fr-FR")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-slate-600">
            {ORDRE.map((o) => (
              <span key={o.statut} className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: o.couleur }} />
                {o.libelle}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
