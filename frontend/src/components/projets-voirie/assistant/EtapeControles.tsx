import { lazy, Suspense, useId, useMemo, useState } from "react";
import { Button } from "../../ui/Button";
import { formaterLongueur, formaterNombre } from "../../../lib/projetsVoirie";
import {
  LIBELLE_ELEMENT_ECARTE, LIBELLE_PROBLEME_GEOMETRIE, LIBELLE_REJET_CSV, texteAttribut, type Apercu,
} from "../../../lib/projetsVoirieImport";
import { BlocSystemeCoordonnees } from "./EtapeCrs";
import { Encart, ListeAvertissements, Tableau } from "./commun";

// Leaflet n'est charge qu'a l'ouverture de cette etape.
const ApercuCarte = lazy(() => import("./ApercuCarte").then((m) => ({ default: m.ApercuCarte })));

const TYPES = { LIGNE: "ligne(s)", POINT: "point(s)", POLYGONE: "polygone(s)" } as const;
const ATTRIBUTS_PAR_LIGNE = 3;

/**
 * Etape 5 : controles. Statistiques, validation geometrique, doublons internes, elements ecartes, lignes rejetees, avertissements, puis l'ECHANTILLON
 * borne (au plus 20 objets, choisis par le serveur : les objets a probleme d'abord) sur un TABLEAU et sur une CARTE. Le tableau est la voie clavier
 * et lecteur d'ecran ; la carte est une aide visuelle complementaire. Le fichier entier n'est jamais affiche.
 */
