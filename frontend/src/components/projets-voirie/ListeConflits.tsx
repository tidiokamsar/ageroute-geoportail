import { useId, useMemo, useState } from "react";
import type { UseInfiniteQueryResult, InfiniteData } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, RotateCcw, Search } from "lucide-react";
import { Button } from "../ui/Button";
import { Input, Select } from "../ui/Input";
import { EtatErreur, EtatVide } from "./EtatsPv";
import { BadgeEcheanceDepassee, BadgeReexamen, BadgeRisque, BadgeStatutConflit, BadgeTypeConflit } from "./BadgesConflit";
import type { Concessionnaire } from "../../lib/projetsVoirieApi";
import type { ConflitResume, PageConflits } from "../../lib/projetsVoirieConflitsApi";
import {
  FILTRES_VIDES, LIBELLE_TRI, LIBELLE_TYPE_CONFLIT, STATUTS_CONFLIT, STYLE_STATUT_CONFLIT, TYPES_CONFLIT, echeanceDepassee, nbFiltresActifs, trierConflits,
  classerErreurConflit,
  type FiltresConflits, type StatutConflit, type TriConflit,
} from "../../lib/projetsVoirieConflits";
import { formaterDate, formaterMetres, formaterNombre } from "../../lib/projetsVoirie";

/**
 * Liste des conflits : compteurs par statut (boutons a bascule), recherche, filtres (type, axe, concessionnaire, responsable, a reexaminer,
 * echeance depassee), tri, curseur. Etats : chargement, erreur (403, 404, 503, 504 expliques), vide (aucun conflit, ou aucun resultat).
 *
 * Le tri s'applique aux conflits DEJA CHARGES (le contrat n'a pas de parametre de tri) : la page le dit.
 * « Aucun conflit » ne signifie jamais « aucun reseau » : le bandeau permanent de l'onglet le rappelle.
 */

export type RequeteConflits = UseInfiniteQueryResult<InfiniteData<PageConflits>, unknown>;

export interface PropsListeConflits {
  requete: RequeteConflits;
  filtres: FiltresConflits;
  onFiltres: (f: FiltresConflits) => void;
  conflits: ConflitResume[];
  compteurs: PageConflits["compteurs"];
  ignores: number;
  selectionId: string | null;
  onOuvrir: (c: ConflitResume) => void;
  concessionnaires: Concessionnaire[];
  userId: string | undefined;
  nomUtilisateur: string | undefined;
}

function Resume({ c }: { c: ConflitResume }) {
  const m = c.mesure;
  const morceaux = [
    m.longueurChausseeM !== null ? `chaussée ${formaterMetres(m.longueurChausseeM)}` : null,
    m.longueurEmpriseM !== null ? `emprise ${formaterMetres(m.longueurEmpriseM)}` : null,
    m.distanceMinM !== null ? `distance minimale ${formaterMetres(m.distanceMinM)}` : null,
    m.nbCroisements !== null ? `${formaterNombre(m.nbCroisements, 0)} croisement(s)` : null,
  ].filter(Boolean);
  return <>{morceaux.length > 0 ? morceaux.join(" · ") : "Mesure non fournie"}</>;
}

function LigneConflit({ c, actif, onOuvrir }: { c: ConflitResume; actif: boolean; onOuvrir: (c: ConflitResume) => void }) {
  const depassee = echeanceDepassee(c.echeance, c.statut);
  return (
    <li>
      <button
        type="button" onClick={() => onOuvrir(c)} aria-current={actif ? "true" : undefined} data-conflit-id={c.id}
        className={`flex min-h-[44px] w-full flex-col gap-1 rounded border p-2 text-left text-xs hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy ${actif ? "border-2 border-navy bg-blue-50" : "border-gray-300 bg-white"}`}
      >
        <span className="flex flex-wrap items-center gap-1">
          <BadgeStatutConflit statut={c.statut} />
          <BadgeTypeConflit type={c.type} />
          {c.aReexaminer && <BadgeReexamen motif={c.motifReexamen} />}
          {depassee && <BadgeEcheanceDepassee />}
        </span>
        <span className="break-words font-medium text-gray-900">
          {c.axe ?? "Axe non précisé"}{c.concessionnaire ? ` · ${c.concessionnaire.nom ?? "Concessionnaire sans nom"}` : " · aucun concessionnaire (zone sans jeu réseau)"}
        </span>
        <span className="break-words text-[11px] text-gray-700"><Resume c={c} /></span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-700">
          <span>Responsable : {c.responsable ? (c.responsable.nom ?? "compte sans nom") : "non attribué"}</span>
          <span>Échéance : {c.echeance ? formaterDate(c.echeance) : "non fixée"}</span>
          <BadgeRisque risque={c.risque} />
        </span>
      </button>
    </li>
  );
}

