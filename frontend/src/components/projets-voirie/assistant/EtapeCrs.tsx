import { useId, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Input";
import type { BlocCrs } from "../../../lib/projetsVoirieApi";
import { formaterNombre } from "../../../lib/projetsVoirie";
import { LIBELLE_UNITE, type Apercu, type Inventaire, type Lecture, type ModeCrs, type OptionsImportApi } from "../../../lib/projetsVoirieImport";
import { Champ, Encart } from "./commun";

const unite = (u: string | null) => (u ? LIBELLE_UNITE[u] ?? u : "non indiquée");
const bboxTexte = (b: readonly number[]) => `ouest ${b[0].toFixed(4)}, sud ${b[1].toFixed(4)}, est ${b[2].toFixed(4)}, nord ${b[3].toFixed(4)}`;

/** Bloc d'information du systeme de coordonnees : source, cible, unites, methode, version de PROJ, origine, resultat. Partage avec l'etape des controles. */
export function BlocSystemeCoordonnees({ crs }: { crs: BlocCrs }) {
  const p = crs.plausibilite;
  return (
    <dl data-testid="bloc-crs" aria-label="Système de coordonnées" className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
      <dt className="text-gray-700">Système source</dt><dd>{crs.source ?? "Non indiqué"}</dd>
      <dt className="text-gray-700">Système cible</dt><dd>{crs.cible ?? "Non indiqué"}</dd>
      <dt className="text-gray-700">Unités</dt><dd>{unite(crs.uniteSource)} (source), {unite(crs.uniteCible)} (cible)</dd>
      <dt className="text-gray-700">Méthode</dt><dd>{crs.methode ?? "Non indiquée"}{crs.versionProj ? `, PROJ ${crs.versionProj}` : ""}</dd>
      <dt className="text-gray-700">Origine du choix</dt>
      <dd>{crs.origine === "choisi_par_utilisateur" ? "Choisi par vous (le fichier ne permet pas de le vérifier)" : crs.origine === "norme_du_format" ? "Imposé par la norme du format" : crs.origine === "declare_dans_le_fichier" ? "Déclaré par le fichier, confirmé par vous" : "Non indiquée"}</dd>
      <dt className="text-gray-700">Justification</dt><dd className="break-words">{crs.justification ?? "Non indiquée"}</dd>
      {p?.empriseResultat && (<><dt className="text-gray-700">Emprise du résultat</dt><dd className="break-words">{bboxTexte(p.empriseResultat)} (degrés WGS 84)</dd></>)}
      {p?.zoneAttendue && (<><dt className="text-gray-700">Zone attendue</dt><dd className="break-words">{p.zoneAttendue.nom} : {bboxTexte(p.zoneAttendue.bbox)}</dd></>)}
      {p && (
        <>
          <dt className="text-gray-700">Plausibilité</dt>
          <dd data-testid="plausibilite" data-statut={p.statut ?? undefined}>
            {p.statut === "CONFORME" && `Conforme : les ${formaterNombre(p.nbObjets, 0)} objet(s) tombent dans la zone attendue.`}
            {p.statut === "PARTIELLEMENT_HORS_ZONE" && `${formaterNombre(p.nbElementsHorsZone, 0)} élément(s) hors de la zone attendue${p.confirmee ? ", écartés sur votre confirmation explicite (jamais stockés)." : "."}`}
            {p.statut === null && "Non indiquée."}
          </dd>
        </>
      )}
    </dl>
  );
}

/**
 * Etape 3 : systeme de coordonnees et unites. Liste blanche venue de l'API ; JAMAIS de valeur par defaut silencieuse (CSV, ou GeoJSON qui declare un
 * systeme projete : choix obligatoire, champ vide au depart). Le calcul reel (PostGIS, PROJ) se lit dans l'apercu : « Verifier la transformation ».
 * Des elements hors de la zone attendue bloquent l'avancement tant que l'utilisateur ne les a pas explicitement acceptes (ecartes, jamais stockes).
 */
export function EtapeCrs({ inventaire, mode, lecture, options, apercu, horsZone, erreurChoix, choixComplet, occupe, onLecture, onVerifier, onConfirmer }: {
  inventaire: Inventaire; mode: ModeCrs; lecture: Lecture; options: OptionsImportApi; apercu: Apercu | null;
  horsZone: { nbElements: number; nbObjets: number | null } | null; erreurChoix: string | null; choixComplet: boolean; occupe: boolean;
  onLecture: (patch: Partial<Lecture>) => void; onVerifier: () => void; onConfirmer: () => void;
}) {
  const id = useId();
  const [accepte, setAccepte] = useState(false);
  const cible = options.crs.cible;
  const sources = options.crs.sources;
  const proposees = mode.mode === "obligatoire" && mode.restreintA !== null ? sources.filter((s) => s.epsg === mode.restreintA) : sources;

  return (
    <div className="space-y-4">
      {mode.mode === "impose" && (
        <Encart testid="crs-impose" titre={`Système imposé par la norme du format : EPSG:${mode.epsg} (WGS 84, degrés)`}>
          <p>Un fichier {inventaire.format} est en WGS 84 par définition : aucun choix n&apos;est possible et aucune transformation n&apos;est appliquée. Les coordonnées sont tout de même contrôlées contre la zone attendue.</p>
        </Encart>
      )}
      {mode.mode === "facultatif" && (
        <Encart testid="crs-facultatif">
          <p>Un GeoJSON est en WGS 84 par la norme (RFC 7946). Ne choisissez un autre système que si le fichier, sorti d&apos;un outil de dessin, contient des coordonnées projetées en mètres : le choix est alors le vôtre et le fichier ne permet pas de le vérifier.</p>
        </Encart>
      )}
      {mode.mode === "obligatoire" && (
        <Encart ton="attention" testid="crs-obligatoire" titre="Choix obligatoire">
          <p>
            {mode.restreintA !== null
              ? `Ce fichier déclare lui-même EPSG:${mode.restreintA} : confirmez-le en le choisissant. Un système déclaré ne se remplace pas, et il n'est jamais appliqué sans votre confirmation.`
              : "Le système de coordonnées n'est pas déclaré par ce format : il n'est jamais deviné ni rempli par défaut. Dites-le avec ce que vous savez du fichier (un plan UTM zone 29N se choisit en UTM 29N ; des degrés se choisissent en WGS 84)."}
          </p>
        </Encart>
      )}

      {mode.mode !== "impose" && (
        <Champ id={`${id}-epsg`} libelle="Système de coordonnées source" erreur={erreurChoix ?? undefined} aide="Liste validée par le DSI. Le nom et l'unité viennent de la base de données.">
          <Select id={`${id}-epsg`} value={lecture.epsgSource} onChange={(e) => { setAccepte(false); onLecture({ epsgSource: e.target.value }); }} disabled={occupe} aria-invalid={erreurChoix ? true : undefined} aria-describedby={erreurChoix ? `${id}-epsg-erreur` : `${id}-epsg-aide`} className="mt-1 border-gray-300">
            <option value="">{mode.mode === "facultatif" ? "WGS 84 par la norme du format (aucune transformation)" : "Choisir un système"}</option>
            {proposees.map((s) => (
              <option key={s.epsg} value={String(s.epsg)} disabled={!s.disponible}>
                EPSG:{s.epsg}{s.nom ? ` : ${s.nom}` : ""}{s.unite ? `, unité : ${unite(s.unite)}` : ""}{s.disponible ? "" : " (indisponible dans la base)"}
              </option>
            ))}
          </Select>
        </Champ>
      )}
      {cible && <p className="text-xs text-gray-700" data-testid="crs-cible">Système cible du stockage : EPSG:{cible.epsg} ({cible.nom}, {unite(cible.unite)}), toujours.</p>}

      {horsZone && (
        <div role="alert" data-testid="alerte-hors-zone" className="space-y-2 rounded border-2 border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <p className="flex items-start gap-2 font-semibold"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />Résultat hors de la zone attendue : avancement bloqué</p>
          <p>
            Avec ce système, {formaterNombre(horsZone.nbElements, 0)} élément(s){horsZone.nbObjets !== null ? ` sur ${formaterNombre(horsZone.nbObjets, 0)}` : ""} tombent hors de la Guinée.
            Vérifiez d&apos;abord le système choisi : une mauvaise zone UTM ou une inversion de colonnes produit ce symptôme.
            Si vous êtes sûr du système, vous pouvez confirmer : les éléments hors zone seront écartés et jamais stockés ; les autres seront importés.
          </p>
          <label className="flex min-h-[44px] cursor-pointer items-start gap-2 sm:min-h-0">
            <input type="checkbox" checked={accepte} onChange={(e) => setAccepte(e.target.checked)} disabled={occupe} className="mt-1 h-4 w-4" />
            <span>Je confirme que ces {formaterNombre(horsZone.nbElements, 0)} élément(s) hors zone seront écartés.</span>
          </label>
          <Button type="button" size="sm" disabled={!accepte || occupe} onClick={() => { setAccepte(false); onConfirmer(); }}>Confirmer et recalculer l&apos;aperçu</Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={occupe || !choixComplet} onClick={onVerifier}>
          {apercu ? "Recalculer la transformation" : "Vérifier la transformation"}
        </Button>
        {!choixComplet && <p className="text-xs text-gray-700">Le choix du système est nécessaire avant la vérification.</p>}
      </div>

      {apercu?.resume.crs && <BlocSystemeCoordonnees crs={apercu.resume.crs} />}
      {apercu && !apercu.resume.crs && <Encart ton="attention">Le serveur n&apos;a pas indiqué le détail du système de coordonnées : ne continuez pas sans ce contrôle.</Encart>}
    </div>
  );
}
