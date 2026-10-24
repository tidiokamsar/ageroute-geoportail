import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Pencil, Scale } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toast } from "../lib/toast";
import { messageErreur } from "../lib/exploitation";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";

/**
 * Barèmes de coût (D-07) — l'écran qui déverrouille l'aide à la décision.
 *
 * Le moteur de coût refuse d'estimer tant que la ligne n'est ni approuvée, ni
 * millésimée, ni largeurée. Les neuf lignes d'origine portent ces champs vides
 * VOLONTAIREMENT : personne ne sait pour quelle année ni quelle largeur ces prix ont
 * été posés, et les deviner serait inventer la donnée qu'on cherche à rendre
 * vérifiable. Ici, AGEROUTE (avec l'ONR comme dépositaire des prix unitaires) pose la
 * réponse, ligne par ligne, puis l'approuve — l'acte qui rend une estimation publiable.
 *
 * Aucune valeur n'est préremplie en création d'édition : les champs partent de ce que
 * la ligne porte (rien, pour les neuf d'origine). Toute modification désapprouve et
 * incrémente la version — côté serveur ; l'écran le redit.
 */

interface BaremeLigne {
  id: number;
  familleRevetement: string;
  etatDepart: string;
  typeIntervention: string;
  coutKmGnf: string;
  code: string | null;
  libelle: string | null;
  source: string;
  version: number;
  approuveLe: string | null;
  approuvePar: string | null;
  anneeReference: number | null;
  largeurChausseeM: string | null;
  commentaire: string | null;
}

const FAMILLE_LABEL: Record<string, string> = {
  bitume: "Bitume", terre_laterite: "Terre / latérite", pave: "Pavé",
};
const ETAT_LABEL: Record<string, string> = {
  MOYEN: "État moyen", MAUVAIS: "État mauvais", CRITIQUE: "État critique",
};

function formatGnf(m: string): string {
  const n = Number(m);
  if (n >= 1e9) return `${(n / 1e9).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} Md GNF/km`;
  return `${(n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} M GNF/km`;
}

