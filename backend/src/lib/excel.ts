import ExcelJS from "exceljs";
import { ZodError } from "zod";

export interface ColumnDef {
  key: string;
  header: string;
}

// exceljs remplace le paquet npm xlsx@0.18.5, qui comporte des CVE connues
// (CVE-2023-30533 pollution de prototype, CVE-2024-22363 ReDoS) sans correctif
// publie sur le registre npm. L'interface ci-dessous est conservee a l'identique :
// memes cles (en-tetes de la ligne 1), cellules vides a null, premiere feuille.
export async function buildExportBuffer(rows: Record<string, unknown>[], columns: ColumnDef[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Export");
  sheet.addRow(columns.map((c) => c.header));
  for (const row of rows) {
    sheet.addRow(columns.map((c) => row[c.key] ?? ""));
  }
  const output = await workbook.xlsx.writeBuffer();
  return Buffer.from(output);
}

// Exporte : les scripts d'exploitation (scripts/lib/excel-grid.ts) lisent les
// memes classeurs et doivent deballer les cellules selon la meme regle.
export function cellValue(cell: ExcelJS.Cell): unknown {
  const value = cell.value;
  if (value === null || value === undefined) return null;
  if (value instanceof Object) {
    // Resultat de formule, texte riche ou lien hypertexte : retenons la valeur
    // affichee plutot que l'objet exceljs brut.
    const richOrLink = value as { result?: unknown; text?: string; richText?: unknown[] };
    if (richOrLink.result !== undefined) return richOrLink.result;
    if (richOrLink.richText !== undefined || richOrLink.text !== undefined) return cell.text;
  }
  return value;
}

export async function parseImportBuffer(buffer: Buffer): Promise<Record<string, unknown>[]> {
  const workbook = new ExcelJS.Workbook();
  // exceljs declare son propre type Buffer (global, base sur ArrayBuffer),
  // incompatible avec le Buffer de @types/node : cast vers le type du parametre.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headers = new Map<number, string>();
  sheet.getRow(1).eachCell((cell, colNumber) => {
    const header = cell.text.trim();
    if (header) headers.set(colNumber, header);
  });

  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: Record<string, unknown> = {};
    let hasValue = false;
    for (const [colNumber, header] of headers) {
      const value = cellValue(row.getCell(colNumber));
      if (value !== null && value !== "") hasValue = true;
      obj[header] = value;
    }
    if (hasValue) rows.push(obj);
  });
  return rows;
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
