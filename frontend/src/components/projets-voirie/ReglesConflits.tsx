import { useMemo, useState } from "react";
import { FilePlus2 } from "lucide-react";
import { Button } from "../ui/Button";
import { EtatChargement, EtatErreur, EtatVide } from "./EtatsPv";
import { BadgeStatutRegle } from "./BadgesConflit";
import { DialogueApprobationRegle, DialogueRegle } from "./ActionsConflit";
import type { RegleConflit } from "../../lib/projetsVoirieConflitsApi";
import { useApprouverRegle, useCreerRegle, useRegles } from "../../lib/projetsVoirieConflitsHooks";
import { LIBELLE_REGLE_GENERALE, classerErreurConflit, formaterDateHeure } from "../../lib/projetsVoirieConflits";
import { STYLE_RESEAU, TYPES_RESEAU, formaterMetres, formaterNombre, type TypeReseau } from "../../lib/projetsVoirie";

/**
 * Regles de conflit : liste par famille avec versions et statuts, creation d'un brouillon (ADMIN, GESTIONNAIRE), approbation reservee aux ADMIN.
 * Une regle approuvee est IMMUABLE : pour la changer, on cree une nouvelle version. Aucune tolerance n'est proposee par defaut : la regle par
 * defaut du socle (version 0) a une tolerance de proximite de 0, sans seuil invente.
 */

export interface PropsReglesConflits {
  projetId: string;
  peutEcrire: boolean;
  estAdmin: boolean;
  userId: string | undefined;
  enLigne: boolean;
}

type Cle = TypeReseau | "GENERALE";

export function ReglesConflits({ projetId, peutEcrire, estAdmin, userId, enLigne }: PropsReglesConflits) {
  const requete = useRegles(projetId);
  const creer = useCreerRegle(projetId);
  const approuver = useApprouverRegle(projetId);
  const [creation, setCreation] = useState(false);
  const [aApprouver, setAApprouver] = useState<RegleConflit | null>(null);

  const groupes = useMemo(() => {
    const m = new Map<Cle, RegleConflit[]>();
    for (const r of requete.data?.regles ?? []) {
      const k: Cle = r.famille ?? "GENERALE";
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    const ordre: Cle[] = ["GENERALE", ...TYPES_RESEAU];
    return ordre.filter((k) => m.has(k)).map((k) => ({
      cle: k,
      lignes: (m.get(k) ?? []).sort((a, b) => a.code.localeCompare(b.code) || b.version - a.version),
    }));
  }, [requete.data]);

  return (
    <section aria-labelledby="pv-titre-regles" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id="pv-titre-regles" className="text-sm font-semibold text-navy">Règles de conflit</h3>
        {peutEcrire && (
          <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => setCreation(true)}>
            <FilePlus2 aria-hidden="true" /> Créer un brouillon de règle
          </Button>
        )}
      </div>
      <p className="text-xs text-gray-700">
        Une règle fixe la tolérance de proximité et la marge d&apos;incertitude d&apos;une famille de réseau. Un brouillon n&apos;agit sur rien ; une règle approuvée est immuable
        (nouvelle version pour la changer) et prise en compte par les analyses lancées ensuite. L&apos;approbation est réservée aux administrateurs.
      </p>

      {requete.isPending && <EtatChargement libelle="Chargement des règles…" />}
      {requete.isError && <EtatErreur erreur={classerErreurConflit(requete.error)} sujet="Règles" onReessayer={() => void requete.refetch()} enCours={requete.isFetching} />}
      {requete.data && requete.data.ignores > 0 && (
        <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{requete.data.ignores} règle(s) de la réponse du serveur n&apos;ont pas pu être lues (statut inconnu) et ne sont pas affichées.</p>
      )}
      {requete.isSuccess && groupes.length === 0 && <EtatVide titre="Aucune règle listée par le serveur"><p>La règle par défaut du socle s&apos;applique tant qu&apos;aucune règle n&apos;est approuvée.</p></EtatVide>}

      {groupes.map((g) => {
        const titre = g.cle === "GENERALE" ? LIBELLE_REGLE_GENERALE : STYLE_RESEAU[g.cle].libelle;
        return (
          <div key={g.cle} role="group" aria-label={`Règles : ${titre}`} className="space-y-1">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-800">{titre}</h4>
            <ul className="space-y-1.5">
              {g.lignes.map((r) => (
                <li key={r.id} data-regle-id={r.id} className="space-y-1 rounded border border-gray-300 bg-white p-2 text-xs text-gray-900">
                  <p className="flex flex-wrap items-center gap-2">
                    <strong className="break-words text-sm text-navy">{r.code}</strong>
                    <span>version {r.version}</span>
                    <BadgeStatutRegle statut={r.statut} />
                    <span className="text-[11px] text-gray-700">{r.projetId ? "règle du projet" : "règle générale"}</span>
                  </p>
                  <p>
                    Tolérance de proximité : <strong>{r.toleranceProximiteM === null ? "non fournie" : formaterMetres(r.toleranceProximiteM)}</strong>
                    {" · "}marge d&apos;incertitude : <strong>{r.margeIncertitude === null ? "non fournie" : `facteur ${formaterNombre(r.margeIncertitude, 2)}`}</strong>
                  </p>
                  {r.justification && <p className="whitespace-pre-wrap break-words">Justification : {r.justification}</p>}
                  <p className="text-[11px] text-gray-700">
                    Créée par {r.creePar ? (r.creePar.nom ?? "compte sans nom") : "le système"}, {formaterDateHeure(r.createdAt)}
                    {r.approuvePar ? ` · approuvée par ${r.approuvePar.nom ?? "compte sans nom"}${r.approuveLe ? `, ${formaterDateHeure(r.approuveLe)}` : ""}` : ""}
                  </p>
                  {r.statut === "APPROUVEE" && <p className="text-[11px] text-gray-700">Immuable : pour la changer, créez une nouvelle version.</p>}
                  {estAdmin && r.statut === "BROUILLON" && (
                    <Button type="button" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} aria-label={`Approuver la règle ${r.code}, version ${r.version}`} onClick={() => setAApprouver(r)}>
                      Approuver
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {!estAdmin && peutEcrire && groupes.some((g) => g.lignes.some((r) => r.statut === "BROUILLON")) && (
        <p role="note" className="text-xs text-gray-700">Les brouillons attendent l&apos;approbation d&apos;un administrateur.</p>
      )}

      {creation && <DialogueRegle enLigne={enLigne} onFermer={() => setCreation(false)} onValider={(c) => creer.mutateAsync(c)} />}
      {aApprouver && (
        <DialogueApprobationRegle
          regle={aApprouver} userId={userId} enLigne={enLigne} onFermer={() => setAApprouver(null)}
          onValider={(corps) => approuver.mutateAsync({ regleId: aApprouver.id, corps })}
        />
      )}
    </section>
  );
}
