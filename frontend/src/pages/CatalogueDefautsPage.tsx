import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Check, Pencil, RefreshCw, Save, X } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { api } from "../lib/api";
import { parseApiError } from "../lib/errors";
import { toast } from "../lib/toast";
import type { MesureDefaut } from "../lib/defautsTerrain";

const FAMILLES = ["CHAUSSEE", "ACCOTEMENT", "ASSAINISSEMENT", "OUVRAGE", "SIGNALISATION", "SECURITE", "ENVIRONNEMENT"] as const;
const UNITES = ["UNITE", "METRE", "METRE_CARRE", "METRE_CUBE"] as const;
const MESURES: { key: MesureDefaut; label: string }[] = [
  { key: "NOMBRE", label: "Nombre" }, { key: "LONGUEUR", label: "Longueur" },
  { key: "LARGEUR", label: "Largeur" }, { key: "PROFONDEUR", label: "Profondeur" },
  { key: "QUANTITE", label: "Quantité relevée" },
];

type Famille = (typeof FAMILLES)[number];
type Unite = (typeof UNITES)[number];
type Catalogue = {
  id: number;
  code: string;
  libelle: string;
  famille: Famille;
  unite: Unite;
  mesuresRequises: MesureDefaut[];
  graviteMax: number | null;
  description: string | null;
  source: string;
  version: number;
  actif: boolean;
};
type FormulaireCatalogue = Omit<Catalogue, "id" | "version">;

const VIDE: FormulaireCatalogue = {
  code: "", libelle: "", famille: "CHAUSSEE", unite: "UNITE", mesuresRequises: [],
  graviteMax: 4, description: "", source: "", actif: true,
};

