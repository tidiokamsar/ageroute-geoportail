import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, History, Pencil, Scale } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toast } from "../lib/toast";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { EtatChargement, EtatErreur, EtatVide } from "../components/decision/EtatsDecision";
import { HistoriqueBareme } from "../components/decision/rapports/HistoriqueBareme";
import { ReponseInattendue, classerErreurDecision } from "../lib/aideDecisionApi";
import { OPTIONS_RELANCE } from "../lib/aideDecisionRapportsApi";
import {
  LONGUEUR_MIN_MOTIF, consequenceModification, construireApprobation, construireModification, messageActionRefusee,
  prixAbrege, prixExact, raisonApprobationImpossible, saisieDepuis, type BaremeLigne, type CorpsApprobation, type CorpsModification, type Saisie,
} from "../lib/aideDecisionRapportsBaremes";
import { formaterDate } from "../lib/decision";

/**
 * Barèmes de coût (D-07) — l'écran qui déverrouille l'aide à la décision.
 *
 * Le moteur de coût refuse d'estimer tant que la ligne n'est ni approuvée, ni millésimée, ni largeurée. Les neuf lignes
 * d'origine portent ces champs vides VOLONTAIREMENT : personne ne sait pour quelle année ni quelle largeur ces prix ont été
 * posés, et les deviner serait inventer la donnée qu'on cherche à rendre vérifiable. Ici, AGEROUTE (avec l'ONR comme
 * dépositaire des prix unitaires) pose la réponse, ligne par ligne, puis un AUTRE compte l'approuve.
 *
 * LOT 6 : chaque modification et chaque approbation exige un MOTIF (et l'approbation un commentaire) et est historisée ;
 * seuls les champs qui changent le calcul retirent l'approbation (un libellé corrigé ne la neutralise pas) ; celui qui a posé
 * un prix ne l'approuve pas. Les refus du serveur (403 auto-validation, 409 version périmée ou déjà approuvée, 422 prix
 * illisible) sont AFFICHÉS à l'écran avec leur motif, pas seulement dans une notification qui disparaît. Aucune valeur n'est
 * préremplie à la création d'une édition : les champs partent de ce que la ligne porte (rien, pour les neuf d'origine).
 */

const FAMILLE_LABEL: Record<string, string> = { bitume: "Bitume", terre_laterite: "Terre / latérite", pave: "Pavé" };
const ETAT_LABEL: Record<string, string> = { MOYEN: "État moyen", MAUVAIS: "État mauvais", CRITIQUE: "État critique" };

/** Prix exact (separateurs de milliers, sans flottant) puis, s'il y a lieu, sa forme abregee annoncee comme approchee. */
function Prix({ cout, devise }: { cout: string; devise: string }) {
  const abrege = prixAbrege(cout, devise);
  return (
    <>
      <span data-prix="exact" className="block">{prixExact(cout, devise)}</span>
      {abrege && <span data-prix="abrege" className="block text-xs text-gray-700">{abrege}</span>}
    </>
  );
}

interface ActionRefusee { titre: string; statut: number | null; code: string | null; message: string }

async function lireBaremes(): Promise<BaremeLigne[]> {
  const r = await api.get<unknown>("/v2/baremes");
  const d = (r.data as { data?: unknown } | null)?.data;
  if (!Array.isArray(d)) throw new ReponseInattendue("les barèmes");
  return d as BaremeLigne[];
}

const champ = "w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm";

