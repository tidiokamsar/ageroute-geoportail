import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Input } from "./ui/Input";
import type { PaginatedResult, Troncon } from "../types";

// Selecteur de troncon recherchable (le reseau compte ~1580 troncons : pas de <select> brut).
// Interroge /troncons?search= cote serveur et renvoie l'id du troncon choisi via onChange.
export function TronconPicker({
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
    queryKey: ["troncons", "picker", query],
    queryFn: async () =>
      (await api.get<PaginatedResult<Troncon>>("/troncons", { params: { search: query, pageSize: 8 } })).data,
    enabled: open && query.length >= 1,
  });

  return (
    <div className="relative">
      <Input
        value={open ? query : label}
        placeholder="Rechercher un tronçon (code ou nom)..."
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
          {data!.data.map((t) => (
            <button
              key={t.id}
              type="button"
              className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
              onMouseDown={() => {
                onChange(t.id);
                setLabel(`${t.code} — ${t.nom}`);
                setOpen(false);
              }}
            >
              <span className="font-medium">{t.code}</span> — {t.nom}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
