import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "../ui/Button";
import { rendreVisible } from "./CompteursLot";
import type { LotDetail } from "./types";

/**
 * Empreinte du fichier : algorithme, valeur, copie.
 *
 * LE MOT QU'ON N'EMPLOIE PAS : « vérifiée ». L'empreinte est CALCULÉE par le serveur sur les octets
 * reçus ; ce composant ne la compare à rien. Dire « vérifiée » laisserait croire à un contrôle
 * d'intégrité par rapport à la source, qui n'existe pas.
 */

type EtatCopie = "repos" | "copiee" | "echec";

export function ResumeEmpreinte({ empreinte, idTitre }: { empreinte: LotDetail["empreinte"]; idTitre?: string }) {
  const [etat, setEtat] = useState<EtatCopie>("repos");
  useEffect(() => { setEtat("repos"); }, [empreinte.valeur]);

  const algorithme = empreinte.algorithme === "sha256" ? "SHA-256" : String(empreinte.algorithme);
  const valeur = rendreVisible(empreinte.valeur);

  async function copier() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("presse-papiers indisponible");
      await navigator.clipboard.writeText(empreinte.valeur);
      setEtat("copiee");
    } catch {
      setEtat("echec");
    }
  }

  return (
    <div>
      <h3 id={idTitre} className="mb-1 text-sm font-semibold text-slate-900">Empreinte du fichier</h3>
      <p className="text-sm text-slate-700">
        Calculée par le serveur sur les octets reçus. Algorithme : <strong>{algorithme}</strong>.
      </p>
      {valeur === "" ? (
        <p className="mt-1 text-sm text-slate-700">Le serveur n'a pas fourni de valeur d'empreinte pour ce lot.</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-start gap-2">
          <code className="block min-w-0 flex-1 break-all rounded border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-xs text-slate-900">
            {valeur}
          </code>
          <Button type="button" variant="outline" size="sm" className="min-h-[44px]" onClick={() => { void copier(); }}>
            <Copy aria-hidden="true" /> Copier l'empreinte
          </Button>
        </div>
      )}
      <p role="status" aria-live="polite" className="mt-1 min-h-4 text-xs text-slate-700">
        {etat === "copiee" && "Empreinte copiée."}
        {etat === "echec" && "Copie impossible : sélectionnez la valeur et copiez-la à la main."}
      </p>
    </div>
  );
}
