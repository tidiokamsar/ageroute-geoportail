/**
 * Lecture d'une feuille Excel sous forme de grille positionnelle (tableau de
 * tableaux), pour les scripts d'import qui adressent leurs colonnes par indice.
 *
 * Remplace XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) du paquet
 * `xlsx`, retire du projet au profit d'exceljs pour cause de CVE — voir l'en-tete
 * de src/lib/excel.ts. Les conventions de sheet_to_json sont reproduites, sans
 * quoi l'indexation positionnelle des scripts se decalerait :
 *   - une entree par ligne du classeur, lignes vides comprises (la ligne 1 du
 *     classeur est a l'indice 0) ;
 *   - chaque ligne est completee jusqu'a la largeur de la feuille ;
 *   - cellule vide -> "" (l'equivalent de defval).
 *
 * LIMITE DE FORMAT : exceljs ne lit que .xlsx, la ou `xlsx` lisait aussi le
 * format binaire .xls (BIFF). Un classeur .xls doit etre converti au prealable ;
 * openWorkbook le refuse explicitement plutot que d'echouer sur une erreur zip.
 */
import ExcelJSDefault from "exceljs";
import { cellValue } from "../../src/lib/excel";

export interface Workbook {
  /**
   * Grille positionnelle de la feuille `name`. Leve si la feuille est absente,
   * en listant les feuilles reellement presentes.
   */
  sheet(name: string): unknown[][];
}

export async function openWorkbook(filePath: string): Promise<Workbook> {
  if (/\.xls$/i.test(filePath)) {
    throw new Error(
      `Format .xls non pris en charge (${filePath}). exceljs ne lit que .xlsx : ` +
        "convertir le classeur (Excel/LibreOffice, « Enregistrer sous » au format .xlsx) puis relancer.",
    );
  }

  const workbook = new ExcelJSDefault.Workbook();
  await workbook.xlsx.readFile(filePath);

  return {
    sheet(name: string): unknown[][] {
      const sheet = workbook.getWorksheet(name);
      if (!sheet) {
        const presentes = workbook.worksheets.map((w) => `"${w.name}"`).join(", ") || "aucune";
        throw new Error(`Feuille "${name}" absente du classeur. Feuilles presentes : ${presentes}.`);
      }
      const width = sheet.columnCount;
      const grid: unknown[][] = [];
      for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        const cells: unknown[] = [];
        for (let colNumber = 1; colNumber <= width; colNumber++) {
          cells.push(cellValue(row.getCell(colNumber)) ?? "");
        }
        grid.push(cells);
      }
      return grid;
    },
  };
}
