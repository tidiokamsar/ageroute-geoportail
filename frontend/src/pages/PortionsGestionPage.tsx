import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Scissors } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { toast } from "../lib/toast";
import { messageErreur } from "../lib/exploitation";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { TronconPicker } from "../components/TronconPicker";

/**
 * Gestion des portions d'un tronçon : découper, fusionner, requalifier.
 *
 * Ce sont des PROPOSITIONS (backend/src/api-v2/portions.routes.ts) : l'originale n'est jamais
 * modifiée, elle est marquée remplacée, et ce qui sort part en « à valider ». La validation reste
 * un écran à part, par un validateur habilité. Le serveur juge l'adjacence et la compatibilité ;
 * l'écran ne propose la fusion qu'entre deux portions qui se touchent, et affiche le motif d'un
 * refus tel que le serveur le donne.
 */

interface Portion {
  id: string; debutM: number; finM: number; statutValidation: string; remplaceeLe: string | null;
  revetement: string | null; etat: string | null; praticabilite: string | null; largeurM: number | null;
  source: string | null; observeeLe: string | null; valideDu: string | null; confiance: string | null; createdAt: string;
  creePar: { nomComplet: string } | null;
  revetementRef: { libelle: string } | null; etatRef: { libelle: string } | null; praticabiliteRef: { libelle: string } | null;
}
interface ValeurRef { code: string; libelle: string; actif: boolean }
interface Referentiels { revetements: ValeurRef[]; etats: ValeurRef[]; praticabilites: ValeurRef[] }

const m = (v: number) => `${Math.round(v).toLocaleString("fr-FR")} m`;
const jour = (v: string | null) => (v ? v.slice(0, 10) : "");
const aujourdHui = () => new Date().toISOString().slice(0, 10);

/** Paires voisines : la fin de l'une est le début de la suivante. Le serveur reste juge. */
export function pairesAdjacentes(portions: Pick<Portion, "id" | "debutM" | "finM">[]): [string, string][] {
  const triees = [...portions].sort((a, b) => a.debutM - b.debutM);
  const paires: [string, string][] = [];
  for (let i = 1; i < triees.length; i++) {
    if (Math.abs(triees[i - 1].finM - triees[i].debutM) < 0.01) paires.push([triees[i - 1].id, triees[i].id]);
  }
  return paires;
}

