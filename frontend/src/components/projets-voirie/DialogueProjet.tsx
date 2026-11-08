import { useId, useState } from "react";
import { Button } from "../ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/Input";
import { useCreerProjet } from "../../lib/projetsVoirieHooks";
import type { ProjetFiche } from "../../lib/projetsVoirieApi";
import { MOTIF_CODE_PROJET, classerErreur, erreurLargeurs, lireSaisieNombre, type ErreurPv } from "../../lib/projetsVoirie";

/** Creation d'un projet : code, nom, commune, prefecture, largeurs (15 m d'emprise et 7 m de chaussee par defaut, THEORIQUES tant que non validees). */

const CODE_VALIDE = MOTIF_CODE_PROJET;

export function DialogueProjet({ onFermer, onCree, enLigne }: { onFermer: () => void; onCree: (p: ProjetFiche) => void; enLigne: boolean }) {
  const id = useId();
  const creer = useCreerProjet();
  const [v, setV] = useState({ code: "", nom: "", commune: "", prefecture: "", emprise: "15", chaussee: "7" });
  const [erreurs, setErreurs] = useState<Record<string, string>>({});
  const [erreurServeur, setErreurServeur] = useState<ErreurPv | null>(null);

  const maj = (p: Partial<typeof v>) => { setV((x) => ({ ...x, ...p })); setErreurs({}); setErreurServeur(null); };

  async function soumettre() {
    const e: Record<string, string> = {};
    const code = v.code.trim().toUpperCase();
    if (!CODE_VALIDE.test(code)) e.code = "Le code compte 2 à 64 caractères : majuscules, chiffres, tiret ou souligné, en commençant par une lettre ou un chiffre (exemple : KISSI-VOIRIE-2026).";
    if (v.nom.trim().length < 3) e.nom = "Saisissez le nom du projet (3 caractères minimum).";
    const emprise = lireSaisieNombre(v.emprise);
    const chaussee = lireSaisieNombre(v.chaussee);
    const el = erreurLargeurs(emprise, chaussee);
    if (el) e.largeurs = el;
    setErreurs(e);
    if (Object.keys(e).length > 0 || emprise === null || chaussee === null) return;
    try {
      const p = await creer.mutateAsync({
        code, nom: v.nom.trim(),
        ...(v.commune.trim() ? { commune: v.commune.trim() } : {}),
        ...(v.prefecture.trim() ? { prefecture: v.prefecture.trim() } : {}),
        largeurEmpriseM: emprise, largeurChausseeM: chaussee,
      });
      onCree(p);
    } catch (err) {
      const c = classerErreur(err);
      setErreurServeur(c);
      const champs: Record<string, string> = {};
      for (const [k, m] of Object.entries(c.champs)) if (m[0]) champs[k] = m[0];
      if (Object.keys(champs).length > 0) setErreurs(champs);
    }
  }

  const champ = (cle: string, libelle: string, valeur: string, onChange: (s: string) => void, extra?: { aide?: string; erreur?: string; max?: number }) => (
    <div>
      <label htmlFor={`${id}-${cle}`} className="block text-sm font-medium text-gray-900">{libelle}</label>
      <Input id={`${id}-${cle}`} value={valeur} onChange={(e) => onChange(e.target.value)} disabled={creer.isPending} maxLength={extra?.max ?? 120} autoComplete="off"
        aria-invalid={extra?.erreur ? true : undefined} aria-describedby={extra?.erreur ? `${id}-${cle}-err` : extra?.aide ? `${id}-${cle}-aide` : undefined} className="mt-1 border-gray-300" />
      {extra?.aide && !extra.erreur && <p id={`${id}-${cle}-aide`} className="mt-0.5 text-xs text-gray-600">{extra.aide}</p>}
      {extra?.erreur && <p id={`${id}-${cle}-err`} role="alert" className="mt-0.5 text-xs text-red-700">{extra.erreur}</p>}
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !creer.isPending) onFermer(); }}>
      <DialogContent masquerCroix className="max-h-[90vh] max-w-lg overflow-y-auto" onInteractOutside={(e) => e.preventDefault()}>
        <DialogTitle className="text-base font-semibold text-primary">Nouveau projet de voirie et réseaux</DialogTitle>
        <DialogDescription className="text-sm text-gray-700">Un projet réunit un plan d&apos;axes de travaux, les réseaux de concessionnaires et les limites de route. Les données se chargent ensuite depuis la page du projet.</DialogDescription>
        <form className="space-y-3" aria-label="Nouveau projet" noValidate onSubmit={(ev) => { ev.preventDefault(); void soumettre(); }}>
          {champ("code", "Code du projet", v.code, (s) => maj({ code: s }), { aide: "Identifiant unique, par exemple KISSI-VOIRIE-2026.", erreur: erreurs.code, max: 60 })}
          {champ("nom", "Nom du projet", v.nom, (s) => maj({ nom: s }), { erreur: erreurs.nom, max: 200 })}
          <div className="grid gap-3 sm:grid-cols-2">
            {champ("commune", "Commune (facultatif)", v.commune, (s) => maj({ commune: s }), { erreur: erreurs.commune })}
            {champ("prefecture", "Préfecture (facultatif)", v.prefecture, (s) => maj({ prefecture: s }), { erreur: erreurs.prefecture })}
          </div>
          <fieldset className="space-y-2 rounded-md border border-gray-200 p-3">
            <legend className="px-1 text-sm font-semibold text-navy">Largeurs de calcul (théoriques)</legend>
            <p className="text-xs text-gray-700">Valeurs par défaut du module, <strong>théoriques</strong> tant qu&apos;un administrateur ne les a pas validées. Modifiables ensuite.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {champ("chaussee", "Chaussée (m)", v.chaussee, (s) => maj({ chaussee: s }), { max: 8 })}
              {champ("emprise", "Emprise (m)", v.emprise, (s) => maj({ emprise: s }), { max: 8 })}
            </div>
            {erreurs.largeurs && <p role="alert" className="text-xs text-red-700">{erreurs.largeurs}</p>}
          </fieldset>
          {erreurServeur && <p role="alert" data-code={erreurServeur.code ?? undefined} className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-900">{erreurServeur.message}</p>}
          {!enLigne && <p role="alert" className="text-sm text-amber-900">Vous êtes hors ligne : la création a besoin du réseau.</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={creer.isPending} onClick={onFermer}>Annuler</Button>
            <Button type="submit" disabled={creer.isPending || !enLigne}>{creer.isPending ? "Création…" : "Créer le projet"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
