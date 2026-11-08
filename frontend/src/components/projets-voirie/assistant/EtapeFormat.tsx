import { useId } from "react";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Input";
import { formaterNombre, formaterTaille } from "../../../lib/projetsVoirie";
import {
  LIBELLE_DELIMITEUR, LIBELLE_FORMAT, TOUTES_LES_COUCHES,
  type Inventaire, type Lecture, type LectureCsv, type ModeCsv, type OptionsImportApi,
} from "../../../lib/projetsVoirieImport";
import { Champ, Encart, ListeAvertissements, Tableau } from "./commun";

const TYPES_GEOM = { LIGNE: "ligne(s)", POINT: "point(s)", POLYGONE: "polygone(s)" } as const;
const LIBELLE_ENCODAGE: Record<string, string> = { "utf-8": "UTF-8", "iso-8859-1": "ISO-8859-1 (latin 1)", "windows-1252": "Windows-1252" };
const LIBELLE_MODE: Record<ModeCsv, string> = {
  points: "Points : une colonne X et une colonne Y, un objet par ligne du tableau",
  lignes: "Lignes : des points regroupés par une clé (un objet ligne par valeur de clé)",
  wkt: "Géométrie WKT : une colonne contient la géométrie complète",
};

/**
 * Etape 2 : format detecte PAR LE CONTENU, entrees d'archive, inventaire des couches (choix explicite), et, pour un tableau, options de lecture
 * (delimiteur, encodage, separateur decimal, colonnes de coordonnees). Rien n'est devine : un encodage ou un delimiteur ambigu se declare ici.
 * Sans inventaire (erreur de lecture du tableau), seules les options de lecture sont proposees, puis « Relancer la detection ».
 */
