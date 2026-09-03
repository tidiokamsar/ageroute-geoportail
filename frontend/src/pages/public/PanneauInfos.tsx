import { ChevronDown } from "lucide-react";
import { ETAT_COLORS, ETAT_LABELS, CHANTIER_COLORS } from "../geoportail/types";
import { STATUT_LABELS } from "./types";
import type { EtatPatrimoine, StatutChantier } from "../../types";

export interface StatsReseau {
  totalKm: number;
  parEtat: { etat: EtatPatrimoine; km: number; pct: number }[];
  chantiersEnCours: number;
  pointsNoirs: number;
}

export type CoucheKey = "troncons" | "chantiers" | "pointsNoirs" | "ouvrages" | "pontsOsm" | "voirie" | "noms";

function Case({
  coche,
  onChange,
  children,
  gras,
}: {
  coche: boolean;
  onChange: () => void;
  children: React.ReactNode;
  gras?: boolean;
}) {
  return (
    <label
      className={
        "flex cursor-pointer items-center gap-2 py-1 " +
        (gras ? "font-semibold text-navy" : "text-slate-600")
      }
    >
      <input
        type="checkbox"
        checked={coche}
        onChange={onChange}
        className="h-3.5 w-3.5 shrink-0 accent-navy"
      />
      {children}
    </label>
  );
}

function TraitLegende({ couleur, tirets }: { couleur: string; tirets?: boolean }) {
  return (
    <span
      className="inline-block h-0 w-5 shrink-0"
      style={{
        borderTopWidth: 3,
        borderTopStyle: tirets ? "dashed" : "solid",
        borderTopColor: couleur,
      }}
    />
  );
}

/**
 * Panneau de lecture du reseau : etat d'ensemble, puis reglages d'affichage.
 *
 * Feuille ancree en bas sur telephone (repliee, elle ne coute qu'une ligne de
 * carte ; depliee, elle plafonne a 70% de la hauteur), panneau lateral au dela.
 * L'ordre est deliberé : le citoyen vient savoir dans quel etat est le reseau,
 * pas cocher des couches.
 */
