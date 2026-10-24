import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, FileUp, XCircle } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { downloadViaApi } from "../lib/download";
import { Button } from "../components/ui/Button";

/**
 * Suivi des lots d'import au format pivot (ROAD_SURVEY_IMPORT_SPEC.md).
 *
 * CE QUE CET ÉCRAN DOIT DIRE, ET QUI NE VA PAS DE SOI
 *
 * **Recevoir n'est pas importer.** Un lot « validé » a passé le contrôle de schéma ; rien n'a
 * été créé dans le référentiel. L'application — créer des propositions à valider — attend un
 * premier échantillon approuvé, et aucun bouton ne la promet ici.
 *
 * **Le même fichier deux fois ne fait rien.** L'empreinte est calculée par le serveur sur les
 * octets reçus. Renvoyer un fichier déjà reçu rend le lot existant, sans aucune écriture : l'écran
 * le dit, au lieu d'afficher un faux succès.
 *
 * **Un lot rejeté est un résultat, pas une erreur.** Un fichier dans un autre système de
 * coordonnées, ou sans colonne obligatoire, est enregistré REJETÉ avec son motif. La source doit
 * pouvoir le lire ; les erreurs ligne à ligne se téléchargent.
 */

interface Lot {
  id: string;
  reference: string;
  systemeSource: string;
  format: string;
  nomFichier: string;
  statut: "RECU" | "VALIDE_SCHEMA" | "IMPORTE_TEST" | "IMPORTE" | "REJETE";
  importeLe: string;
  lignesLues: number;
  lignesValidees: number;
  lignesImportees: number;
  lignesRejetees: number;
  lignesEnConflit: number;
  lignesIgnorees: number;
  rapport?: {
    motifRejetLot?: string | null;
    premiersRejets?: { numeroLigne: number; statut: string; motif: string | null }[];
  } | null;
  autorisationRef?: string;
  methodeSource?: string;
  versionMapping?: string;
}

interface Reception {
  id: string;
  reference: string;
  statut: Lot["statut"];
  dejaRecu: boolean;
  motifRejetLot: string | null;
  compteurs: { lues: number; validees: number; rejetees: number; ignorees: number };
}

const LIBELLE_STATUT: Record<Lot["statut"], string> = {
  RECU: "Reçu",
  VALIDE_SCHEMA: "Schéma validé — non appliqué",
  IMPORTE_TEST: "Importé en test",
  IMPORTE: "Importé",
  REJETE: "Rejeté",
};

