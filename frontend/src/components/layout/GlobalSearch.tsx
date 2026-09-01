import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Input } from "../ui/Input";

interface SearchResult {
  type: string;
  module: string;
  id: string;
  label: string;
}

const TYPE_LABELS: Record<string, string> = {
  troncon: "Tronçon",
  ouvrage: "Ouvrage",
  pointNoir: "Point noir",
  poste: "Péage/Pesage",
  chantier: "Chantier",
};

export function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ["search", q],
    queryFn: async () => (await api.get<SearchResult[]>("/search", { params: { q } })).data,
    enabled: open && q.trim().length >= 2,
  });

  return (
    <div className="relative w-80">
      <Input
        value={q}
        placeholder="Recherche globale (route, ouvrage, chantier)..."
        onFocus={() => setOpen(true)}
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (data?.length ?? 0) > 0 && (
        <div className="absolute z-30 mt-1 w-full bg-white rounded-lg shadow border border-gray-100 overflow-hidden max-h-80 overflow-y-auto">
          {data!.map((r) => (
            <button
              key={`${r.type}-${r.id}`}
              type="button"
              className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
              onMouseDown={() => {
                navigate(`/${r.module}?q=${encodeURIComponent(r.label)}`);
                setQ("");
                setOpen(false);
              }}
            >
              <span className="text-[10px] uppercase text-gray-400 mr-2">{TYPE_LABELS[r.type] ?? r.type}</span>
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
