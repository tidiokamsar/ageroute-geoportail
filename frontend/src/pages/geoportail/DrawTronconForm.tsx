import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog";
import { Button } from "../../components/ui/Button";
import { api } from "../../lib/api";
import type { Region } from "../../types";

interface Props {
  points: [number, number][];
  lengthKm: number;
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  code: string;
  nom: string;
  classe: string;
  pkDebut: string;
  pkFin: string;
  regionId: string;
  revetement: string;
  etat: string;
  prefecture: string;
  commune: string;
  observations: string;
}

const EMPTY: FormState = {
  code: "", nom: "", classe: "RN", pkDebut: "0", pkFin: "",
  regionId: "", revetement: "BITUME", etat: "NON_EVALUE",
  prefecture: "", commune: "", observations: "",
};

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

const INPUT = "w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy/30";
const SELECT = INPUT;

export function DrawTronconForm({ points, lengthKm, onClose, onSaved }: Props) {
  const [form, setForm] = useState<FormState>({ ...EMPTY, pkFin: lengthKm.toFixed(2) });
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data: regions } = useQuery({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      if (!form.code.trim()) throw new Error("Le code est requis");
      if (!form.nom.trim()) throw new Error("Le nom est requis");
      if (!form.regionId) throw new Error("La région est requise");

      const geom = {
        type: "LineString" as const,
        coordinates: points.map(([lat, lon]) => [lon, lat]),
      };

      await api.post("/troncons", {
        code: form.code.trim(),
        nom: form.nom.trim(),
        classe: form.classe,
        regionId: Number(form.regionId),
        longueurKm: lengthKm,
        revetement: form.revetement,
        etat: form.etat || undefined,
        pkDebut: Number(form.pkDebut) || 0,
        pkFin: Number(form.pkFin) || lengthKm,
        prefecture: form.prefecture.trim() || undefined,
        commune: form.commune.trim() || undefined,
        observations: form.observations.trim() || undefined,
        geom,
      });
    },
    onSuccess() {
      qc.invalidateQueries({ queryKey: ["troncons"] });
      onSaved();
    },
    onError(err: unknown) {
      setError(err instanceof Error ? err.message : "Erreur lors de la sauvegarde");
    },
  });

  function set(k: keyof FormState, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
    setError(null);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogTitle className="text-base font-semibold text-navy flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full bg-red-500" />
          Nouveau tronçon — {lengthKm.toFixed(2)} km tracés
        </DialogTitle>

        <p className="text-xs text-gray-400 -mt-1">
          {points.length} points • Complétez les informations puis validez pour enregistrer.
        </p>

        <div className="grid grid-cols-2 gap-3 mt-2">
          <Field label="Code du tronçon" required>
            <input className={INPUT} value={form.code} onChange={(e) => set("code", e.target.value)} placeholder="Ex: RN1-001" />
          </Field>
          <Field label="Classe de route" required>
            <select className={SELECT} value={form.classe} onChange={(e) => set("classe", e.target.value)}>
              <option value="RN">Route Nationale (RN)</option>
              <option value="RR">Route Préfectorale (RP)</option>
              <option value="RU">Voirie Urbaine (VU)</option>
              <option value="PISTE">Piste Rurale</option>
            </select>
          </Field>

          <Field label="Nom / Intitulé" required>
            <input className={`${INPUT} col-span-2`} value={form.nom} onChange={(e) => set("nom", e.target.value)} placeholder="Ex: Conakry — Coyah" />
          </Field>
          <div />

          <Field label="Région" required>
            <select className={SELECT} value={form.regionId} onChange={(e) => set("regionId", e.target.value)}>
              <option value="">— Choisir —</option>
              {regions?.filter((r) => r.nom !== "Non renseigné").map((r) => (
                <option key={r.id} value={r.id}>{r.nom}</option>
              ))}
            </select>
          </Field>
          <Field label="Préfecture">
            <input className={INPUT} value={form.prefecture} onChange={(e) => set("prefecture", e.target.value)} placeholder="Ex: Coyah" />
          </Field>

          <Field label="Commune">
            <input className={INPUT} value={form.commune} onChange={(e) => set("commune", e.target.value)} placeholder="Ex: Commune urbaine" />
          </Field>
          <Field label="PK début">
            <input type="number" className={INPUT} value={form.pkDebut} onChange={(e) => set("pkDebut", e.target.value)} min={0} step={0.1} />
          </Field>

          <Field label="PK fin">
            <input type="number" className={INPUT} value={form.pkFin} onChange={(e) => set("pkFin", e.target.value)} min={0} step={0.1} />
          </Field>
          <Field label="Longueur (calculée)">
            <div className="flex items-center h-8 px-2.5 rounded-md border border-gray-100 bg-gray-50 text-sm font-semibold text-navy">
              {lengthKm.toFixed(3)} km
            </div>
          </Field>

          <Field label="Revêtement" required>
            <select className={SELECT} value={form.revetement} onChange={(e) => set("revetement", e.target.value)}>
              <option value="BITUME">Bitume</option>
              <option value="TERRE">Terre</option>
              <option value="LATERITE">Latérite</option>
              <option value="PAVE">Pavé</option>
            </select>
          </Field>
          <Field label="État">
            <select className={SELECT} value={form.etat} onChange={(e) => set("etat", e.target.value)}>
              <option value="NON_EVALUE">Non évalué</option>
              <option value="BON">Bon</option>
              <option value="MOYEN">Moyen</option>
              <option value="MAUVAIS">Mauvais</option>
              <option value="CRITIQUE">Critique</option>
            </select>
          </Field>
        </div>

        <Field label="Observations">
          <textarea
            className={`${INPUT} resize-none`}
            rows={3}
            value={form.observations}
            onChange={(e) => set("observations", e.target.value)}
            placeholder="Notes sur ce tronçon…"
          />
        </Field>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Annuler
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Enregistrement…" : "Enregistrer le tronçon"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