function Statut({ statut }: { statut: Lot["statut"] }) {
  const style = statut === "REJETE" ? "bg-red-100 text-red-800"
    : statut === "VALIDE_SCHEMA" ? "bg-amber-100 text-amber-900"
    : "bg-emerald-100 text-emerald-800";
  const Icone = statut === "REJETE" ? XCircle : statut === "VALIDE_SCHEMA" ? AlertTriangle : CheckCircle2;
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${style}`}>
      <Icone className="h-3.5 w-3.5" /> {LIBELLE_STATUT[statut]}
    </span>
  );
}

export function ImportsPage() {
  const client = useQueryClient();
  const [selection, setSelection] = useState<string | null>(null);
  const fichierRef = useRef<HTMLInputElement>(null);
  // Suivi explicite du fichier choisi : le bouton reste inactif sans lui. On ne s'appuie pas sur
  // `required` pour un <input type="file"> -- la validation native ne voit pas toujours les
  // fichiers deposes par script, et un formulaire qui refuse de se soumettre sans rien dire
  // est pire qu'un bouton gris.
  const [fichierChoisi, setFichierChoisi] = useState(false);
  const [champs, setChamps] = useState({
    systemeSource: "ONR_BDR", format: "csv", methodeSource: "", versionMapping: "v0", autorisationRef: "",
  });

  const { data, isLoading } = useQuery({
    queryKey: ["imports"],
    queryFn: async () => (await api.get<{ lots: Lot[] }>("/v2/imports")).data,
  });

  const detail = useQuery({
    queryKey: ["imports", selection],
    enabled: selection !== null,
    queryFn: async () => (await api.get<Lot>(`/v2/imports/${selection}`)).data,
  });

  const recevoir = useMutation({
    mutationFn: async () => {
      const fichier = fichierRef.current?.files?.[0];
      if (!fichier) throw new Error("fichier manquant");
      const fd = new FormData();
      fd.append("fichier", fichier);
      Object.entries(champs).forEach(([k, v]) => fd.append(k, v));
      return (await api.post<Reception>("/v2/imports", fd)).data;
    },
    onSuccess: (r) => {
      if (r.dejaRecu) {
        toast.info(`Fichier déjà reçu : lot ${r.reference}. Rien n'a été écrit.`);
      } else if (r.statut === "REJETE") {
        toast.error(`Lot ${r.reference} rejeté : ${r.motifRejetLot ?? "aucune ligne conforme"}.`);
      } else {
        toast.success(`Lot ${r.reference} reçu : ${r.compteurs.validees} ligne(s) validée(s), ${r.compteurs.rejetees} rejetée(s), ${r.compteurs.ignorees} ignorée(s). Rien n'est encore appliqué.`);
      }
      setSelection(r.id);
      if (fichierRef.current) fichierRef.current.value = "";
      setFichierChoisi(false);
      void client.invalidateQueries({ queryKey: ["imports"] });
    },
    onError: (e) => {
      const r = (e as { response?: { data?: { error?: string } } }).response;
      toast.error(r?.data?.error ?? "Réception refusée.");
    },
  });

  const lots = data?.lots ?? [];
  const lot = detail.data;
  const peutEnvoyer = fichierChoisi && champs.methodeSource.trim() !== "" && champs.autorisationRef.trim() !== "";

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>Recevoir n'est pas importer.</strong> Un lot « schéma validé » a passé le contrôle du
        contrat ; <strong>rien n'a été créé dans le référentiel</strong>. L'application attend un premier
        échantillon approuvé. Et un fichier déjà reçu n'écrit rien : l'empreinte est calculée par le
        serveur sur les octets reçus.
      </div>

      <form
        className="grid gap-3 rounded-lg border bg-white p-4 md:grid-cols-3"
        onSubmit={(e) => { e.preventDefault(); recevoir.mutate(); }}
        aria-label="Recevoir un lot"
      >
        <label className="text-sm">Système source
          <input className="mt-1 w-full rounded border px-2 py-1" value={champs.systemeSource}
            onChange={(e) => setChamps({ ...champs, systemeSource: e.target.value })} required />
        </label>
        <label className="text-sm">Format
          <select className="mt-1 w-full rounded border px-2 py-1" value={champs.format}
            onChange={(e) => setChamps({ ...champs, format: e.target.value })}>
            <option value="csv">CSV (pivot, séparateur ;)</option>
            <option value="geojson">GeoJSON (4326)</option>
          </select>
        </label>
        <label className="text-sm">Méthode de la source
          <input className="mt-1 w-full rounded border px-2 py-1" value={champs.methodeSource} placeholder="export L²R Mesure, relevé tablette…"
            onChange={(e) => setChamps({ ...champs, methodeSource: e.target.value })} required />
        </label>
        <label className="text-sm">Version du mapping
          <input className="mt-1 w-full rounded border px-2 py-1" value={champs.versionMapping}
            onChange={(e) => setChamps({ ...champs, versionMapping: e.target.value })} required />
        </label>
        <label className="text-sm">Référence de l'autorisation écrite
          <input className="mt-1 w-full rounded border px-2 py-1" value={champs.autorisationRef} placeholder="obligatoire (§ B.4)"
            onChange={(e) => setChamps({ ...champs, autorisationRef: e.target.value })} required />
        </label>
        <label className="text-sm">Fichier
          <input ref={fichierRef} type="file" accept=".csv,.geojson,.json" className="mt-1 w-full text-sm" aria-label="Fichier"
            onChange={(e) => setFichierChoisi((e.target.files?.length ?? 0) > 0)} />
        </label>
        <div className="md:col-span-3">
          <Button type="submit" disabled={!peutEnvoyer || recevoir.isPending}>
            <FileUp className="mr-1 h-4 w-4" /> Recevoir le lot
          </Button>
        </div>
      </form>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-white">
          <div className="border-b px-4 py-2 text-sm font-medium">Lots reçus {isLoading ? "…" : `(${lots.length})`}</div>
          {lots.length === 0 && !isLoading && (
            <p className="p-4 text-sm text-gray-500">Aucun lot reçu.</p>
          )}
          <ul>
            {lots.map((l) => (
              <li key={l.id}>
                <button type="button" onClick={() => setSelection(l.id)}
                  className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-gray-50 ${selection === l.id ? "bg-gray-100" : ""}`}>
                  <span>
                    <span className="font-mono">{l.reference}</span>
                    <span className="ml-2 text-gray-600">{l.systemeSource} · {l.nomFichier}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-gray-600" title="lues / validées / rejetées / ignorées">
                      {l.lignesLues} · <span className="text-emerald-700">{l.lignesValidees}</span> · <span className="text-red-700">{l.lignesRejetees}</span> · <span className="text-gray-500">{l.lignesIgnorees}</span>
                    </span>
                    <Statut statut={l.statut} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-lg border bg-white p-4 text-sm">
          {!lot && <p className="text-gray-500">Sélectionnez un lot.</p>}
          {lot && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-mono text-base font-semibold">{lot.reference}</h2>
                <Statut statut={lot.statut} />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                <dt className="text-gray-500">Source</dt><dd>{lot.systemeSource} ({lot.format})</dd>
                <dt className="text-gray-500">Fichier</dt><dd>{lot.nomFichier}</dd>
                <dt className="text-gray-500">Reçu le</dt><dd>{new Date(lot.importeLe).toLocaleString("fr-FR")}</dd>
                <dt className="text-gray-500">Autorisation</dt><dd>{lot.autorisationRef}</dd>
                <dt className="text-gray-500">Méthode</dt><dd>{lot.methodeSource}</dd>
                <dt className="text-gray-500">Mapping</dt><dd>{lot.versionMapping}</dd>
              </dl>
              <table className="w-full text-center text-xs">
                <thead><tr className="text-gray-500"><th>Lues</th><th>Validées</th><th>Importées</th><th>Rejetées</th><th>En conflit</th><th>Ignorées</th></tr></thead>
                <tbody><tr className="font-medium">
                  <td>{lot.lignesLues}</td><td className="text-emerald-700">{lot.lignesValidees}</td><td>{lot.lignesImportees}</td>
                  <td className="text-red-700">{lot.lignesRejetees}</td><td>{lot.lignesEnConflit}</td><td className="text-gray-500">{lot.lignesIgnorees}</td>
                </tr></tbody>
              </table>
              {lot.statut === "VALIDE_SCHEMA" && (
                <p className="rounded bg-amber-50 p-2 text-amber-900">
                  {lot.lignesValidees} ligne(s) conformes au contrat, <strong>en attente d'application</strong>. Aucun objet n'a été créé.
                </p>
              )}
              {lot.rapport?.motifRejetLot && (
                <p className="rounded bg-red-50 p-2 text-red-800"><strong>Lot rejeté :</strong> {lot.rapport.motifRejetLot}</p>
              )}
              {lot.rapport?.premiersRejets && lot.rapport.premiersRejets.length > 0 && (
                <div>
                  <p className="mb-1 text-gray-500">Premiers rejets et mises à l'écart</p>
                  <ul className="space-y-1">
                    {lot.rapport.premiersRejets.map((r) => (
                      <li key={r.numeroLigne} className="font-mono text-xs">
                        l.{r.numeroLigne} <span className={r.statut === "REJETEE" ? "text-red-700" : "text-gray-500"}>{r.statut}</span> — {r.motif}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(lot.lignesRejetees > 0 || lot.lignesIgnorees > 0) && (
                <Button type="button" variant="outline"
                  onClick={() => downloadViaApi(`/v2/imports/${lot.id}/erreurs.csv`, `${lot.reference}-erreurs.csv`).catch(() => toast.error("Téléchargement impossible."))}>
                  <Download className="mr-1 h-4 w-4" /> Télécharger les erreurs (CSV)
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
