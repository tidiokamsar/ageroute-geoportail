import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, ChevronsUpDown, Inbox } from "lucide-react";
import { Checkbox } from "./ui/checkbox";

interface Props<T extends { id: string }> {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  page: number;
  totalPages: number;
  total: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  onPageChange: (page: number) => void;
  onSortChange: (sortBy: string) => void;
  loading?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onToggleSelectAll?: () => void;
  onRowClick?: (row: T) => void;
}

function buildPageNumbers(page: number, totalPages: number): (number | "...")[] {
  if (totalPages <= 0) return [];
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const pages: (number | "...")[] = [];
  if (page <= 4) {
    for (let i = 1; i <= 5; i++) pages.push(i);
    pages.push("...");
    pages.push(totalPages);
  } else if (page >= totalPages - 3) {
    pages.push(1);
    pages.push("...");
    for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    pages.push("...");
    pages.push(page - 1);
    pages.push(page);
    pages.push(page + 1);
    pages.push("...");
    pages.push(totalPages);
  }
  return pages;
}

export function DataTable<T extends { id: string }>({
  data,
  columns,
  page,
  totalPages,
  total,
  sortBy,
  sortDir,
  onPageChange,
  onSortChange,
  loading,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onRowClick,
}: Props<T>) {
  const selectable = !!selectedIds && !!onToggleSelect;
  const allOnPageSelected = selectable && data.length > 0 && data.every((d) => selectedIds!.has(d.id));
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
  const colSpan = columns.length + (selectable ? 1 : 0);
  const pageNumbers = buildPageNumbers(page, totalPages);

  return (
    <div className="rounded-xl bg-white shadow-sm border border-gray-200/60 ring-1 ring-black/[0.04] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gradient-to-r from-navy to-navy2 text-white sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {selectable && (
                  <th className="px-4 py-3 w-8">
                    <Checkbox
                      checked={allOnPageSelected}
                      onCheckedChange={onToggleSelectAll}
                    />
                  </th>
                )}
                {hg.headers.map((header) => {
                  const sortKey = header.column.id;
                  const sortable = sortKey !== "actions";
                  const active = sortBy === sortKey;
                  return (
                    <th
                      key={header.id}
                      className={`px-4 py-3 select-none whitespace-nowrap text-left text-[11px] font-semibold tracking-wider uppercase ${
                        sortable ? "cursor-pointer hover:bg-white/10 transition-colors" : ""
                      } ${active ? "bg-white/15" : ""}`}
                      onClick={() => sortable && onSortChange(sortKey)}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sortable &&
                          (active ? (
                            sortDir === "asc" ? (
                              <ChevronUp className="h-3 w-3 text-white/80" />
                            ) : (
                              <ChevronDown className="h-3 w-3 text-white/80" />
                            )
                          ) : (
                            <ChevronsUpDown className="h-3 w-3 text-white/30" />
                          ))}
                      </span>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-l-2 border-l-transparent">
                  {selectable && <td className="px-4 py-3.5 w-8" />}
                  {columns.map((_, ci) => (
                    <td key={ci} className="px-4 py-3.5">
                      <div
                        className="h-3.5 rounded-full bg-gray-100 animate-pulse"
                        style={{
                          width: `${[60, 80, 45, 70, 55, 40, 65, 50][ci % 8]}%`,
                          animationDelay: `${i * 40}ms`,
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="px-4 py-0">
                  <div className="flex flex-col items-center gap-3 py-16 text-gray-400">
                    <div className="h-14 w-14 rounded-full bg-gray-100 flex items-center justify-center">
                      <Inbox className="h-7 w-7 text-gray-300" />
                    </div>
                    <p className="text-sm font-medium text-gray-400">Aucune donnée à afficher</p>
                    <p className="text-xs text-gray-300">Modifiez vos filtres ou ajoutez des éléments</p>
                  </div>
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={`group border-l-2 border-l-transparent hover:border-l-navy/40 hover:bg-blue-50/30 transition-all duration-150 ${
                    onRowClick ? "cursor-pointer" : ""
                  }`}
                  onClick={() => onRowClick?.(row.original)}
                >
                  {selectable && (
                    <td className="px-4 py-3 w-8" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds!.has(row.original.id)}
                        onCheckedChange={() => onToggleSelect!(row.original.id)}
                      />
                    </td>
                  )}
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-4 py-3 whitespace-nowrap"
                      onClick={cell.column.id === "actions" ? (e) => e.stopPropagation() : undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {/* Pagination */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50/50">
        <span className="text-xs text-gray-500 font-medium">
          {total.toLocaleString("fr-FR")} résultat{total !== 1 ? "s" : ""}
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
              className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            {pageNumbers.map((pn, idx) =>
              pn === "..." ? (
                <span key={`ellipsis-${idx}`} className="h-7 w-7 flex items-center justify-center text-xs text-gray-400">
                  ···
                </span>
              ) : (
                <button
                  key={pn}
                  onClick={() => onPageChange(pn as number)}
                  className={`h-7 min-w-[28px] px-2 flex items-center justify-center rounded-lg text-xs font-medium transition-colors ${
                    pn === page
                      ? "bg-navy text-white shadow-sm"
                      : "text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {pn}
                </button>
              )
            )}
            <button
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
              className="h-7 w-7 flex items-center justify-center rounded-lg text-gray-500 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
