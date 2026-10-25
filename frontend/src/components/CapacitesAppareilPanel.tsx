import { useState } from "react";
import { Cpu } from "lucide-react";
import { lireCapacites, modulesPossibles, type RapportCapacites } from "../lib/capacitesAppareil";
import { toast } from "../lib/toast";

/**
 * « Capacités de cet appareil » : ce que le navigateur de CE téléphone ou de CETTE tablette expose réellement (GPS, capteurs de
 * mouvement, caméra, stockage, calcul, batterie, réseau). Sert à savoir quels modules optionnels proposer et à remplir la fiche
 * de chaque appareil du pilote (copie du rapport en JSON). Lecture seule : rien n'est envoyé au serveur.
 */
export function CapacitesAppareilPanel() {
  const [rapport, setRapport] = useState<RapportCapacites | null>(null);
  const [enCours, setEnCours] = useState(false);

  async function lire() {
    setEnCours(true);
    try { setRapport(await lireCapacites()); } finally { setEnCours(false); }
  }

  async function copier() {
    if (!rapport) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(rapport, null, 2));
      toast.success("Rapport copié : le coller dans la fiche de l'appareil du pilote.");
    } catch {
      toast.error("Copie impossible sur ce navigateur : recopier les valeurs à la main.");
    }
  }

  const oui = (b: boolean) => (b ? "oui" : "non");
  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <button
        type="button" onClick={() => void lire()} disabled={enCours}
        className="flex items-center gap-1.5 text-sm font-medium text-navy underline disabled:text-gray-500"
      >
        <Cpu className="h-4 w-4" aria-hidden="true" />{enCours ? "Lecture…" : rapport ? "Relire les capacités de cet appareil" : "Voir les capacités de cet appareil"}
      </button>
      {rapport && (
        <div className="mt-2 space-y-2 text-sm">
          <ul aria-label="Modules possibles sur cet appareil" className="space-y-1">
            {modulesPossibles(rapport).map((m) => (
              <li key={m.module}><strong>{m.module}</strong> : {m.possible ? "possible" : "indisponible"}. <span className="text-xs text-gray-600">{m.raison}</span></li>
            ))}
          </ul>
          <dl aria-label="Valeurs lues sur l'appareil" className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <div className="flex justify-between gap-2"><dt className="text-gray-600">Cœurs logiques</dt><dd>{rapport.calcul.coeursLogiques.etat === "oui" ? rapport.calcul.coeursLogiques.valeur : "non communiqué"}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-gray-600">Mémoire annoncée par le navigateur</dt><dd>{rapport.calcul.memoireNavigateurGo.etat === "oui" ? `${rapport.calcul.memoireNavigateurGo.valeur} Go (arrondi)` : "non communiquée"}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-gray-600">WebAssembly · WebGL2 · WebGPU</dt><dd>{oui(rapport.calcul.webAssembly)} · {oui(rapport.calcul.webgl2)} · {oui(rapport.calcul.webgpu)}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-gray-600">Batterie</dt><dd>{rapport.energie.api ? `${rapport.energie.niveauPourcent ?? "?"} %${rapport.energie.enCharge ? ", en charge" : ""}` : "non communiquée"}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-gray-600">Stockage utilisé</dt><dd>{rapport.stockage.usageMo === null ? "non communiqué" : `${rapport.stockage.usageMo.toFixed(0)} Mo sur ${(rapport.stockage.quotaMo ?? 0).toFixed(0)} Mo`}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-gray-600">Réseau</dt><dd>{rapport.reseau.enLigne ? "en ligne" : "hors ligne"}{rapport.reseau.typeEffectif ? `, ${rapport.reseau.typeEffectif}` : ""}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-gray-600">Écran</dt><dd>{rapport.ecran.largeur} × {rapport.ecran.hauteur} px (×{rapport.ecran.ratioPixels})</dd></div>
          </dl>
          <p className="text-xs text-gray-600">« Possible » ne veut pas dire « utile ». Aucune vitesse de calcul ni consommation n'est mesurée ici : elles le sont lors du pilote.</p>
          <button type="button" onClick={() => void copier()} className="text-xs font-medium text-navy underline">Copier le rapport (JSON)</button>
        </div>
      )}
    </div>
  );
}
