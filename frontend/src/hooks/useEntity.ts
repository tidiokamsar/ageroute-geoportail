import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { parseApiError } from "../lib/errors";
import type { PaginatedResult } from "../types";

export interface ListQuery {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  search?: string;
  region?: string;
  etat?: string;
  type?: string;
  archived?: boolean;
  priorite?: string;
  aTraiter?: string;
}

export interface BulkResult {
  success: number;
  failed: { id: string; message: string }[];
}

export function useEntityList<T>(endpoint: string, query: ListQuery) {
  return useQuery({
    queryKey: [endpoint, "list", query],
    queryFn: async () => {
      const { data } = await api.get<PaginatedResult<T>>(`/${endpoint}`, { params: query });
      return data;
    },
  });
}

export function useEntityMutations(endpoint: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [endpoint] });

  // create/update : succes signale par toast (l'app etait silencieuse en cas de reussite).
  // Les erreurs restent gerees inline par les formulaires appelants (try/catch sur
  // mutateAsync) -> pas de onError ici pour eviter le double affichage.
  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.post(`/${endpoint}`, payload),
    onSuccess: () => {
      invalidate();
      toast.success("Enregistré");
    },
  });

  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      api.put(`/${endpoint}/${id}`, payload),
    onSuccess: () => {
      invalidate();
      toast.success("Modifications enregistrées");
    },
  });

  // remove/bulk : souvent declenches via .mutate() sans try/catch -> on gere succes ET
  // erreur par toast pour ne pas echouer en silence.
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/${endpoint}/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success("Élément archivé");
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const bulkArchive = useMutation({
    mutationFn: async (ids: string[]) => (await api.post<BulkResult>(`/${endpoint}/bulk-archive`, { ids })).data,
    onSuccess: (r) => {
      invalidate();
      toast.success(`${r.success} élément(s) archivé(s)${r.failed.length ? `, ${r.failed.length} échec(s)` : ""}`);
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  const bulkRestore = useMutation({
    mutationFn: async (ids: string[]) => (await api.post<BulkResult>(`/${endpoint}/bulk-restore`, { ids })).data,
    onSuccess: (r) => {
      invalidate();
      toast.success(`${r.success} élément(s) restauré(s)`);
    },
    onError: (err) => toast.error(parseApiError(err).message),
  });

  return { create, update, remove, bulkArchive, bulkRestore };
}
