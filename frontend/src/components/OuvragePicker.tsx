import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Input } from "./ui/Input";
import type { Ouvrage, PaginatedResult } from "../types";

// Selecteur d'ouvrage recherchable, sur le meme modele que TronconPicker — evite la
// saisie manuelle d'un UUID brut pour le champ optionnel "ouvrage" d'une inspection.
export function OuvragePicker({
  value,
  initialLabel,
  onChange,
}: {
  value: string | null | undefined;
  initialLabel?: string;
  onChange: (id: string | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(initialLabel ?? "");

  useEffect(() => {
    if (!value) setLabel("");
  }, [value]);

  const { data } = useQuery({
    queryKey: ["ouvrages", "picker", query],
    queryFn: async () =>
      (await api.get<PaginatedResult<Ouvrage>>("/ouvrages", { params: { search: query, pageSize: 8 } })).data,
    enabled: open && query.length >= 1,
  });

  return (
    <div className="relative">
      <Input
        value={open ? query : label}
        placeholder="Rechercher un ouvrage (nom)..."
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {value && !open && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="absolute right-2 top-2 text-xs text-gray-400 hover:text-red-600"
        >
          ✕
        </button>
      )}
      {open && (data?.data?.length ?? 0) > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-white rounded-lg shadow border border-gray-100 overflow-hidden max-h-48 overflow-y-auto">
          {data!.data.map((o) => (
            <button
              key={o.id}
              type="button"
              className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
              onMouseDown={() => {
                onChange(o.id);
                setLabel(`${o.nom} (${o.type})`);
                setOpen(false);
              }}
            >
              <span className="font-medium">{o.nom}</span> — {o.type}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