export function BaremesPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const peutParametrer = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";
  const peutApprouver = user?.role === "ADMIN";

  const q = useQuery({ queryKey: ["v2", "baremes"], queryFn: lireBaremes, ...OPTIONS_RELANCE });
  const lignes = q.data ?? [];

  const [editionId, setEditionId] = useState<number | null>(null);
  const [saisie, setSaisie] = useState<Saisie | null>(null);
  const [approbationId, setApprobationId] = useState<number | null>(null);
  const [motifAppro, setMotifAppro] = useState("");
  const [commentaireAppro, setCommentaireAppro] = useState("");
  const [historiqueId, setHistoriqueId] = useState<number | null>(null);
  const [refus, setRefus] = useState<ActionRefusee | null>(null);

  const invalider = () => {
    void qc.invalidateQueries({ queryKey: ["v2", "baremes"] });
  };

  const modifier = useMutation({
    mutationFn: async ({ id, corps }: { id: number; corps: CorpsModification }) => (await api.patch(`/v2/baremes/${id}`, corps)).data,
    onSuccess: () => {
      toast.success("Ligne modifiée et historisée.");
      setEditionId(null); setSaisie(null); setRefus(null); invalider();
    },
    onError: (e) => setRefus({ titre: "Modification refusée", ...messageActionRefusee(e, "Modification refusée.") }),
  });

  const approuver = useMutation({
    mutationFn: async ({ id, corps }: { id: number; corps: CorpsApprobation }) => (await api.post(`/v2/baremes/${id}/approuver`, corps)).data,
    onSuccess: () => {
      toast.success("Prix approuvé : les estimations peuvent le citer.");
      setApprobationId(null); setMotifAppro(""); setCommentaireAppro(""); setRefus(null); invalider();
    },
    onError: (e) => setRefus({ titre: "Approbation refusée", ...messageActionRefusee(e, "Approbation refusée.") }),
  });

  const nbApprouvees = lignes.filter((l) => l.approuveLe).length;
  const ligneEnEdition = lignes.find((l) => l.id === editionId) ?? null;
  const resultat = ligneEnEdition && saisie ? construireModification(ligneEnEdition, saisie) : null;
  const ligneApprobation = lignes.find((l) => l.id === approbationId) ?? null;
  const resApprobation = ligneApprobation ? construireApprobation(ligneApprobation, motifAppro, commentaireAppro) : null;

  const maj = (k: keyof Saisie) => (e: { target: { value: string } }) => setSaisie((s) => (s ? { ...s, [k]: e.target.value } : s));

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-navy via-navy2 to-[#1e3a5f] rounded-xl p-5 text-white">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Scale className="h-5 w-5 text-gold" />
          Barèmes de coût d&apos;intervention
        </h2>
        <p className="text-white/80 text-sm mt-1">
          {lignes.length} lignes · {nbApprouvees} approuvée(s) — le moteur de coût n&apos;estime qu&apos;avec des lignes approuvées, millésimées et largeurées.
        </p>
      </div>

      <Card>
        <p className="text-xs text-gray-700 mb-2">
          Les neuf lignes d&apos;origine sont des standards initiaux, volontairement sans millésime ni largeur : personne ne sait pour quelle année ni quelle
          chaussée ils ont été posés. Poser le millésime et la largeur (source ONR / AGEROUTE), puis faire approuver par un autre compte : c&apos;est ce qui
          déverrouille l&apos;estimation de coût dans l&apos;aide à la décision.
        </p>
        <p role="note" className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          Consultatif, non engageant : un prix non approuvé est provisoire, et aucune estimation qui le cite n&apos;engage AGEROUTE. Les prix sont exprimés dans
          la devise et l&apos;unité affichées sur chaque ligne (GNF par kilomètre).
        </p>

        {refus && (
          <div role="alert" data-etat="refus" className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            <p><strong>{refus.titre}{refus.statut ? ` (${refus.statut}${refus.code ? ` ${refus.code}` : ""})` : ""}.</strong> {refus.message}</p>
            <Button type="button" size="sm" variant="ghost" className="mt-1 min-h-[44px] xl:min-h-0" aria-label="Fermer le message de refus" onClick={() => setRefus(null)}>Fermer</Button>
          </div>
        )}

        {q.isPending && <EtatChargement libelle="Chargement des barèmes…" panneau="barèmes" onReessayer={() => void q.refetch()} />}
        {q.isError && <EtatErreur panneau="barèmes" erreur={classerErreurDecision(q.error)} onReessayer={() => void q.refetch()} reessaiEnCours={q.isFetching} />}
        {q.isSuccess && lignes.length === 0 && <EtatVide titre="Aucune ligne de barème" detail="La table des barèmes est vide : aucune estimation de coût n'est possible." />}
        {q.isSuccess && lignes.length > 0 && (
          <>
          <p className="mb-1 text-xs text-gray-700 xl:hidden">Faites défiler le tableau horizontalement pour voir la validité, la version, l&apos;approbation et les actions.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Barèmes de coût d&apos;intervention : prix par kilomètre, millésime, largeur, validité, version et approbation</caption>
              <thead className="text-xs text-gray-700 uppercase">
                <tr className="border-b border-gray-100">
                  <th scope="col" className="text-left py-2 pr-3">Famille</th>
                  <th scope="col" className="text-left py-2 pr-3">État de départ</th>
                  <th scope="col" className="text-left py-2 pr-3">Intervention</th>
                  <th scope="col" className="text-right py-2 pr-3">Coût / km</th>
                  <th scope="col" className="text-right py-2 pr-3">Millésime</th>
                  <th scope="col" className="text-right py-2 pr-3">Largeur (m)</th>
                  <th scope="col" className="text-left py-2 pr-3">Validité</th>
                  <th scope="col" className="text-right py-2 pr-3">Version</th>
                  <th scope="col" className="text-left py-2 pr-3">Approbation</th>
                  <th scope="col" className="text-right py-2 min-w-[11rem]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {lignes.map((l) => {
                  const raison = raisonApprobationImpossible(l);
                  const nom = `${l.familleRevetement} ${l.etatDepart}`;
                  return (
                    <Fragment key={l.id}>
                      <tr className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors align-top">
                        <th scope="row" className="py-2 pr-3 text-left font-medium text-navy">{FAMILLE_LABEL[l.familleRevetement] ?? l.familleRevetement}</th>
                        <td className="py-2 pr-3 text-gray-700">{ETAT_LABEL[l.etatDepart] ?? l.etatDepart}</td>
                        <td className="py-2 pr-3 text-gray-700">{l.typeIntervention}</td>
                        <td className="py-2 pr-3 text-right text-gray-800 tabular-nums whitespace-nowrap"><Prix cout={l.coutKmGnf} devise={l.devise ?? "GNF"} /></td>
                        <td className="py-2 pr-3 text-right text-gray-700 tabular-nums">{l.anneeReference ?? "—"}</td>
                        <td className="py-2 pr-3 text-right text-gray-700 tabular-nums">{l.largeurChausseeM ?? "—"}</td>
                        <td className="py-2 pr-3 text-gray-700 min-w-[8rem]">
                          {l.validDe || l.validA ? `${l.validDe ? formaterDate(l.validDe) : "origine"} au ${l.validA ? formaterDate(l.validA) : "sans fin"}` : "non bornée"}
                        </td>
                        <td className="py-2 pr-3 text-right text-gray-700 tabular-nums">v{l.version}</td>
                        <td className="py-2 pr-3">
                          {l.approuveLe ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-800">
                              <BadgeCheck aria-hidden="true" className="h-3.5 w-3.5" />
                              approuvée{l.approuvePar ? ` par ${l.approuvePar}` : ""}
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900">non approuvée</span>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            <button type="button" aria-label={`Historique de la ligne ${nom}`} aria-expanded={historiqueId === l.id}
                              onClick={() => setHistoriqueId(historiqueId === l.id ? null : l.id)}
                              className="min-h-[44px] min-w-[44px] xl:min-h-0 xl:min-w-0 p-1.5 rounded-md hover:bg-navy/10 text-navy">
                              <History aria-hidden="true" className="h-4 w-4 mx-auto" />
                            </button>
                            {peutParametrer && (
                              <button type="button" aria-label={`Modifier la ligne ${nom}`}
                                onClick={() => {
                                  if (editionId === l.id) { setEditionId(null); setSaisie(null); } else { setEditionId(l.id); setSaisie(saisieDepuis(l)); setApprobationId(null); setRefus(null); }
                                }}
                                className="min-h-[44px] min-w-[44px] xl:min-h-0 xl:min-w-0 p-1.5 rounded-md hover:bg-navy/10 text-navy">
                                <Pencil aria-hidden="true" className="h-4 w-4 mx-auto" />
                              </button>
                            )}
                            {peutApprouver && (
                              <Button variant="outline" className="min-h-[44px] xl:min-h-0" disabled={raison !== null || approuver.isPending} aria-label={`Approuver la ligne ${nom}`}
                                title={raison ?? "Approuver ce prix."}
                                onClick={() => { setApprobationId(l.id); setEditionId(null); setSaisie(null); setRefus(null); setMotifAppro(""); setCommentaireAppro(""); }}>
                                Approuver
                              </Button>
                            )}
                          </div>
                          {peutApprouver && raison && l.approuveLe === null && <p className="mt-1 text-xs text-gray-700 text-right">{raison}</p>}
                        </td>
                      </tr>

                      {editionId === l.id && saisie && (
                        <tr><td colSpan={10} className="pb-3">
                          <form aria-label={`Modifier la ligne ${nom}`} className="space-y-3 rounded-md border border-gray-200 bg-gray-50 p-3"
                            onSubmit={(e) => { e.preventDefault(); if (resultat?.ok) modifier.mutate({ id: l.id, corps: resultat.corps }); }}>
                            <p className="text-xs text-gray-700">Devise : <strong>{l.devise}</strong> · unité : <strong>{l.uniteCout === "KM" ? "kilomètre" : l.uniteCout}</strong> (fermées : le moteur de coût ne sait lire que GNF par kilomètre).</p>
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                              <div>
                                <label htmlFor={`bareme-cout-${l.id}`} className="block text-xs font-medium text-gray-800">Coût par kilomètre en GNF</label>
                                <input id={`bareme-cout-${l.id}`} value={saisie.cout} onChange={maj("cout")} inputMode="numeric" aria-required="true" className={`${champ} tabular-nums`} />
                              </div>
                              <div>
                                <label htmlFor={`bareme-annee-${l.id}`} className="block text-xs font-medium text-gray-800">Millésime</label>
                                <input id={`bareme-annee-${l.id}`} value={saisie.annee} onChange={maj("annee")} inputMode="numeric" placeholder="2026" className={`${champ} tabular-nums`} />
                              </div>
                              <div>
                                <label htmlFor={`bareme-largeur-${l.id}`} className="block text-xs font-medium text-gray-800">Largeur de chaussée en mètres</label>
                                <input id={`bareme-largeur-${l.id}`} value={saisie.largeur} onChange={maj("largeur")} inputMode="decimal" placeholder="6.5" className={`${champ} tabular-nums`} />
                              </div>
                              <div>
                                <label htmlFor={`bareme-source-${l.id}`} className="block text-xs font-medium text-gray-800">Source du prix</label>
                                <input id={`bareme-source-${l.id}`} value={saisie.source} onChange={maj("source")} aria-required="true" className={champ} />
                              </div>
                              <div>
                                <label htmlFor={`bareme-de-${l.id}`} className="block text-xs font-medium text-gray-800">Début de validité (AAAA-MM-JJ)</label>
                                <input id={`bareme-de-${l.id}`} value={saisie.validDe} onChange={maj("validDe")} placeholder="2026-01-01" className={`${champ} tabular-nums`} />
                              </div>
                              <div>
                                <label htmlFor={`bareme-a-${l.id}`} className="block text-xs font-medium text-gray-800">Fin de validité (AAAA-MM-JJ)</label>
                                <input id={`bareme-a-${l.id}`} value={saisie.validA} onChange={maj("validA")} placeholder="2026-12-31" className={`${champ} tabular-nums`} />
                              </div>
                              <div>
                                <label htmlFor={`bareme-libelle-${l.id}`} className="block text-xs font-medium text-gray-800">Libellé</label>
                                <input id={`bareme-libelle-${l.id}`} value={saisie.libelle} onChange={maj("libelle")} className={champ} />
                              </div>
                              <div>
                                <label htmlFor={`bareme-commentaire-${l.id}`} className="block text-xs font-medium text-gray-800">Commentaire</label>
                                <input id={`bareme-commentaire-${l.id}`} value={saisie.commentaire} onChange={maj("commentaire")} className={champ} />
                              </div>
                            </div>
                            <div>
                              <label htmlFor={`bareme-motif-${l.id}`} className="block text-xs font-medium text-gray-800">Motif de la modification (obligatoire)</label>
                              <input id={`bareme-motif-${l.id}`} value={saisie.motif} onChange={maj("motif")} aria-required="true" placeholder="Pourquoi ce changement ? (arrêté, bordereau, correction...)" className={champ} />
                            </div>
                            {resultat && !resultat.ok && <ul className="list-disc pl-4 text-xs text-red-800" aria-label="Points à corriger">{resultat.erreurs.map((er) => <li key={er}>{er}</li>)}</ul>}
                            {resultat?.ok && <p role="status" className="text-xs text-gray-800">{consequenceModification(resultat.changeLeCalcul, l.approuveLe !== null)}</p>}
                            <div className="flex flex-wrap gap-2">
                              <Button type="submit" className="min-h-[44px] xl:min-h-0" disabled={!resultat?.ok || modifier.isPending}>Enregistrer</Button>
                              <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-0" onClick={() => { setEditionId(null); setSaisie(null); }}>Annuler</Button>
                            </div>
                          </form>
                        </td></tr>
                      )}

                      {approbationId === l.id && (
                        <tr><td colSpan={10} className="pb-3">
                          <form aria-label={`Approuver la ligne ${nom}`} className="space-y-3 rounded-md border border-gray-200 bg-gray-50 p-3"
                            onSubmit={(e) => { e.preventDefault(); if (resApprobation?.ok) approuver.mutate({ id: l.id, corps: resApprobation.corps }); }}>
                            <p className="text-xs text-gray-800">
                              Vous approuvez la version {l.version} au prix EXACT de <strong data-prix="confirmation">{prixExact(l.coutKmGnf, l.devise ?? "GNF")}</strong>, millésime {l.anneeReference ?? "—"}, largeur {l.largeurChausseeM ?? "—"} m.
                              L&apos;approbation est refusée si vous avez vous-même posé ce prix (séparation des tâches) : un autre compte doit l&apos;approuver.
                            </p>
                            <div>
                              <label htmlFor={`bareme-appro-motif-${l.id}`} className="block text-xs font-medium text-gray-800">Motif de l&apos;approbation (obligatoire)</label>
                              <input id={`bareme-appro-motif-${l.id}`} value={motifAppro} onChange={(e) => setMotifAppro(e.target.value)} aria-required="true" className={champ} />
                            </div>
                            <div>
                              <label htmlFor={`bareme-appro-comm-${l.id}`} className="block text-xs font-medium text-gray-800">Commentaire de l&apos;approbation (obligatoire, {LONGUEUR_MIN_MOTIF} caractères au moins)</label>
                              <input id={`bareme-appro-comm-${l.id}`} value={commentaireAppro} onChange={(e) => setCommentaireAppro(e.target.value)} aria-required="true" className={champ} />
                            </div>
                            {resApprobation && !resApprobation.ok && (motifAppro !== "" || commentaireAppro !== "") && (
                              <ul className="list-disc pl-4 text-xs text-red-800" aria-label="Points à corriger">{resApprobation.erreurs.map((er) => <li key={er}>{er}</li>)}</ul>
                            )}
                            <div className="flex flex-wrap gap-2">
                              <Button type="submit" className="min-h-[44px] xl:min-h-0" disabled={!resApprobation?.ok || approuver.isPending}>Confirmer l&apos;approbation</Button>
                              <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-0" onClick={() => setApprobationId(null)}>Annuler</Button>
                            </div>
                          </form>
                        </td></tr>
                      )}

                      {historiqueId === l.id && (
                        <tr><td colSpan={10} className="pb-3"><HistoriqueBareme id={l.id} titre={nom} /></td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>
    </div>
  );
}