export function EtapeFormat({ inventaire: inv, lecture, options, tableauForce, perime, occupe, onLecture, onCsv, onRelancer }: {
  inventaire: Inventaire | null; lecture: Lecture; options: OptionsImportApi; tableauForce: boolean; perime: boolean; occupe: boolean;
  onLecture: (patch: Partial<Lecture>) => void; onCsv: (patch: Partial<LectureCsv>) => void; onRelancer: () => void;
}) {
  const id = useId();
  const csv = inv?.csv ?? null;
  const tableau = inv?.format === "CSV" || (inv === null && tableauForce);
  const k = lecture.csv;
  const colonnes = csv?.colonnes.map((c) => c.nom) ?? [];
  const coucheAvecObjets = inv?.couches.filter((c) => c.nbObjets > 0) ?? [];

  const optionColonnes = (
    <>
      <option value="">Choisir une colonne</option>
      {colonnes.map((c) => <option key={c} value={c}>{c}</option>)}
    </>
  );

  return (
    <div className="space-y-4">
      {inv && (
        <div className="rounded border border-gray-200 bg-white p-3 text-sm" data-testid="detection">
          <p>
            Format détecté par le contenu : <strong>{LIBELLE_FORMAT[inv.format] ?? inv.format}</strong>
            {inv.detection.extensionDeclaree && <> (extension déclarée : .{inv.detection.extensionDeclaree})</>}.
          </p>
          {!inv.detection.extensionCoherente && (
            <p className="mt-1 text-amber-900" role="status">L&apos;extension annonce un autre format que le contenu : le contenu fait foi.</p>
          )}
          <p className="text-xs text-gray-700">Fichier : {formaterTaille(inv.fichier.tailleOctets)}, empreinte SHA-256 {inv.fichier.sha256.slice(0, 12)}… (contrôlée à chaque envoi).</p>
        </div>
      )}

      {inv?.archive && (
        <section aria-labelledby={`${id}-archive`} className="space-y-2">
          <h4 id={`${id}-archive`} className="text-sm font-semibold text-navy">Contenu de l&apos;archive</h4>
          <p className="text-xs text-gray-700">
            {formaterNombre(inv.archive.nbEntrees, 0)} entrée(s), {formaterTaille(inv.archive.tailleDecompresseeOctets)} une fois décompressées. L&apos;archive n&apos;est jamais extraite : seule l&apos;entrée KML choisie est lue.
          </p>
          <Tableau libelle="Entrées de l'archive">
            <thead className="bg-gray-100 text-gray-800"><tr><th scope="col" className="p-1.5">Nom</th><th scope="col" className="p-1.5">Type</th><th scope="col" className="p-1.5">Taille</th></tr></thead>
            <tbody>
              {inv.archive.entrees.map((e) => (
                <tr key={e.nom} className="border-t border-gray-200">
                  <td className="break-all p-1.5">{e.nom}</td><td className="p-1.5">{e.type}</td><td className="p-1.5">{formaterTaille(e.tailleOctets)}</td>
                </tr>
              ))}
            </tbody>
          </Tableau>
          {inv.archive.entreesKml.length > 1 && (
            <Champ id={`${id}-entree`} libelle="Entrée KML à lire" aide={inv.archive.choixRequis ? "Plusieurs fichiers KML sans « doc.kml » à la racine : choisissez l'entrée, puis relancez la détection." : "Par défaut : « doc.kml » à la racine. Changer d'entrée relance la détection."}>
              <Select id={`${id}-entree`} value={lecture.entreeKml} onChange={(e) => onLecture({ entreeKml: e.target.value })} disabled={occupe} className="mt-1 border-gray-300">
                <option value="">{inv.archive.choixRequis ? "Choisir une entrée" : `Entrée principale (${inv.archive.kmlPrincipal ?? "doc.kml"})`}</option>
                {inv.archive.entreesKml.map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </Champ>
          )}
        </section>
      )}

      {inv && inv.format !== "CSV" && inv.couches.length > 0 && (
        <fieldset className="space-y-2 rounded-md border border-gray-200 p-3">
          <legend className="px-1 text-sm font-semibold text-navy">Couches du fichier</legend>
          <p className="text-xs text-gray-700">Les comptes sont ceux du fichier, avant tout contrôle de coordonnées.</p>
          <ul className="space-y-1">
            {inv.couches.map((c) => (
              <li key={c.id}>
                <label className="flex min-h-[44px] cursor-pointer items-start gap-2 text-sm text-gray-900 sm:min-h-0">
                  <input type="radio" name={`${id}-couche`} value={c.id} checked={lecture.couche === c.id} onChange={() => onLecture({ couche: c.id })} disabled={occupe} className="mt-1 h-4 w-4" />
                  <span>{c.nom}<span className="block text-xs text-gray-700">{formaterNombre(c.nbObjets, 0)} objet(s){Object.entries(c.parTypeGeom).filter(([, n]) => (n ?? 0) > 0).map(([t, n]) => `, ${formaterNombre(n ?? 0, 0)} ${TYPES_GEOM[t as keyof typeof TYPES_GEOM] ?? t}`).join("")}</span></span>
                </label>
              </li>
            ))}
            {coucheAvecObjets.length > 1 && (
              <li>
                <label className="flex min-h-[44px] cursor-pointer items-start gap-2 text-sm text-gray-900 sm:min-h-0">
                  <input type="radio" name={`${id}-couche`} value={TOUTES_LES_COUCHES} checked={lecture.couche === TOUTES_LES_COUCHES} onChange={() => onLecture({ couche: TOUTES_LES_COUCHES })} disabled={occupe} className="mt-1 h-4 w-4" />
                  <span>Toutes les couches<span className="block text-xs text-gray-700">Un seul jeu réunira les objets de toutes les couches. À choisir en connaissance de cause.</span></span>
                </label>
              </li>
            )}
          </ul>
        </fieldset>
      )}
      {inv && inv.format !== "CSV" && inv.couches.length === 0 && !inv.archive?.choixRequis && (
        <Encart ton="attention">Ce fichier ne contient aucune couche lisible.</Encart>
      )}

      {tableau && (
        <fieldset className="space-y-3 rounded-md border border-gray-200 p-3" data-testid="lecture-tableau">
          <legend className="px-1 text-sm font-semibold text-navy">Lecture du tableau</legend>
          {csv && (
            <p className="text-xs text-gray-700" data-testid="csv-detecte">
              Détecté : délimiteur {LIBELLE_DELIMITEUR[csv.delimiteur] ?? csv.delimiteur}{csv.delimiteurDetecte ? "" : " (déclaré)"}, encodage {LIBELLE_ENCODAGE[csv.encodage] ?? csv.encodage}{csv.encodageDetecte ? "" : " (déclaré)"}
              {csv.separateurDecimal ? `, séparateur décimal « ${csv.separateurDecimal} »` : ", séparateur décimal non déterminé"}, {formaterNombre(csv.nbLignes, 0)} ligne(s) de données.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Champ id={`${id}-delim`} libelle="Délimiteur" aide="Vide : détecté par le serveur ; ambigu : à déclarer.">
              <Select id={`${id}-delim`} value={k.delimiteur} onChange={(e) => onCsv({ delimiteur: e.target.value })} disabled={occupe} className="mt-1 border-gray-300">
                <option value="">Détection automatique</option>
                {options.csv.delimiteurs.map((d) => <option key={d} value={d}>{LIBELLE_DELIMITEUR[d] ?? d}</option>)}
              </Select>
            </Champ>
            <Champ id={`${id}-enc`} libelle="Encodage" aide="Vide : UTF-8 ou UTF-16 avec marque d'ordre ; sinon à déclarer.">
              <Select id={`${id}-enc`} value={k.encodage} onChange={(e) => onCsv({ encodage: e.target.value })} disabled={occupe} className="mt-1 border-gray-300">
                <option value="">Détection automatique</option>
                {options.csv.encodages.map((d) => <option key={d} value={d}>{LIBELLE_ENCODAGE[d] ?? d}</option>)}
              </Select>
            </Champ>
            <Champ id={`${id}-dec`} libelle="Séparateur décimal" aide="Vide : lu sur les colonnes de coordonnées, sans ambiguïté.">
              <Select id={`${id}-dec`} value={k.separateurDecimal} onChange={(e) => onCsv({ separateurDecimal: e.target.value })} disabled={occupe} className="mt-1 border-gray-300">
                <option value="">Détection automatique</option>
                {options.csv.separateursDecimaux.map((d) => <option key={d} value={d}>{d === "." ? "Point" : "Virgule"}</option>)}
              </Select>
            </Champ>
          </div>

          {inv?.csv && (
            <>
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium text-gray-900">Comment lire les coordonnées</legend>
                {(options.csv.modes.length > 0 ? options.csv.modes : ["points", "lignes", "wkt"]).filter((m): m is ModeCsv => m === "points" || m === "lignes" || m === "wkt").map((m) => (
                  <label key={m} className="flex min-h-[44px] cursor-pointer items-start gap-2 text-sm text-gray-900 sm:min-h-0">
                    <input type="radio" name={`${id}-mode`} value={m} checked={k.mode === m} onChange={() => onCsv({ mode: m })} disabled={occupe} className="mt-1 h-4 w-4" />
                    <span>{LIBELLE_MODE[m]}</span>
                  </label>
                ))}
              </fieldset>
              {k.mode === "wkt" && (
                <Champ id={`${id}-wkt`} libelle="Colonne de la géométrie WKT">
                  <Select id={`${id}-wkt`} value={k.colonneWkt} onChange={(e) => onCsv({ colonneWkt: e.target.value })} disabled={occupe} className="mt-1 border-gray-300">{optionColonnes}</Select>
                </Champ>
              )}
              {(k.mode === "points" || k.mode === "lignes") && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Champ id={`${id}-x`} libelle="Colonne X" aide="Pour des degrés : la longitude est le X, la latitude le Y.">
                    <Select id={`${id}-x`} value={k.colonneX} onChange={(e) => onCsv({ colonneX: e.target.value })} disabled={occupe} className="mt-1 border-gray-300">{optionColonnes}</Select>
                  </Champ>
                  <Champ id={`${id}-y`} libelle="Colonne Y">
                    <Select id={`${id}-y`} value={k.colonneY} onChange={(e) => onCsv({ colonneY: e.target.value })} disabled={occupe} className="mt-1 border-gray-300">{optionColonnes}</Select>
                  </Champ>
                  {k.mode === "lignes" && (
                    <>
                      <Champ id={`${id}-cle`} libelle="Colonne clé (une ligne par valeur)">
                        <Select id={`${id}-cle`} value={k.colonneCle} onChange={(e) => onCsv({ colonneCle: e.target.value })} disabled={occupe} className="mt-1 border-gray-300">{optionColonnes}</Select>
                      </Champ>
                      <Champ id={`${id}-ordre`} libelle="Colonne d'ordre (facultatif)" aide="Numérique. Sans elle, l'ordre du fichier est conservé.">
                        <Select id={`${id}-ordre`} value={k.colonneOrdre} onChange={(e) => onCsv({ colonneOrdre: e.target.value })} disabled={occupe} className="mt-1 border-gray-300">
                          <option value="">Ordre du fichier</option>
                          {colonnes.map((c) => <option key={c} value={c}>{c}</option>)}
                        </Select>
                      </Champ>
                    </>
                  )}
                </div>
              )}
              <div className="space-y-1">
                <h5 className="text-sm font-semibold text-gray-900">Colonnes et exemples</h5>
                <Tableau libelle="Colonnes du tableau et exemples de valeurs">
                  <thead className="bg-gray-100 text-gray-800"><tr><th scope="col" className="p-1.5">Colonne</th><th scope="col" className="p-1.5">Exemples (3 au plus)</th></tr></thead>
                  <tbody>
                    {inv.csv.colonnes.map((c) => (
                      <tr key={c.nom} className="border-t border-gray-200"><td className="break-all p-1.5 font-medium">{c.nom}</td><td className="break-all p-1.5">{c.exemples.join(" ; ") || "aucune valeur"}</td></tr>
                    ))}
                  </tbody>
                </Tableau>
              </div>
            </>
          )}
          <Button type="button" size="sm" variant="outline" className="min-h-[44px] sm:min-h-8" disabled={occupe} onClick={onRelancer}>Relancer la détection avec ces options</Button>
        </fieldset>
      )}

      {inv && !tableau && inv.archive && inv.archive.entreesKml.length > 1 && (
        <Button type="button" size="sm" variant="outline" className="min-h-[44px] sm:min-h-8" disabled={occupe || (inv.archive.choixRequis && !lecture.entreeKml)} onClick={onRelancer}>Relancer la détection avec cette entrée</Button>
      )}

      {perime && inv && (
        <Encart ton="attention" testid="inventaire-perime">Les options de lecture ont changé : relancez la détection avant de continuer.</Encart>
      )}
      {inv && <ListeAvertissements liste={inv.avertissements} titre="Avertissements de la détection" />}
    </div>
  );
}
