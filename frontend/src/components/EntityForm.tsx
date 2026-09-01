import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Input, Select } from "./ui/Input";
import { Button } from "./ui/Button";
import { MapPointPicker } from "./MapPointPicker";
import { TronconPicker } from "./TronconPicker";
import { OuvragePicker } from "./OuvragePicker";
import type { Region, Bailleur } from "../types";

export interface FieldConfig {
  name: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "region" | "password" | "point" | "troncon" | "ouvrage" | "bailleur";
  options?: { value: string; label: string }[];
  required?: boolean;
}

interface Props {
  fields: FieldConfig[];
  defaultValues?: Record<string, unknown>;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  submitting?: boolean;
  /** Message d'erreur global renvoyé par le serveur (ex: conflit 409, erreur 500). */
  serverError?: string | null;
  /** Erreurs de validation par champ renvoyées par le serveur (Zod `details.fieldErrors`). */
  serverFieldErrors?: Record<string, string[]>;
}

const CLIENT_ERROR_MESSAGES: Record<string, string> = {
  required: "Ce champ est requis.",
  pattern: "Le format de ce champ est invalide.",
  min: "La valeur est trop petite.",
  max: "La valeur est trop grande.",
  minLength: "Ce champ est trop court.",
  maxLength: "Ce champ est trop long.",
};

function clientErrorMessage(type?: string): string {
  return (type && CLIENT_ERROR_MESSAGES[type]) ?? "Ce champ est invalide.";
}

export function EntityForm({ fields, defaultValues, onSubmit, submitting, serverError, serverFieldErrors }: Props) {
  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm({ defaultValues });
  const { data: regions } = useQuery({
    queryKey: ["regions"],
    queryFn: async () => (await api.get<Region[]>("/regions")).data,
    enabled: fields.some((f) => f.type === "region"),
  });
  const { data: bailleurs } = useQuery({
    queryKey: ["bailleurs"],
    queryFn: async () => (await api.get<Bailleur[]>("/bailleurs")).data,
    enabled: fields.some((f) => f.type === "bailleur"),
  });

  // Les <option> de region/bailleur n'existent qu'une fois la requete async terminee :
  // sans ce reset, react-hook-form a deja fige sa valeur initiale sur un <select> encore
  // vide a l'ouverture en edition, et le champ requis reste invalide en silence.
  useEffect(() => {
    if (regions || bailleurs) reset(defaultValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regions, bailleurs]);

  // Un champ number optionnel laisse vide produit NaN via valueAsNumber, serialise en
  // `null` par JSON.stringify — incompatible avec les schemas Zod `.optional()` qui
  // n'acceptent que `undefined`. On nettoie avant l'envoi plutot que de complexifier
  // chaque schema backend.
  function sanitize(values: Record<string, unknown>): Record<string, unknown> {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const isEmptyNumber = typeof value === "number" && isNaN(value);
      cleaned[key] = isEmptyNumber || value === null ? undefined : value;
    }
    return cleaned;
  }

  return (
    <form
      onSubmit={handleSubmit((values) => onSubmit(sanitize(values)))}
      className="space-y-3"
    >
      {serverError && (
        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {serverError}
        </div>
      )}
      {fields.map((field) => (
        <div key={field.name}>
          <label className="block text-xs font-medium text-gray-600 mb-1">{field.label}</label>
          {field.type === "point" ? (
            <>
              <MapPointPicker
                lat={watch("lat") as number | null | undefined}
                lon={watch("lon") as number | null | undefined}
                onChange={(lat, lon) => {
                  setValue("lat", lat);
                  setValue("lon", lon);
                }}
              />
              <p className="mt-1 text-xs text-gray-500">
                {watch("lat") != null
                  ? `Position : ${(watch("lat") as number).toFixed(5)}, ${(watch("lon") as number).toFixed(5)}`
                  : "Cliquez sur la carte pour positionner l'élément."}
              </p>
            </>
          ) : field.type === "troncon" ? (
            <TronconPicker
              value={watch(field.name) as string | null | undefined}
              initialLabel={
                (defaultValues?.troncon as { code?: string; nom?: string } | undefined)
                  ? `${(defaultValues!.troncon as { code: string }).code} — ${(defaultValues!.troncon as { nom: string }).nom}`
                  : undefined
              }
              onChange={(id) => setValue(field.name, id)}
            />
          ) : field.type === "ouvrage" ? (
            <OuvragePicker
              value={watch(field.name) as string | null | undefined}
              initialLabel={
                (defaultValues?.ouvrage as { nom?: string; type?: string } | undefined)
                  ? `${(defaultValues!.ouvrage as { nom: string }).nom} (${(defaultValues!.ouvrage as { type: string }).type})`
                  : undefined
              }
              onChange={(id) => setValue(field.name, id)}
            />
          ) : field.type === "select" ? (
            <Select {...register(field.name, { required: field.required })}>
              <option value="">—</option>
              {field.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : field.type === "region" ? (
            <Select {...register(field.name, { required: field.required, valueAsNumber: true })}>
              <option value="">—</option>
              {regions?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.nom}
                </option>
              ))}
            </Select>
          ) : field.type === "bailleur" ? (
            <Select {...register(field.name, { required: field.required, valueAsNumber: true })}>
              <option value="">—</option>
              {bailleurs?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.nom}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              type={field.type}
              step={field.type === "number" ? "any" : undefined}
              required={field.required}
              {...register(field.name, {
                required: field.required,
                valueAsNumber: field.type === "number",
              })}
            />
          )}
          {errors[field.name] ? (
            <p className="mt-1 text-xs text-red-600">
              {clientErrorMessage(errors[field.name]?.type as string | undefined)}
            </p>
          ) : (
            serverFieldErrors?.[field.name] && (
              <p className="mt-1 text-xs text-red-600">{serverFieldErrors[field.name].join(" ")}</p>
            )
          )}
        </div>
      ))}
      <Button type="submit" disabled={submitting} className="w-full mt-2">
        {submitting ? "Enregistrement..." : "Enregistrer"}
      </Button>
    </form>
  );
}