export function EtapeControles({ apercu }: { apercu: Apercu }) {
  const id = useId();
  const [selection, setSelection] = useState<number | null>(null);
  const st = apercu.statistiques;
  const v = apercu.validationGeometrique;
  const imp = apercu.resume.import;
  const problemes = useMemo(() => new Set(v.problemes.map((p) => p.ordre)), [v.problemes]);
  const probleme = (ordre: number) => v.problemes.find((p) => p.ordre === ordre);
  const types = Object.entries(st.parTypeGeom).filter(([, n]) => (n ?? 0) > 0);
  const ech = apercu.echantillon;

  return (
    <div className="space-y-4">
      <section aria-labelledby={`${id}-stats`} className="space-y-1">
        <h4 id={`${id}-stats`} className="text-sm font-semibold text-navy">Statistiques</h4>
        <dl data-testid="statistiques" className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded border border-gray-200 bg-white p-3 text-sm">
          <dt className="text-gray-700">Objets du fichier</dt>
          <dd>{formaterNombre(st.nbObjets, 0)}{types.length > 0 && <> ({types.map(([k, n]) => `${formaterNombre(n ?? 0, 0)} ${TYPES[k as keyof typeof TYPES] ?? k}`).join(", ")})</>}</dd>
          <dt className="text-gray-700">Longueur totale</dt><dd>{formaterLongueur(st.longueurTotaleM)} (somme des longueurs des lignes valides)</dd>
          <dt className="text-gray-700">Sommets</dt><dd>{formaterNombre(st.sommets, 0)}</dd>
          <dt className="text-gray-700">Doublons internes</dt>
          <dd data-testid="doublons">{st.doublonsInternes > 0 ? `${formaterNombre(st.doublonsInternes, 0)} tracé(s) identique(s) répété(s) dans le fichier` : "Aucun tracé répété"}</dd>
          <dt className="text-gray-700">Géométries à réparer</dt><dd>{formaterNombre(st.geometriesAReparer, 0)}</dd>
          <dt className="text-gray-700">Géométries vides</dt><dd>{formaterNombre(st.geometriesVides, 0)}</dd>
          {apercu.couche && (<><dt className="text-gray-700">Couche</dt><dd className="break-words">{apercu.couche.nom}</dd></>)}
        </dl>
        {st.doublonsInternes > 0 && <p className="text-xs text-gray-700">Des tracés identiques superposés peuvent être des circuits logiques et non des câbles distincts : les longueurs sont comptées une fois dans le tracé fusionné, à l&apos;enregistrement.</p>}
      </section>

      {apercu.resume.crs && <BlocSystemeCoordonnees crs={apercu.resume.crs} />}

      <section aria-labelledby={`${id}-geom`} className="space-y-2" data-testid="validation-geometrique">
        <h4 id={`${id}-geom`} className="text-sm font-semibold text-navy">Validation géométrique</h4>
        {v.nbProblemes === 0 && v.elementsEcartes.length === 0 && imp.rejets.length === 0
          ? <p className="text-sm text-green-900">Aucun problème de géométrie détecté.</p>
          : (
            <>
              {v.nbProblemes > 0 && (
                <>
                  <p className="text-sm text-gray-900">{formaterNombre(v.nbProblemes, 0)} géométrie(s) invalide(s) : la base les répare au dépôt{v.tronque ? ` (la liste ci-dessous est limitée à ${formaterNombre(v.problemes.length, 0)})` : ""}.</p>
                  <Tableau libelle="Géométries invalides">
                    <thead className="bg-gray-100 text-gray-800"><tr><th scope="col" className="p-1.5">Objet</th><th scope="col" className="p-1.5">Nom</th><th scope="col" className="p-1.5">Problème</th></tr></thead>
                    <tbody>
                      {v.problemes.map((p) => (
                        <tr key={p.ordre} className="border-t border-gray-200"><td className="p-1.5">n° {p.ordre + 1}</td><td className="break-all p-1.5">{p.nom ?? "sans nom"}</td><td className="p-1.5">{LIBELLE_PROBLEME_GEOMETRIE[p.code] ?? p.code}</td></tr>
                      ))}
                    </tbody>
                  </Tableau>
                </>
              )}
              {v.elementsEcartes.length > 0 && (
                <>
                  <p className="text-sm text-gray-900">Éléments écartés avant la base (jamais stockés) : {v.elementsEcartes.length >= 50 ? "50 premiers" : formaterNombre(v.elementsEcartes.length, 0)}.</p>
                  <Tableau libelle="Éléments écartés du fichier">
                    <thead className="bg-gray-100 text-gray-800"><tr><th scope="col" className="p-1.5">Élément</th><th scope="col" className="p-1.5">Nom</th><th scope="col" className="p-1.5">Raison</th></tr></thead>
                    <tbody>
                      {v.elementsEcartes.map((e, i) => (
                        <tr key={`${e.element}-${i}`} className="border-t border-gray-200"><td className="p-1.5">n° {e.element}</td><td className="break-all p-1.5">{e.nom ?? "sans nom"}</td><td className="p-1.5">{LIBELLE_ELEMENT_ECARTE[e.code] ?? e.message}</td></tr>
                      ))}
                    </tbody>
                  </Tableau>
                </>
              )}
              {imp.rejets.length > 0 && (
                <>
                  <p className="text-sm text-gray-900">Lignes du tableau rejetées : {formaterNombre(imp.csv?.nbLignesRejetees ?? imp.rejets.length, 0)}{imp.rejetsTronques ? ` (les ${imp.rejets.length} premières sont listées)` : ""}.</p>
                  <Tableau libelle="Lignes rejetées du tableau">
                    <thead className="bg-gray-100 text-gray-800"><tr><th scope="col" className="p-1.5">Ligne du fichier</th><th scope="col" className="p-1.5">Raison</th></tr></thead>
                    <tbody>
                      {imp.rejets.map((r, i) => <tr key={`${r.ligne}-${i}`} className="border-t border-gray-200"><td className="p-1.5">{r.ligne}</td><td className="p-1.5">{LIBELLE_REJET_CSV[r.code] ?? r.code}</td></tr>)}
                    </tbody>
                  </Tableau>
                </>
              )}
            </>
          )}
      </section>

      <ListeAvertissements liste={apercu.avertissements} />

      <section aria-labelledby={`${id}-ech`} className="space-y-2" data-testid="echantillon">
        <h4 id={`${id}-ech`} className="text-sm font-semibold text-navy">Échantillon : {formaterNombre(ech.objets.length, 0)} objet(s) sur {formaterNombre(ech.total, 0)}</h4>
        <p className="text-xs text-gray-700">
          Le serveur choisit l&apos;échantillon (les objets à problème d&apos;abord, puis des objets régulièrement espacés). Les valeurs longues sont tronquées. Une géométrie de plus de 500 sommets est simplifiée à l&apos;affichage. Le fichier entier n&apos;est jamais affiché.
        </p>
        {ech.objets.length === 0 ? <Encart ton="attention">Aucun objet à afficher.</Encart> : (
          <>
            <Tableau libelle="Échantillon d'objets du fichier">
              <thead className="bg-gray-100 text-gray-800">
                <tr><th scope="col" className="p-1.5">N°</th><th scope="col" className="p-1.5">Nom</th><th scope="col" className="p-1.5">Type</th><th scope="col" className="p-1.5">Contrôle</th><th scope="col" className="p-1.5">Attributs</th><th scope="col" className="p-1.5">Carte</th></tr>
              </thead>
              <tbody>
                {ech.objets.map((o) => {
                  const p = probleme(o.ordre);
                  const attrs = Object.entries(o.attributs);
                  const nom = o.nom ?? "Objet sans nom";
                  return (
                    <tr key={o.ordre} data-ordre={o.ordre} className="border-t border-gray-200 align-top">
                      <td className="p-1.5">{o.ordre + 1}</td>
                      <td className="break-all p-1.5">{nom}</td>
                      <td className="p-1.5">{o.typeGeom}{o.simplifiee ? " (simplifié)" : ""}</td>
                      <td className="p-1.5">{p ? <strong className="text-red-700">{LIBELLE_PROBLEME_GEOMETRIE[p.code] ?? p.code}</strong> : "Valide"}</td>
                      <td className="break-all p-1.5">
                        {attrs.slice(0, ATTRIBUTS_PAR_LIGNE).map(([k, val]) => <span key={k} className="block">{texteAttribut(k, 30)} : {texteAttribut(val)}</span>)}
                        {attrs.length > ATTRIBUTS_PAR_LIGNE && <span className="block text-gray-700">+ {attrs.length - ATTRIBUTS_PAR_LIGNE} autre(s)</span>}
                      </td>
                      <td className="p-1.5">
                        <Button type="button" size="sm" variant="outline" className="min-h-[44px] sm:min-h-8" aria-pressed={selection === o.ordre} aria-label={`Voir sur la carte : ${nom}, objet n° ${o.ordre + 1}`} onClick={() => setSelection(selection === o.ordre ? null : o.ordre)}>
                          {selection === o.ordre ? "Retirer" : "Voir"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Tableau>
            <div className="relative isolate z-0 h-72 overflow-hidden rounded border border-gray-300" data-testid="carte-echantillon">
              <Suspense fallback={<p role="status" className="p-3 text-sm text-gray-700">Chargement de la carte…</p>}>
                <ApercuCarte objets={ech.objets} selection={selection} problemes={problemes} onSelect={(o) => setSelection(o)} />
              </Suspense>
            </div>
            <p className="text-xs text-gray-700">Carte de l&apos;échantillon seulement. Traits rouges en tirets : objets dont la géométrie est à réparer. Le tableau donne les mêmes objets.</p>
          </>
        )}
      </section>
    </div>
  );
}
