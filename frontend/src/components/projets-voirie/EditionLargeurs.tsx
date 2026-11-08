import { useId, useState } from "react";
import { Eye, Save, Undo2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { classerErreur, erreurLargeurs, lireSaisieNombre, type Largeurs, type StatutParametres } from "../../lib/projetsVoirie";
import { toast } from "../../lib/toast";

/**
 * Edition des largeurs d'emprise et de chaussee.
 *
 * DEUX GESTES DISTINCTS : « Previsualiser » relance l'analyse avec ces largeurs SANS RIEN ENREGISTRER (parametres de requete) ;
 * « Enregistrer » ecrit les largeurs du projet (et les remet a « theorique » : seul un ADMIN peut les marquer « validees »).
 * Tant qu'un apercu est actif, la page le dit.
 */

export interface PropsEditionLargeurs {
  enregistrees: Largeurs;
  statut: StatutParametres;
  apercu: Largeurs | null;
  onApercu: (l: Largeurs | null) => void;
  peutEcrire: boolean;
  estAdmin: boolean;
  enLigne: boolean;
  enregistrer: (corps: Largeurs & { statutParametres?: "VALIDE" }) => Promise<unknown>;
}

const enChaine = (n: number) => String(n).replace(".", ",");

export function EditionLargeurs({ enregistrees, statut, apercu, onApercu, peutEcrire, estAdmin, enLigne, enregistrer }: PropsEditionLargeurs) {
  const idEmprise = useId();
  const idChaussee = useId();
  const idErreur = useId();
  const [emprise, setEmprise] = useState(enChaine((apercu ?? enregistrees).largeurEmpriseM));
  const [chaussee, setChaussee] = useState(enChaine((apercu ?? enregistrees).largeurChausseeM));
  const [valider, setValider] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreurServeur, setErreurServeur] = useState<string | null>(null);

  const e = lireSaisieNombre(emprise);
  const c = lireSaisieNombre(chaussee);
  const erreur = erreurLargeurs(e, c);
  const modifie = e !== enregistrees.largeurEmpriseM || c !== enregistrees.largeurChausseeM;

  async function surEnregistrer() {
    if (erreur || e === null || c === null) return;
    setEnCours(true);
    setErreurServeur(null);
    try {
      await enregistrer({ largeurEmpriseM: e, largeurChausseeM: c, ...(valider && estAdmin ? { statutParametres: "VALIDE" as const } : {}) });
      onApercu(null);
      setValider(false);
      toast.success(valider && estAdmin ? "Largeurs enregistrées et validées." : "Largeurs enregistrées (théoriques, non validées).");
    } catch (err) {
      setErreurServeur(classerErreur(err).message);
    } finally {
      setEnCours(false);
    }
  }

  function surAnnuler() {
    onApercu(null);
    setEmprise(enChaine(enregistrees.largeurEmpriseM));
    setChaussee(enChaine(enregistrees.largeurChausseeM));
    setErreurServeur(null);
  }

  return (
    <form aria-label="Largeurs d'emprise et de chaussée" className="space-y-2 rounded-md border border-gray-200 bg-white p-3" onSubmit={(ev) => { ev.preventDefault(); if (!erreur && e !== null && c !== null) onApercu({ largeurEmpriseM: e, largeurChausseeM: c }); }}>
      <p className="text-xs text-gray-700">
        Largeurs appliquées de part et d&apos;autre de chaque axe (demi-largeurs).
        {statut !== "VALIDE" && <> Elles sont <strong>théoriques</strong> tant qu&apos;un administrateur ne les a pas validées.</>}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={idChaussee} className="block text-xs font-medium text-gray-800">Chaussée (m)</label>
          <Input id={idChaussee} inputMode="decimal" autoComplete="off" value={chaussee} onChange={(ev) => setChaussee(ev.target.value)} aria-invalid={erreur ? true : undefined} aria-describedby={erreur ? idErreur : undefined} className="border-gray-300" />
        </div>
        <div>
          <label htmlFor={idEmprise} className="block text-xs font-medium text-gray-800">Emprise (m)</label>
          <Input id={idEmprise} inputMode="decimal" autoComplete="off" value={emprise} onChange={(ev) => setEmprise(ev.target.value)} aria-invalid={erreur ? true : undefined} aria-describedby={erreur ? idErreur : undefined} className="border-gray-300" />
        </div>
      </div>
      {erreur && <p id={idErreur} role="alert" className="text-xs text-red-700">{erreur}</p>}
      {apercu && <p role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">Aperçu non enregistré : l&apos;analyse affichée utilise ces largeurs, pas celles du projet.</p>}
      {estAdmin && (
        <label className="flex items-start gap-2 text-xs text-gray-800">
          <input type="checkbox" checked={valider} onChange={(ev) => setValider(ev.target.checked)} className="mt-0.5 h-4 w-4" />
          <span>Marquer ces largeurs comme validées (administrateur). Sans cette case, elles restent théoriques.</span>
        </label>
      )}
      {erreurServeur && <p role="alert" className="text-xs text-red-700">{erreurServeur}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!!erreur || !enLigne}>
          <Eye aria-hidden="true" /> Prévisualiser
        </Button>
        {peutEcrire && (
          <Button type="button" size="sm" className="min-h-[44px] xl:min-h-8" disabled={!!erreur || !enLigne || enCours || (!modifie && !(valider && estAdmin))} onClick={() => void surEnregistrer()}>
            <Save aria-hidden="true" /> {enCours ? "Enregistrement…" : "Enregistrer"}
          </Button>
        )}
        {(apercu || modifie) && (
          <Button type="button" size="sm" variant="ghost" className="min-h-[44px] xl:min-h-8" onClick={surAnnuler}>
            <Undo2 aria-hidden="true" /> Revenir aux largeurs du projet
          </Button>
        )}
      </div>
    </form>
  );
}