export function PanneauInfos({
  stats,
  couches,
  onToggleCouche,
  etatsMasques,
  onToggleEtat,
  deplie,
  onToggleDeplie,
  zoomInsuffisantPourNoms,
  voirie,
}: {
  stats: StatsReseau;
  couches: Record<CoucheKey, boolean>;
  onToggleCouche: (k: CoucheKey) => void;
  etatsMasques: Set<EtatPatrimoine>;
  onToggleEtat: (e: EtatPatrimoine) => void;
  deplie: boolean;
  onToggleDeplie: () => void;
  zoomInsuffisantPourNoms: boolean;
  /** Voirie locale : le zoom courant permet-il de la charger, et combien en vue. */
  voirie: { zoomSuffisant: boolean; voies: number; chargement: boolean };
}) {
  return (
    <div className="pointer-events-none w-full sm:absolute sm:bottom-6 sm:left-3 sm:z-[1000] sm:w-72">
      {/* pb pour l'encoche basse des telephones recents, sinon l'indicateur d'accueil
          recouvre la derniere ligne de la feuille. */}
      <div className="pointer-events-auto rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl ring-1 ring-black/5 sm:rounded-lg sm:pb-0 sm:shadow-lg">
        {/* Barre de resume : toujours visible, c'est le seul contenu sur telephone
            tant que la feuille est repliee. */}
        <button
          type="button"
          onClick={onToggleDeplie}
          aria-expanded={deplie}
          className="flex w-full items-center gap-3 px-4 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-navy"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold tabular-nums text-navy">
              {stats.totalKm.toLocaleString("fr-FR")} km de routes
            </span>
            <span className="block truncate text-xs text-slate-500">
              {stats.chantiersEnCours} chantier{stats.chantiersEnCours > 1 ? "s" : ""} en cours ·{" "}
              {stats.pointsNoirs} point{stats.pointsNoirs > 1 ? "s" : ""} noir
              {stats.pointsNoirs > 1 ? "s" : ""}
            </span>
          </span>
          <ChevronDown
            className={"h-4 w-4 shrink-0 text-slate-400 transition-transform " + (deplie ? "" : "rotate-180")}
            aria-hidden
          />
        </button>

        {/* Barre d'etat du reseau : une seule ligne qui dit d'un coup d'oeil quelle
            part du lineaire est en bon ou en mauvais etat. */}
        <div className="px-4 pb-3">
          <div
            className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100"
            role="img"
            aria-label={
              "État du réseau : " +
              stats.parEtat.map((e) => `${ETAT_LABELS[e.etat]} ${e.pct} %`).join(", ")
            }
          >
            {stats.parEtat.map((e) => (
              <span
                key={e.etat}
                style={{ width: `${e.pct}%`, backgroundColor: ETAT_COLORS[e.etat] }}
                title={`${ETAT_LABELS[e.etat]} — ${e.pct} %`}
              />
            ))}
          </div>
        </div>

        {/* 42dvh et non 60vh : sur un ecran de 640 px la feuille depliee mangeait les
            trois quarts de la carte. dvh suit la barre d'adresse mobile. */}
        {deplie && (
          <div className="max-h-[42dvh] overflow-y-auto border-t border-slate-100 px-4 py-3 text-xs sm:max-h-[55vh]">
            <p className="mb-2 font-semibold text-navy">État de la chaussée</p>
            <p className="mb-2 text-[11px] leading-snug text-slate-500">
              Décochez un état pour le retirer de la carte.
            </p>
            <ul className="mb-4 space-y-0.5">
              {stats.parEtat.map((e) => (
                <li key={e.etat}>
                  <label className="flex cursor-pointer items-center gap-2 py-0.5">
                    <input
                      type="checkbox"
                      checked={!etatsMasques.has(e.etat)}
                      onChange={() => onToggleEtat(e.etat)}
                      className="h-3.5 w-3.5 shrink-0 accent-navy"
                    />
                    <TraitLegende couleur={ETAT_COLORS[e.etat]} />
                    <span className="min-w-0 flex-1 truncate text-slate-600">{ETAT_LABELS[e.etat]}</span>
                    <span className="shrink-0 tabular-nums text-slate-400">{e.pct} %</span>
                  </label>
                </li>
              ))}
            </ul>

            <p className="mb-1 font-semibold text-navy">Afficher sur la carte</p>
            <Case coche={couches.troncons} onChange={() => onToggleCouche("troncons")} gras>
              Routes
            </Case>
            <div className="pl-5">
              <Case coche={couches.noms} onChange={() => onToggleCouche("noms")}>
                Numéros des routes
              </Case>
              {couches.noms && zoomInsuffisantPourNoms && (
                <p className="pb-1 pl-5 text-[11px] italic leading-snug text-slate-400">
                  Zoomez pour les faire apparaître.
                </p>
              )}
            </div>

            <Case coche={couches.chantiers} onChange={() => onToggleCouche("chantiers")} gras>
              Chantiers
            </Case>
            {couches.chantiers && (
              <ul className="mb-1 space-y-0.5 pl-5">
                {(Object.keys(CHANTIER_COLORS) as StatutChantier[]).map((s) => (
                  <li key={s} className="flex items-center gap-2 text-slate-600">
                    <TraitLegende couleur={CHANTIER_COLORS[s]} tirets />
                    {STATUT_LABELS[s]}
                  </li>
                ))}
              </ul>
            )}

            <Case coche={couches.pointsNoirs} onChange={() => onToggleCouche("pointsNoirs")} gras>
              Points noirs
            </Case>

            {/* D9 (02/09/2026) : ouvrages et franchissements OSM en propositions —
                decision du proprietaire : tout est affiche, mention honnete incluse. */}
            <Case coche={couches.ouvrages} onChange={() => onToggleCouche("ouvrages")} gras>
              Ouvrages d'art
            </Case>
            {couches.ouvrages && (
              <p className="ml-7 text-[10px] leading-snug text-slate-400">
                Ponts, dalots, buses… — positions héritées, non vérifiées
              </p>
            )}
            {/* Voirie locale : les traces des rues et chemins, par opposition aux
                franchissements qui ne sont que des ouvrages ponctuels. */}
            <Case coche={couches.voirie} onChange={() => onToggleCouche("voirie")} gras>
              Rues et voirie locale
            </Case>
            {couches.voirie && (
              <p className="ml-7 text-[10px] leading-snug text-slate-400">
                {!voirie.zoomSuffisant
                  ? "Rapprochez la vue pour afficher les rues — 262 656 voies, chargées à l'échelle d'une ville."
                  : voirie.chargement
                    ? "Chargement…"
                    : `${voirie.voies.toLocaleString("fr-FR")} voie(s) dans la vue — source OpenStreetMap 2023, donnée non validée par AGEROUTE`}
              </p>
            )}

            <Case coche={couches.pontsOsm} onChange={() => onToggleCouche("pontsOsm")} gras>
              Franchissements OSM (propositions)
            </Case>
            {couches.pontsOsm && (
              <p className="ml-7 text-[10px] leading-snug text-slate-400">
                Ponts cartographiés par OpenStreetMap (2023) sans inventaire AGEROUTE — à valider sur le terrain
              </p>
            )}

            <p className="mt-3 border-t border-slate-100 pt-3 text-[11px] leading-snug text-slate-500">
              Touchez un élément de la carte pour l'afficher. Données publiées par
              AGEROUTE Guinée — connectez-vous pour les fiches complètes.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
