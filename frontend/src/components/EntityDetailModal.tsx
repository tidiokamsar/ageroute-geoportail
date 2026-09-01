import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

interface Action {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
}

interface Props<T extends { id: string }> {
  open: boolean;
  onClose: () => void;
  title: string;
  row: T;
  columns: ColumnDef<T, unknown>[];
  actions: Action[];
}

// Modal de detail en lecture, generique pour tous les modules : reutilise les memes
// `columns` (header + cell) que le tableau, donc memes badges/formats, sans dupliquer
// la logique d'affichage. Les actions (Modifier/Archiver/Historique/Fiche...) sont
// fournies par l'appelant et rendues comme boutons en bas de modal.
export function EntityDetailModal<T extends { id: string }>({ open, onClose, title, row, columns, actions }: Props<T>) {
  const table = useReactTable({ data: [row], columns, getCoreRowModel: getCoreRowModel() });
  const cells = table.getRowModel().rows[0]?.getVisibleCells() ?? [];

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-2">
        {cells.map((cell) => (
          <div key={cell.id} className="flex justify-between gap-3 py-1.5 border-b border-gray-50 text-sm">
            <span className="text-gray-500 shrink-0">{String(cell.column.columnDef.header ?? cell.column.id)}</span>
            <span className="text-navy font-medium text-right">
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </span>
          </div>
        ))}
      </div>

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-gray-100">
          {actions.map((a) => (
            <Button key={a.label} variant={a.variant ?? "ghost"} className="px-3 py-1.5 text-sm" onClick={a.onClick}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </Modal>
  );
}