export function CatalogueDefautsPage() {
  const queryClient = useQueryClient();
  const [codeEdition, setCodeEdition] = useState<string | null>(null);
  const [formulaire, setFormulaire] = useState<FormulaireCatalogue>(VIDE);
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["rai-v2", "defauts", "catalogue-admin"],
    queryFn: async () => (await api.get<{ catalogue: Catalogue[] }>("/v2/defauts/catalogue/admin")).data,
  });

  const sauvegarder = useMutation({
    mutationFn: async ({ code, draft }: { code: string | null; draft: FormulaireCatalogue }) => {
      if (code) {
        const current = (data?.catalogue ?? []).find((item) => item.code === code);
        if (!current) throw new Error("Cette entrée n'est plus dans le référentiel chargé.");
        const { code: _immutableCode, ...changes } = draft;
        return api.patch(`/v2/defauts/catalogue/${encodeURIComponent(code)}`, { ...changes, version: current.version });
      }
      return api.post("/v2/defauts/catalogue", draft);
    },
    onSuccess: async () => {
      toast.success(codeEdition ? "Type de défaut mis à jour. Une nouvelle version a été créée." : "Type de défaut ajouté au référentiel.");
      reinitialiser();
      await queryClient.invalidateQueries({ queryKey: ["rai-v2", "defauts", "catalogue-admin"] });
      await queryClient.invalidateQueries({ queryKey: ["rai-v2", "defauts", "validation"] });
    },
    onError: (saveError) => toast.error(parseApiError(saveError).message),
  });
  const basculerActif = useMutation({
    mutationFn: async (item: Catalogue) => api.patch(`/v2/defauts/catalogue/${encodeURIComponent(item.code)}`, {
      libelle: item.libelle, famille: item.famille, unite: item.unite,
      mesuresRequises: item.mesuresRequises, graviteMax: item.graviteMax,
      description: item.description, source: item.source, actif: !item.actif,
      version: item.version,
    }),
    onSuccess: async () => {
      toast.success("Statut du type mis à jour ; les défauts déjà liés sont conservés.");
      await queryClient.invalidateQueries({ queryKey: ["rai-v2", "defauts", "catalogue-admin"] });
      await queryClient.invalidateQueries({ queryKey: ["rai-v2", "defauts", "catalogue-terrain"] });
    },
    onError: (saveError) => toast.error(parseApiError(saveError).message),
  });

  function reinitialiser() {
    setCodeEdition(null);
    setFormulaire(VIDE);
  }

  function modifier(item: Catalogue) {
    setCodeEdition(item.code);
    setFormulaire({
      code: item.code, libelle: item.libelle, famille: item.famille, unite: item.unite,
      mesuresRequises: [...item.mesuresRequises], graviteMax: item.graviteMax,
      description: item.description ?? "", source: item.source, actif: item.actif,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function basculerMesure(mesure: MesureDefaut, checked: boolean) {
    setFormulaire((current) => ({
      ...current,
      mesuresRequises: checked
        ? [...new Set([...current.mesuresRequises, mesure])]
        : current.mesuresRequises.filter((item) => item !== mesure),
    }));
  }

  function soumettre(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (formulaire.graviteMax === 0) {
      toast.error("La gravité maximale doit être comprise entre 1 et 10, ou laissée vide.");
      return;
    }
    sauvegarder.mutate({ code: codeEdition, draft: formulaire });
  }

  const catalogue = data?.catalogue ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy">Catalogue des défauts</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">Référentiel partagé par les formulaires terrain et les moteurs de métré. Les modifications avancent la version et sont auditées.</p>
        </div>
        <Button variant="secondary" onClick={() => void refetch()}><RefreshCw className="h-4 w-4" /> Actualiser</Button>
      </div>

      <Card>
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-lg bg-amber-50 p-2 text-amber-700"><Archive className="h-5 w-5" /></div>
          <p className="text-sm text-gray-600">Il n’y a pas de suppression physique : désactiver un type le retire des nouvelles saisies, tout en conservant les défauts et l’historique déjà associés.</p>
        </div>
        <form onSubmit={soumettre} className="space-y-4">
          <h2 className="font-semibold text-navy">{codeEdition ? `Modifier ${codeEdition}` : "Ajouter un type"}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-xs font-medium text-gray-600">Code stable
              <Input required minLength={2} maxLength={64} pattern="[A-Z][A-Z0-9_]{1,63}" disabled={codeEdition !== null} value={formulaire.code} onChange={(e) => setFormulaire({ ...formulaire, code: e.target.value.toUpperCase() })} placeholder="NID_POULE" className="mt-1" />
            </label>
            <label className="block text-xs font-medium text-gray-600">Libellé
              <Input required minLength={2} maxLength={160} value={formulaire.libelle} onChange={(e) => setFormulaire({ ...formulaire, libelle: e.target.value })} className="mt-1" />
            </label>
            <label className="block text-xs font-medium text-gray-600">Famille
              <select value={formulaire.famille} onChange={(e) => setFormulaire({ ...formulaire, famille: e.target.value as Famille })} className="mt-1 h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm">
                {FAMILLES.map((famille) => <option key={famille} value={famille}>{famille.replaceAll("_", " ")}</option>)}
              </select>
            </label>
            <label className="block text-xs font-medium text-gray-600">Unité de métré
              <select value={formulaire.unite} onChange={(e) => setFormulaire({ ...formulaire, unite: e.target.value as Unite })} className="mt-1 h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-sm">
                {UNITES.map((unite) => <option key={unite} value={unite}>{unite.replaceAll("_", " ")}</option>)}
              </select>
            </label>
          </div>
          <fieldset>
            <legend className="mb-2 text-xs font-medium text-gray-600">Mesures obligatoires avant soumission</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {MESURES.map(({ key, label }) => <label key={key} className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={formulaire.mesuresRequises.includes(key)} onChange={(e) => basculerMesure(key, e.target.checked)} />{label}</label>)}
            </div>
          </fieldset>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-xs font-medium text-gray-600">Gravité maximale (vide si non gradué)
              <Input type="number" min={1} max={10} value={formulaire.graviteMax ?? ""} onChange={(e) => setFormulaire({ ...formulaire, graviteMax: e.target.value ? Number(e.target.value) : null })} className="mt-1" />
            </label>
            <label className="block text-xs font-medium text-gray-600">Source du vocabulaire ou de la règle
              <Input required minLength={3} maxLength={200} value={formulaire.source} onChange={(e) => setFormulaire({ ...formulaire, source: e.target.value })} placeholder="Référentiel technique, édition, date…" className="mt-1" />
            </label>
          </div>
          <label className="block text-xs font-medium text-gray-600">Description
            <textarea maxLength={2000} rows={2} value={formulaire.description ?? ""} onChange={(e) => setFormulaire({ ...formulaire, description: e.target.value })} className="mt-1 w-full rounded-md border border-gray-300 p-2 text-sm" />
          </label>
          {codeEdition && <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={formulaire.actif} onChange={(e) => setFormulaire({ ...formulaire, actif: e.target.checked })} />Disponible pour les nouvelles saisies terrain</label>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={sauvegarder.isPending}><Save className="h-4 w-4" />{sauvegarder.isPending ? "Enregistrement…" : "Enregistrer"}</Button>
            {codeEdition && <Button type="button" variant="secondary" onClick={reinitialiser}><X className="h-4 w-4" />Annuler</Button>}
          </div>
        </form>
      </Card>

      <section className="space-y-3" aria-label="Entrées du catalogue">
        <h2 className="font-semibold text-navy">Entrées du référentiel ({catalogue.length})</h2>
        {isPending ? <Card><p className="text-sm text-gray-500">Chargement du catalogue…</p></Card>
          : error ? <Card><p className="text-sm text-red-700">{parseApiError(error).message}</p></Card>
            : catalogue.map((item) => (
              <Card key={item.code} className={!item.actif ? "opacity-70" : ""}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-navy">{item.libelle}</h3><span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600">{item.code}</span><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${item.actif ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-600"}`}>{item.actif ? "Actif" : "Désactivé"}</span></div>
                    <p className="mt-1 text-xs text-gray-500">{item.famille.replaceAll("_", " ")} · {item.unite.replaceAll("_", " ")} · v{item.version} · Source : {item.source}</p>
                    <p className="mt-1 text-xs text-gray-600">Mesures : {item.mesuresRequises.length ? item.mesuresRequises.join(", ") : "aucune obligatoire"} · Gravité : {item.graviteMax ?? "non graduée"}</p>
                    {item.description && <p className="mt-1 text-sm text-gray-600">{item.description}</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="secondary" onClick={() => modifier(item)}><Pencil className="h-4 w-4" /> Modifier</Button>
                    <Button size="sm" variant={item.actif ? "outline" : "secondary"} disabled={basculerActif.isPending} onClick={() => basculerActif.mutate(item)}>{item.actif ? <Archive className="h-4 w-4" /> : <Check className="h-4 w-4" />}{item.actif ? "Désactiver" : "Réactiver"}</Button>
                  </div>
                </div>
              </Card>
            ))}
      </section>
    </div>
  );
}