export function ListeConflits(p: PropsListeConflits) {
  const idQ = useId();
  const idType = useId();
  const idAxe = useId();
  const idConc = useId();
  const idResp = useId();
  const idTri = useId();
  const idAxes = useId();
  const [avances, setAvances] = useState(false);
  const f = p.filtres;
  const maj = (partiel: Partial<FiltresConflits>) => p.onFiltres({ ...f, ...partiel });
  const actifs = nbFiltresActifs(f);

  const tries = useMemo(() => trierConflits(p.conflits, f.tri), [p.conflits, f.tri]);
  const axesConnus = useMemo(() => [...new Set(p.conflits.map((c) => c.axe).filter((a): a is string => !!a))].sort((a, b) => a.localeCompare(b, "fr", { numeric: true })), [p.conflits]);
  const responsables = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of p.conflits) if (c.responsable?.id && c.responsable.id !== p.userId) m.set(c.responsable.id, c.responsable.nom ?? "Compte sans nom");
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "fr"));
  }, [p.conflits, p.userId]);

  const total = p.compteurs ? STATUTS_CONFLIT.reduce((s, k) => s + (p.compteurs?.[k] ?? 0), 0) : null;
  const erreur = p.requete.isError ? classerErreurConflit(p.requete.error) : null;
  const aSuite = p.requete.hasNextPage === true;

  return (
    <section aria-labelledby="pv-titre-liste-conflits" className="space-y-3">
      <h3 id="pv-titre-liste-conflits" className="text-sm font-semibold text-navy">Dossiers de conflit</h3>

      <div role="group" aria-label="Filtrer par statut (compteurs du serveur)" className="flex flex-wrap gap-1">
        <button
          type="button" aria-pressed={f.statut === ""} onClick={() => maj({ statut: "" })}
          className={`min-h-[44px] rounded border px-2 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-8 ${f.statut === "" ? "border-2 border-navy bg-navy text-white" : "border-gray-400 bg-white text-gray-900 hover:bg-gray-100"}`}
        >
          Tous{total !== null ? ` (${formaterNombre(total, 0)})` : ""}
        </button>
        {STATUTS_CONFLIT.map((s: StatutConflit) => {
          const n = p.compteurs?.[s];
          const on = f.statut === s;
          return (
            <button
              key={s} type="button" aria-pressed={on} onClick={() => maj({ statut: on ? "" : s })} data-statut-filtre={s}
              className={`min-h-[44px] rounded border px-2 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-8 ${on ? "border-2 border-navy bg-navy text-white" : "border-gray-400 bg-white text-gray-900 hover:bg-gray-100"}`}
            >
              {STYLE_STATUT_CONFLIT[s].libelle}{typeof n === "number" ? ` (${formaterNombre(n, 0)})` : ""}
            </button>
          );
        })}
      </div>

      <div>
        <label htmlFor={idQ} className="block text-xs font-medium text-gray-800">Rechercher (axe, concessionnaire, action proposée…)</label>
        <div className="relative mt-1">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
          <Input id={idQ} type="search" value={f.q} onChange={(e) => maj({ q: e.target.value })} autoComplete="off" maxLength={100} className="border-gray-300 pl-9" />
        </div>
      </div>

      <div>
        <button
          type="button" aria-expanded={avances} aria-controls="pv-filtres-avances" onClick={() => setAvances((v) => !v)}
          className="inline-flex min-h-[44px] items-center gap-1 rounded text-xs font-medium text-navy underline focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-8"
        >
          {avances ? <ChevronDown aria-hidden="true" className="h-4 w-4" /> : <ChevronRight aria-hidden="true" className="h-4 w-4" />}
          Filtres avancés{actifs > 0 ? ` (${actifs} actif${actifs > 1 ? "s" : ""})` : ""}
        </button>
        <div id="pv-filtres-avances" hidden={!avances} className="mt-1 grid gap-2 rounded border border-gray-200 bg-white p-2">
          <div>
            <label htmlFor={idType} className="block text-xs font-medium text-gray-800">Type de conflit</label>
            <Select id={idType} value={f.type} onChange={(e) => maj({ type: e.target.value as FiltresConflits["type"] })} className="border-gray-300">
              <option value="">Tous les types</option>
              {TYPES_CONFLIT.map((t) => <option key={t} value={t}>{LIBELLE_TYPE_CONFLIT[t]}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor={idAxe} className="block text-xs font-medium text-gray-800">Axe (nom)</label>
            <Input id={idAxe} list={idAxes} value={f.axe} onChange={(e) => maj({ axe: e.target.value })} autoComplete="off" maxLength={100} className="border-gray-300" />
            <datalist id={idAxes}>{axesConnus.map((a) => <option key={a} value={a} />)}</datalist>
          </div>
          <div>
            <label htmlFor={idConc} className="block text-xs font-medium text-gray-800">Concessionnaire</label>
            <Select id={idConc} value={f.concessionnaireId} onChange={(e) => maj({ concessionnaireId: e.target.value })} className="border-gray-300">
              <option value="">Tous les concessionnaires</option>
              {p.concessionnaires.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor={idResp} className="block text-xs font-medium text-gray-800">Responsable</label>
            <Select id={idResp} value={f.responsableId} onChange={(e) => maj({ responsableId: e.target.value })} className="border-gray-300">
              <option value="">Tous les responsables</option>
              {p.userId && <option value={p.userId}>Moi{p.nomUtilisateur ? ` (${p.nomUtilisateur})` : ""}</option>}
              {responsables.map(([rid, nom]) => <option key={rid} value={rid}>{nom}</option>)}
            </Select>
          </div>
          <label className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0">
            <input type="checkbox" className="h-4 w-4" checked={f.aReexaminer} onChange={(e) => maj({ aReexaminer: e.target.checked })} />
            À réexaminer (non retrouvé ou modifié par une analyse)
          </label>
          <label className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0">
            <input type="checkbox" className="h-4 w-4" checked={f.echeanceDepassee} onChange={(e) => maj({ echeanceDepassee: e.target.checked })} />
            Échéance dépassée
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-[10rem] flex-1">
          <label htmlFor={idTri} className="block text-xs font-medium text-gray-800">Trier</label>
          <Select id={idTri} value={f.tri} onChange={(e) => maj({ tri: e.target.value as TriConflit })} className="border-gray-300">
            {(Object.keys(LIBELLE_TRI) as TriConflit[]).map((t) => <option key={t} value={t}>{LIBELLE_TRI[t]}</option>)}
          </Select>
        </div>
        {actifs > 0 && (
          <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" onClick={() => p.onFiltres({ ...FILTRES_VIDES, tri: f.tri })}>
            <RotateCcw aria-hidden="true" /> Réinitialiser les filtres
          </Button>
        )}
      </div>

      {p.requete.isPending && (
        <p role="status" className="flex items-center gap-2 p-2 text-sm text-gray-700"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Chargement des conflits…</p>
      )}
      {erreur && <EtatErreur erreur={erreur} sujet="Liste des conflits" onReessayer={() => void p.requete.refetch()} enCours={p.requete.isFetching} />}

      {p.requete.isSuccess && (
        <>
          <p role="status" className="text-xs text-gray-700" data-testid="etat-liste-conflits">
            {p.conflits.length === 0 ? "Aucun conflit à afficher." : `${formaterNombre(p.conflits.length, 0)} conflit(s) chargé(s)${aSuite ? ", d'autres restent à charger" : ""}.`}
            {p.conflits.length > 1 && f.tri !== "serveur" ? " Le tri porte sur les conflits chargés." : ""}
          </p>
          {p.ignores > 0 && (
            <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              {p.ignores} élément(s) de la réponse du serveur n&apos;ont pas pu être lus (statut ou type inconnu de cette version de l&apos;interface) et ne sont pas affichés.
            </p>
          )}
          {p.conflits.length === 0 ? (
            actifs > 0 ? (
              <EtatVide titre="Aucun conflit ne correspond à ces filtres">
                <p>Modifiez ou réinitialisez les filtres.</p>
              </EtatVide>
            ) : (
              <EtatVide titre="Aucun dossier de conflit pour ce projet">
                <p>Si aucune analyse n&apos;a été lancée, lancez-en une (administrateur ou gestionnaire) : chaque résultat devient un dossier suivi.</p>
                <p>Rappel : l&apos;absence de conflit détecté ne prouve pas l&apos;absence de réseau.</p>
              </EtatVide>
            )
          ) : (
            <ul aria-label="Liste des conflits" className="space-y-1.5">
              {tries.map((c) => <LigneConflit key={c.id} c={c} actif={p.selectionId === c.id} onOuvrir={p.onOuvrir} />)}
            </ul>
          )}
          {aSuite && (
            <Button type="button" variant="outline" className="min-h-[44px] w-full xl:min-h-9" disabled={p.requete.isFetchingNextPage} onClick={() => void p.requete.fetchNextPage()}>
              {p.requete.isFetchingNextPage ? "Chargement…" : "Charger les conflits suivants"}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