function DecoupeModal({ portion, onClose, onFait }: { portion: Portion; onClose: () => void; onFait: () => void }) {
  const [aM, setAM] = useState("");
  const v = Number(aM.replace(",", "."));
  const valide = aM.trim() !== "" && Number.isFinite(v) && v > portion.debutM && v < portion.finM;
  const decouper = useMutation({
    mutationFn: async () => (await api.post(`/v2/portions/${portion.id}/decoupe`, { aM: v })).data,
    onSuccess: () => { toast.success("Portion découpée : deux morceaux à valider"); onFait(); },
    onError: (e) => toast.error(messageErreur(e, "Découpe refusée")),
  });
  return (
    <Modal open onClose={onClose} title={`Découper ${m(portion.debutM)} – ${m(portion.finM)}`} sale={() => aM.trim() !== "" && !decouper.isSuccess}>
      <form className="space-y-2 text-sm" onSubmit={(e) => { e.preventDefault(); if (valide) decouper.mutate(); }}>
        <label className="block">Point de coupe (m depuis l'origine du tronçon)
          <input className="mt-1 w-full rounded border px-2 py-1" inputMode="decimal" value={aM} onChange={(e) => setAM(e.target.value)} />
        </label>
        <p className="text-xs text-gray-600">Strictement entre {m(portion.debutM)} et {m(portion.finM)}. Chaque morceau garde les attributs de l'original ; aucun ne doit faire moins de dix mètres.</p>
        <div className="flex justify-end"><Button type="submit" size="sm" disabled={!valide || decouper.isPending}>Découper</Button></div>
      </form>
    </Modal>
  );
}

function RequalificationModal({ portion, refs, onClose, onFait }: { portion: Portion; refs: Referentiels | undefined; onClose: () => void; onFait: () => void }) {
  const [f, setF] = useState({
    revetement: portion.revetement ?? "", etat: portion.etat ?? "", praticabilite: portion.praticabilite ?? "",
    largeurM: portion.largeurM == null ? "" : String(portion.largeurM), source: "", observeeLe: "", valideDu: "",
    confiance: portion.confiance ?? "",
  });
  const largeur = Number(f.largeurM.replace(",", "."));
  const largeurOk = f.largeurM.trim() === "" || (Number.isFinite(largeur) && largeur > 0 && largeur <= 100);
  const dateOk = !!f.valideDu && f.valideDu <= aujourdHui() && (!portion.valideDu || f.valideDu > jour(portion.valideDu));
  const requalifier = useMutation({
    mutationFn: async () => (await api.post(`/v2/portions/${portion.id}/requalification`, {
      revetement: f.revetement || null, etat: f.etat || null, praticabilite: f.praticabilite || null,
      largeurM: f.largeurM.trim() ? largeur : null, source: f.source.trim() || null,
      observeeLe: f.observeeLe || null, valideDu: f.valideDu, confiance: f.confiance || null,
    })).data,
    onSuccess: () => { toast.success("Nouvelle version proposée, à valider"); onFait(); },
    onError: (e) => toast.error(messageErreur(e, "Requalification refusée")),
  });
  const choix = (cle: "revetement" | "etat" | "praticabilite", libelle: string, valeurs: ValeurRef[] | undefined) => (
    <label className="block">{libelle}
      <select className="mt-1 w-full rounded border px-2 py-1" value={f[cle]} onChange={(e) => setF({ ...f, [cle]: e.target.value })}>
        <option value="">Non renseigné</option>
        {(valeurs ?? []).filter((x) => x.actif || x.code === f[cle]).map((x) => <option key={x.code} value={x.code}>{x.libelle}</option>)}
      </select>
    </label>
  );
  return (
    <Modal open onClose={onClose} title={`Requalifier ${m(portion.debutM)} – ${m(portion.finM)}`} sale={() => !requalifier.isSuccess && (f.valideDu !== "" || f.source !== "")}>
      <form className="space-y-2 text-sm" onSubmit={(e) => { e.preventDefault(); if (dateOk && largeurOk) requalifier.mutate(); }}>
        <p className="text-xs text-gray-600">Bornes inchangées. La nouvelle version repart « à valider », même si celle-ci était validée.</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {choix("revetement", "Revêtement", refs?.revetements)}
          {choix("etat", "État", refs?.etats)}
          {choix("praticabilite", "Praticabilité", refs?.praticabilites)}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="block">Largeur (m)<input className="mt-1 w-full rounded border px-2 py-1" inputMode="decimal" value={f.largeurM} onChange={(e) => setF({ ...f, largeurM: e.target.value })} /></label>
          <label className="block">Vrai depuis le (date d'effet)<input type="date" className="mt-1 w-full rounded border px-2 py-1" max={aujourdHui()} value={f.valideDu} onChange={(e) => setF({ ...f, valideDu: e.target.value })} /></label>
          <label className="block">Observé le<input type="date" className="mt-1 w-full rounded border px-2 py-1" max={aujourdHui()} value={f.observeeLe} onChange={(e) => setF({ ...f, observeeLe: e.target.value })} /></label>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block">Source<input className="mt-1 w-full rounded border px-2 py-1" maxLength={200} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} /></label>
          <label className="block">Confiance
            <select className="mt-1 w-full rounded border px-2 py-1" value={f.confiance} onChange={(e) => setF({ ...f, confiance: e.target.value })}>
              <option value="">Non renseignée</option><option value="HIGH">Élevée</option><option value="MEDIUM">Moyenne</option><option value="LOW">Faible</option>
            </select>
          </label>
        </div>
        {!largeurOk && <p className="text-xs text-red-700">Largeur : nombre de 0 à 100 m.</p>}
        {f.valideDu && !dateOk && <p className="text-xs text-red-700">La date d'effet doit être passée et postérieure à celle de la version remplacée ({jour(portion.valideDu)}).</p>}
        {!f.valideDu && <p className="text-xs text-gray-600">La date d'effet est demandée : sans elle, la nouvelle version ne se placerait à aucune date.</p>}
        <div className="flex justify-end"><Button type="submit" size="sm" disabled={!dateOk || !largeurOk || requalifier.isPending}>Proposer la requalification</Button></div>
      </form>
    </Modal>
  );
}

export function PortionsGestionPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const peutProposer = !!user && user.role !== "LECTEUR";
  const [tronconId, setTronconId] = useState<string | undefined>();
  const [historique, setHistorique] = useState(false);
  const [decoupe, setDecoupe] = useState<Portion | null>(null);
  const [requal, setRequal] = useState<Portion | null>(null);
  const [refs, setRefs] = useState<Referentiels>();

  useEffect(() => {
    if (!peutProposer) return;
    api.get<Referentiels>("/v2/referentiels").then((r) => setRefs(r.data)).catch(() => toast.error("Vocabulaires indisponibles"));
  }, [peutProposer]);

  const portions = useQuery({
    queryKey: ["portions", "gestion", tronconId, historique],
    enabled: !!tronconId,
    queryFn: async () => (await api.get<{ portions: Portion[] }>("/v2/portions", { params: { tronconId, limite: 200, ...(historique ? { historique: "true" } : {}) } })).data.portions,
  });
  const fini = () => { setDecoupe(null); setRequal(null); qc.invalidateQueries({ queryKey: ["portions"] }); };
  const fusionner = useMutation({
    mutationFn: async ([idA, idB]: [string, string]) => (await api.post("/v2/portions/fusion", { idA, idB })).data,
    onSuccess: () => { toast.success("Fusion proposée, à valider"); fini(); },
    onError: (e) => toast.error(messageErreur(e, "Fusion refusée")),
  });

  const lignes = [...(portions.data ?? [])].sort((a, b) => a.debutM - b.debutM || a.createdAt.localeCompare(b.createdAt));
  const courantes = lignes.filter((p) => !p.remplaceeLe);
  const suivante = new Map(pairesAdjacentes(courantes).map(([a, b]) => [a, b]));

  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-sm text-gray-700"><Scissors className="h-4 w-4" aria-hidden="true" /> Découper, fusionner, requalifier : chaque geste est une proposition, l'original reste dans l'historique.</p>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
        <div className="min-w-64 flex-1"><label htmlFor="gestion-troncon" className="mb-1 block">Tronçon</label><TronconPicker id="gestion-troncon" value={tronconId} onChange={setTronconId} /></div>
        <label className="flex items-center gap-1"><input type="checkbox" checked={historique} onChange={(e) => setHistorique(e.target.checked)} />Inclure les versions remplacées</label>
      </div>
      {!tronconId ? <p className="text-sm text-gray-600">Choisissez un tronçon.</p>
        : portions.isLoading ? <p className="text-sm text-gray-500">Chargement…</p>
        : portions.isError ? <p className="text-sm text-red-700">{messageErreur(portions.error, "Portions indisponibles.")}</p>
        : lignes.length === 0 ? <p className="text-sm text-gray-600">Aucune portion sur ce tronçon.</p>
        : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <caption className="sr-only">Portions du tronçon</caption>
              <thead><tr className="text-left text-gray-600"><th className="p-2">De – à</th><th>Revêtement</th><th>État</th><th>Praticabilité</th><th>Vrai depuis</th><th>Statut</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {lignes.map((p) => (
                  <tr key={p.id} className={`border-t ${p.remplaceeLe ? "text-gray-500" : ""}`}>
                    <td className="whitespace-nowrap p-2">{m(p.debutM)} – {m(p.finM)}</td>
                    <td>{p.revetementRef?.libelle ?? p.revetement ?? "—"}</td>
                    <td>{p.etatRef?.libelle ?? p.etat ?? "—"}</td>
                    <td>{p.praticabiliteRef?.libelle ?? p.praticabilite ?? "—"}</td>
                    <td>{jour(p.valideDu) || "sans date"}</td>
                    <td>{p.remplaceeLe ? `remplacée le ${jour(p.remplaceeLe)}` : p.statutValidation.toLowerCase().replace("_", " ")}</td>
                    <td className="space-x-1 whitespace-nowrap p-1 text-right">
                      {peutProposer && !p.remplaceeLe && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => setDecoupe(p)}>Découper</Button>
                          <Button size="sm" variant="outline" onClick={() => setRequal(p)}>Requalifier</Button>
                          {suivante.has(p.id) && (
                            <Button size="sm" variant="outline" disabled={fusionner.isPending} onClick={() => fusionner.mutate([p.id, suivante.get(p.id)!])}>Fusionner avec la suivante</Button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {lignes.length === 200 && <p className="text-xs text-amber-800">200 portions affichées : la liste est tronquée.</p>}
      {decoupe && <DecoupeModal portion={decoupe} onClose={() => setDecoupe(null)} onFait={fini} />}
      {requal && <RequalificationModal portion={requal} refs={refs} onClose={() => setRequal(null)} onFait={fini} />}
    </div>
  );
}