export function BaremesPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const peutParametrer = user?.role === "ADMIN" || user?.role === "GESTIONNAIRE";
  const peutApprouver = user?.role === "ADMIN";

  const { data: reponse, isLoading } = useQuery({
    queryKey: ["v2", "baremes"],
    queryFn: async () => (await api.get<{ data: BaremeLigne[] }>("/v2/baremes")).data,
  });
  const lignes = reponse?.data ?? [];

  const [editionId, setEditionId] = useState<number | null>(null);
  const [cout, setCout] = useState("");
  const [annee, setAnnee] = useState("");
  const [largeur, setLargeur] = useState("");
  const [commentaire, setCommentaire] = useState("");

  const invalider = () => { void qc.invalidateQueries({ queryKey: ["v2", "baremes"] }); };

  const modifier = useMutation({
    mutationFn: async ({ id, corps }: { id: number; corps: Record<string, unknown> }) =>
      (await api.patch(`/v2/baremes/${id}`, corps)).data,
    onSuccess: () => {
      toast.success("Ligne modifiée : version incrémentée, approbation retirée.");
      setEditionId(null); invalider();
    },
    onError: (e) => toast.error(messageErreur(e, "Modification refusée.")),
  });

  const approuver = useMutation({
    mutationFn: async (id: number) => (await api.post(`/v2/baremes/${id}/approuver`)).data,
    onSuccess: () => { toast.success("Prix approuvé : les estimations peuvent le citer."); invalider(); },
    onError: (e) => toast.error(messageErreur(e, "Approbation refusée.")),
  });

  const ouvrirEdition = (l: BaremeLigne) => {
    setEditionId(l.id);
    setCout(l.coutKmGnf);
    setAnnee(l.anneeReference != null ? String(l.anneeReference) : "");
    setLargeur(l.largeurChausseeM ?? "");
    setCommentaire(l.commentaire ?? "");
  };

  const editionValide = /^\d+$/.test(cout.trim())
    && (annee === "" || (/^\d{4}$/.test(annee) && Number(annee) >= 1990 && Number(annee) <= 2100))
    && (largeur === "" || /^\d+([.,]\d+)?$/.test(largeur.trim()));

  const corpsEdition = (): Record<string, unknown> => ({
    coutKmGnf: cout.trim(),
    anneeReference: annee.trim() ? Number(annee) : null,
    largeurChausseeM: largeur.trim() ? Number(largeur.replace(",", ".")) : null,
    commentaire: commentaire.trim() || null,
  });

  const nbApprouvees = lignes.filter((l) => l.approuveLe).length;

  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-r from-navy via-navy2 to-[#1e3a5f] rounded-xl p-5 text-white">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Scale className="h-5 w-5 text-gold" />
          Barèmes de coût d'intervention
        </h2>
        <p className="text-white/60 text-sm mt-1">
          {lignes.length} lignes · {nbApprouvees} approuvée(s) — le moteur de coût n'estime
          qu'avec des lignes approuvées, millésimées et largeurées.
        </p>
      </div>

      <Card>
        <p className="text-xs text-gray-500 mb-4">
          Les neuf lignes d'origine sont des standards initiaux, volontairement sans millésime
          ni largeur : personne ne sait pour quelle année ni quelle chaussée ils ont été posés.
          Poser le millésime et la largeur (source ONR / AGEROUTE), puis approuver : c'est ce
          qui déverrouille l'estimation de coût dans l'aide à la décision.
        </p>

        {isLoading ? (
          <p className="text-sm text-gray-400">Chargement…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 uppercase">
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 pr-3">Famille</th>
                  <th className="text-left py-2 pr-3">État de départ</th>
                  <th className="text-left py-2 pr-3">Intervention</th>
                  <th className="text-right py-2 pr-3">Coût / km</th>
                  <th className="text-right py-2 pr-3">Millésime</th>
                  <th className="text-right py-2 pr-3">Largeur (m)</th>
                  <th className="text-right py-2 pr-3">Version</th>
                  <th className="text-left py-2 pr-3">Approbation</th>
                  {peutParametrer && <th className="text-right py-2 w-40">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {lignes.map((l) => (
                  <tr key={l.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors align-top">
                    <td className="py-2 pr-3 font-medium text-navy">{FAMILLE_LABEL[l.familleRevetement] ?? l.familleRevetement}</td>
                    <td className="py-2 pr-3 text-gray-600">{ETAT_LABEL[l.etatDepart] ?? l.etatDepart}</td>
                    <td className="py-2 pr-3 text-gray-500">{l.typeIntervention}</td>
                    {editionId === l.id ? (
                      <>
                        <td className="py-2 pr-3">
                          <label htmlFor={`bareme-cout-${l.id}`} className="sr-only">Coût par kilomètre en GNF</label>
                          <input id={`bareme-cout-${l.id}`} value={cout} onChange={(e) => setCout(e.target.value)}
                            inputMode="numeric" aria-required="true"
                            className="w-36 rounded-lg border border-gray-200 px-2 py-1.5 text-sm tabular-nums" />
                        </td>
                        <td className="py-2 pr-3">
                          <label htmlFor={`bareme-annee-${l.id}`} className="sr-only">Millésime</label>
                          <input id={`bareme-annee-${l.id}`} value={annee} onChange={(e) => setAnnee(e.target.value)}
                            inputMode="numeric" placeholder="2026"
                            className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-sm tabular-nums" />
                        </td>
                        <td className="py-2 pr-3">
                          <label htmlFor={`bareme-largeur-${l.id}`} className="sr-only">Largeur de chaussée en mètres</label>
                          <input id={`bareme-largeur-${l.id}`} value={largeur} onChange={(e) => setLargeur(e.target.value)}
                            inputMode="decimal" placeholder="6.5"
                            className="w-20 rounded-lg border border-gray-200 px-2 py-1.5 text-sm tabular-nums" />
                        </td>
                        <td className="py-2 pr-3 text-right text-gray-400" colSpan={2}>
                          <div className="flex justify-end gap-1.5">
                            <Button
                              disabled={!editionValide || modifier.isPending}
                              onClick={() => modifier.mutate({ id: l.id, corps: corpsEdition() })}
                            >
                              Enregistrer
                            </Button>
                            <Button variant="outline" onClick={() => setEditionId(null)}>Annuler</Button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="py-2 pr-3 text-right text-gray-700 tabular-nums whitespace-nowrap">{formatGnf(l.coutKmGnf)}</td>
                        <td className="py-2 pr-3 text-right text-gray-600 tabular-nums">{l.anneeReference ?? "—"}</td>
                        <td className="py-2 pr-3 text-right text-gray-600 tabular-nums">{l.largeurChausseeM ?? "—"}</td>
                        <td className="py-2 pr-3 text-right text-gray-400 tabular-nums">v{l.version}</td>
                        <td className="py-2 pr-3">
                          {l.approuveLe ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700">
                              <BadgeCheck className="h-3.5 w-3.5" />
                              {l.approuvePar ?? "approuvée"}
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
                              non approuvée
                            </span>
                          )}
                        </td>
                        {peutParametrer && (
                          <td className="py-2 text-right">
                            <div className="flex justify-end gap-1">
                              <button type="button" aria-label={`Modifier la ligne ${l.familleRevetement} ${l.etatDepart}`}
                                onClick={() => (editionId ? setEditionId(null) : ouvrirEdition(l))}
                                className="p-1.5 rounded-md hover:bg-navy/10 text-navy/70">
                                <Pencil className="h-4 w-4" />
                              </button>
                              {peutApprouver && (
                                <Button
                                  variant="outline"
                                  disabled={l.approuveLe != null || !l.anneeReference || !l.largeurChausseeM || approuver.isPending}
                                  title={!l.anneeReference || !l.largeurChausseeM
                                    ? "Poser d'abord le millésime et la largeur : approuver un prix illisible est refusé."
                                    : l.approuveLe != null ? "Déjà approuvée." : "Approuver ce prix."}
                                  onClick={() => approuver.mutate(l.id)}
                                >
                                  Approuver
                                </Button>
                              )}
                            </div>
                          </td>
                        )}
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
