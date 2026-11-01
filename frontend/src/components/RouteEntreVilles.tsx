import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Route as RouteIcon } from "lucide-react";
import { RechercheVille } from "./RechercheVille";
import { ChangerEtatCorridor } from "./ChangerEtatCorridor";
import { EtatBadge } from "./ui/Badge";
import { canWrite, useAuth } from "../lib/auth";
import { chargerChemin, cleChemin, RefusCheminVilles } from "../lib/cheminVilles";
import { libelleKm } from "../lib/releve";
import type { FiltreVille } from "../lib/villes";
import type { EtatPatrimoine } from "../types";

/**
 * Page Tronçons : « la route entre deux villes », tous ses tronçons dans l'ordre.
 *
 * Le besoin (25/10) : lister tous les tronçons entre Sangarédi et Télimélé (ou deux autres villes), et changer l'état de
 * l'ensemble de la route d'un geste. Le serveur suit le RÉSEAU (plus court chemin entre les deux villes dans le référentiel),
 * pas la droite entre elles. Si le référentiel est interrompu entre les deux, l'écran le dit : aucune route inventée.
 * L'état se change tronçon ENTIER : un tronçon parcouru seulement en partie est signalé.
 */
export function RouteEntreVilles() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [ouvert, setOuvert] = useState(false);
  const [filtre, setFiltre] = useState<FiltreVille | null>(null);
  const a = filtre?.a;
  const b = filtre?.b;

  const chemin = useQuery({
    queryKey: a && b ? cleChemin(a, b) : ["chemin-villes", "vide"],
    queryFn: () => chargerChemin(a!, b!),
    enabled: Boolean(a && b),
    retry: false,
    staleTime: 60_000,
  });

  const erreur = chemin.error instanceof RefusCheminVilles ? chemin.error : null;
  const donnees = chemin.data;
  const nbPartiels = donnees?.troncons.filter((t) => t.partiel).length ?? 0;

  return (
    <section aria-labelledby="route-villes" className="mb-4 rounded-lg border border-gray-200 bg-white">
      <h2 id="route-villes" className="m-0">
        <button
          type="button"
          onClick={() => setOuvert((o) => !o)}
          aria-expanded={ouvert}
          className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-navy"
        >
          <RouteIcon className="h-4 w-4" aria-hidden="true" />
          Route entre deux villes
          <span className="ml-1 text-xs font-normal text-gray-600">tous les tronçons de la route, dans l'ordre, et son état d'un geste</span>
          {ouvert ? <ChevronUp className="ml-auto h-4 w-4" aria-hidden="true" /> : <ChevronDown className="ml-auto h-4 w-4" aria-hidden="true" />}
        </button>
      </h2>

      {ouvert && (
        <div className="space-y-3 border-t border-gray-100 px-4 py-3">
          <div className="max-w-xl">
            <RechercheVille onAppliquer={setFiltre} compact />
          </div>

          {filtre && !b && (
            <p role="status" className="text-sm text-amber-900">Choisir une seconde ville pour obtenir la route entre les deux.</p>
          )}

          {a && b && chemin.isLoading && <p role="status" className="text-sm text-gray-700">Calcul de la route {a.nom} ↔ {b.nom}…</p>}

          {erreur && (
            <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <strong>{erreur.code === "AUCUN_CHEMIN" ? "Aucune route continue dans le référentiel entre ces deux villes." : "Route non calculée."}</strong>{" "}
              {erreur.message}
              {erreur.code === "AUCUN_CHEMIN" && " Aucune ligne droite n'est substituée : les tronçons manquants doivent d'abord être saisis."}
            </p>
          )}

          {donnees && a && b && (
            <>
              <p className="text-sm">
                <strong>{a.nom} ↔ {b.nom}</strong> : {donnees.troncons.length} tronçon(s), {libelleKm(donnees.longueurM)} par le réseau
                ({libelleKm(donnees.droiteM)} à vol d'oiseau).
              </p>
              {donnees.avertissements.map((w) => (
                <p key={w} role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">{w}</p>
              ))}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Tronçons de la route {a.nom} vers {b.nom}, dans l'ordre du parcours</caption>
                  <thead className="text-xs text-gray-600">
                    <tr>
                      <th scope="col" className="py-1 pr-3">N°</th>
                      <th scope="col" className="py-1 pr-3">Code</th>
                      <th scope="col" className="py-1 pr-3">Nom</th>
                      <th scope="col" className="py-1 pr-3">Région</th>
                      <th scope="col" className="py-1 pr-3">État</th>
                      <th scope="col" className="py-1 pr-3 text-right">Parcouru</th>
                    </tr>
                  </thead>
                  <tbody>
                    {donnees.troncons.map((t) => (
                      <tr key={t.id} className="border-t border-gray-100">
                        <td className="py-1 pr-3 tabular-nums">{t.ordre}</td>
                        <td className="py-1 pr-3 font-mono text-xs">{t.code}</td>
                        <td className="py-1 pr-3">{t.nom}</td>
                        <td className="py-1 pr-3">{t.region}</td>
                        <td className="py-1 pr-3"><EtatBadge etat={t.etat as EtatPatrimoine} /></td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {libelleKm(t.parcourM)}
                          {t.partiel && <span className="ml-1 text-xs text-amber-900"> sur {libelleKm(t.longueurM)} (partiel)</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {nbPartiels > 0 && (
                <p className="text-xs text-gray-700">
                  {nbPartiels} tronçon(s) ne sont parcourus qu'en partie (la ville est en leur milieu) : changer l'état d'un tronçon change celui du tronçon ENTIER.
                </p>
              )}
              <p className="text-xs text-gray-600">
                Plus court chemin dans le référentiel, réseau non orienté : ce n'est pas « la route officielle » (aucun classement n'est supposé).
                Paramètres provisoires : accrochage des villes à moins de {donnees.parametres.rayonAccrochageM / 1000} km, fusion des extrémités à {donnees.parametres.toleranceFusionM} m.
              </p>
              {canWrite(user?.role) && donnees.troncons.length > 0 && (
                <ChangerEtatCorridor
                  ids={donnees.troncons.map((t) => t.id)}
                  libelle={`${a.nom} ↔ ${b.nom}`}
                  onApplique={() => { void qc.invalidateQueries(); }}
                />
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
