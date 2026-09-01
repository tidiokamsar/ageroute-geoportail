import * as XLSX from "xlsx";
import { ZodError } from "zod";

export interface ColumnDef {
  key: string;
  header: string;
}

export function buildExportBuffer(rows: Record<string, unknown>[], columns: ColumnDef[]): Buffer {
  const sheetRows = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const col of columns) out[col.header] = row[col.key] ?? "";
    return out;
  });
  const sheet = XLSX.utils.json_to_sheet(sheetRows, { header: columns.map((c) => c.header) });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Export");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function parseImportBuffer(buffer: Buffer): Record<string, unknown>[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });
}

export interface ImportRowError {
  row: number;
  message: string;
}

export interface ImportReport {
  created: number;
  errors: ImportRowError[];
}

export function formatImportError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.errors.map((e) => `${e.path.join(".")} : ${e.message}`).join(" ; ");
  }
  if (err instanceof Error) return err.message;
  return "Erreur inconnue";
}
