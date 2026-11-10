/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useId, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Filter, FolderPlus, LayoutDashboard, Search, Settings2, X } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { BandeauHorsLigne, EtatChargement, EtatErreur, EtatVide } from "../components/projets-voirie/EtatsPv";
import { DialogueProjet } from "../components/projets-voirie/DialogueProjet";
import { SelecteurTerritoire } from "../components/projets-voirie/territoires/SelecteurTerritoire";
import { LIBELLE_NIVEAU, type Territoire } from "../lib/projetsVoirieTerritoires";
import { useAuth } from "../lib/auth";
import { useEnLigne, useProjets, useValeurDifferee } from "../lib/projetsVoirieHooks";
import { classerErreur, formaterMetres, peutEcrireProjets } from "../lib/projetsVoirie";

/**
 * Liste des projets de voirie et reseaux : recherche, creation, ouverture. Etats : chargement, vide (explique comment commencer), erreur reseau,
 * acces refuse (pas de cle de module), hors ligne. Rien n'est conserve localement.
 */

export function ProjetsVoirieListePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const enLigne = useEnLigne();
  const idRecherche = useId();
  const [saisie, setSaisie] = useState("");
  const q = useValeurDifferee(saisie.trim(), 300);
  const [creation, setCreation] = useState(false);
  // Lot T1 : filtre par territoire (le territoire ET ses descendants, filtre du serveur). Le selecteur ne se charge qu'a l'ouverture du filtre.
  const [filtreOuvert, setFiltreOuvert] = useState(false);
  const [territoire, setTerritoire] = useState<Territoire | null>(null);
  const requete = useProjets(q, territoire?.id ?? null);
  const projets = requete.data?.pages.flatMap((p) => p.projets) ?? [];
  const peutEcrire = peutEcrireProjets(user?.role);
  const erreur = requete.isError ? classerErreur(requete.error) : null;
  // Un compte rattache a un concessionnaire (referent) n'ouvre que l'ecran des echanges : redirection, sans message d'erreur brut.
  if (erreur?.code === "COMPTE_REFERENT_RESTREINT") return <Navigate to="/projets-voirie/echanges" replace />;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-navy">Projets de voirie et réseaux</h1>
          <p className="text-sm text-gray-600">Plans d&apos;axes de travaux, réseaux des concessionnaires et limites de route, avec une analyse indicative des proximités et des conflits potentiels.</p>
          <p className="mt-1 text-xs text-gray-600">L&apos;analyse est une aide à la décision, jamais un verdict : ses largeurs sont théoriques tant qu&apos;elles ne sont pas validées.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" className="min-h-[44px] xl:min-h-9">
            <Link to="/projets-voirie/tableau-de-bord"><LayoutDashboard aria-hidden="true" /> Tableau de bord</Link>
          </Button>
          <Button asChild variant="outline" className="min-h-[44px] xl:min-h-9">
            <Link to="/projets-voirie/parametres"><Settings2 aria-hidden="true" /> Paramètres du module</Link>
          </Button>
          {peutEcrire && (
            <Button type="button" className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => setCreation(true)}>
              <FolderPlus aria-hidden="true" /> Nouveau projet
            </Button>
          )}
        </div>
      </header>

      {!enLigne && <BandeauHorsLigne />}

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-md">
          <label htmlFor={idRecherche} className="block text-sm font-medium text-gray-900">Rechercher un projet</label>
          <div className="relative mt-1">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
            <Input id={idRecherche} type="search" value={saisie} onChange={(e) => setSaisie(e.target.value)} placeholder="Code, nom ou commune" autoComplete="off" maxLength={100} className="border-gray-300 pl-9" />
          </div>
        </div>
        <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" aria-expanded={filtreOuvert} aria-controls="pv-filtre-territoire" onClick={() => setFiltreOuvert((o) => !o)}>
          <Filter aria-hidden="true" /> {filtreOuvert ? "Masquer le filtre par territoire" : "Filtrer par territoire"}
        </Button>
      </div>
      {territoire && (
        <p data-testid="filtre-territoire-actif" className="flex flex-wrap items-center gap-2 text-sm text-gray-900">
          <span>Territoire : <strong>{territoire.nom}</strong> ({LIBELLE_NIVEAU[territoire.niveau]}), avec ses subdivisions.</span>
          <Button type="button" size="sm" variant="ghost" className="min-h-[44px] xl:min-h-8" onClick={() => setTerritoire(null)}><X aria-hidden="true" /> Retirer le filtre</Button>
        </p>
      )}
      {filtreOuvert && (
        <div id="pv-filtre-territoire" className="max-w-2xl">
          <SelecteurTerritoire libelle="Filtrer par territoire" valeur={territoire?.id ?? null} onChange={setTerritoire} optionAucun="Tous les territoires"
            aide="Un territoire comprend ses subdivisions : une région montre aussi les projets de ses préfectures et communes." />
        </div>
      )}

      {requete.isPending && <EtatChargement libelle="Chargement des projets…" />}
      {erreur && <EtatErreur erreur={erreur} sujet="Liste des projets" onReessayer={() => void requete.refetch()} enCours={requete.isFetching} />}

      {requete.isSuccess && projets.length === 0 && (
        q || territoire ? (
          <EtatVide titre="Aucun projet ne correspond à cette recherche">
            <p>Vérifiez l&apos;orthographe, ou effacez la recherche pour revoir tous les projets.</p>
          </EtatVide>
        ) : (
          <EtatVide titre="Aucun projet pour l'instant">
            <p>Un projet réunit trois sortes de fichiers : le plan d&apos;axes de l&apos;entreprise, les réseaux des concessionnaires et les limites de route.</p>
            <p>{peutEcrire ? "Pour commencer, créez un projet avec « Nouveau projet », puis déposez vos fichiers KML ou GeoJSON depuis sa page. Chaque fichier est d'abord simulé, puis reçu, puis autorisé." : "Demandez à un gestionnaire ou à un administrateur de créer le premier projet."}</p>
          </EtatVide>
        )
      )}

      {projets.length > 0 && (
        <div role="region" aria-label="Projets de voirie, tableau défilant" tabIndex={0} className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <caption className="sr-only">Projets de voirie et réseaux</caption>
            <thead className="bg-gray-100 text-gray-800">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">Projet</th>
                <th scope="col" className="px-3 py-2 font-semibold">Territoire</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Jeux autorisés</th>
                <th scope="col" className="px-3 py-2 font-semibold">Largeurs de calcul</th>
              </tr>
            </thead>
            <tbody>
              {projets.map((p) => (
                <tr key={p.id} className="border-t border-gray-200 align-top">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    <Link to={`/projets-voirie/${encodeURIComponent(p.id)}`} className="block min-h-[44px] break-words font-semibold text-navy underline xl:min-h-0">
                      {p.nom}<span className="sr-only"> ({p.code})</span>
                    </Link>
                    <span className="block text-xs text-gray-600" aria-hidden="true">{p.code}</span>
                  </th>
                  <td className="px-3 py-2 text-gray-800">
                    {p.territoire ? <span className="block">{p.territoire.nom} <span className="text-xs text-gray-600">({LIBELLE_NIVEAU[p.territoire.niveau]})</span></span> : null}
                    <span className={p.territoire ? "block text-xs text-gray-600" : undefined}>{[p.commune, p.prefecture].filter(Boolean).join(", ") || (p.territoire ? "" : "Non renseignée")}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {p.nbJeux === null ? "n/d" : Object.keys(p.jeuxParStatut).length > 0 ? (p.jeuxParStatut.AUTORISE ?? 0) : p.nbJeux}
                    {peutEcrire && (p.jeuxParStatut.CONTROLE ?? 0) + (p.jeuxParStatut.RECU ?? 0) > 0 && (
                      <span className="block text-xs font-semibold text-amber-900">et {(p.jeuxParStatut.CONTROLE ?? 0) + (p.jeuxParStatut.RECU ?? 0)} à autoriser</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-800">
                    Chaussée {formaterMetres(p.largeurChausseeM)}, emprise {formaterMetres(p.largeurEmpriseM)}{" "}
                    <span className={p.statutParametres === "VALIDE" ? "font-semibold text-green-800" : "font-semibold text-amber-900"}>
                      ({p.statutParametres === "VALIDE" ? "validées" : "théoriques"})
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {requete.hasNextPage && (
        <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" disabled={requete.isFetchingNextPage} onClick={() => void requete.fetchNextPage()}>
          {requete.isFetchingNextPage ? "Chargement…" : "Charger plus de projets"}
        </Button>
      )}

      {creation && <DialogueProjet enLigne={enLigne} onFermer={() => setCreation(false)} onCree={(p) => { setCreation(false); navigate(`/projets-voirie/${encodeURIComponent(p.id)}`); }} />}
    </div>
  );
}
