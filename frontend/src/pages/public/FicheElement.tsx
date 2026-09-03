import { useEffect, useRef } from "react";
import { X, Route, HardHat, AlertTriangle, Landmark } from "lucide-react";
import { ETAT_COLORS, ETAT_LABELS, CHANTIER_COLORS } from "../geoportail/types";
import { Ecusson } from "./Ecusson";
import { CLASSE_LABELS, STATUT_LABELS, type SelectedFeature } from "./types";
import { TYPE_OUVRAGE_LABEL } from "../geoportail/symbols";

/**
 * Longueur lisible.
 *
 * Le tronçon affichait la valeur brute : les 1 690 tronçons importes portaient des
 * nombres ronds, le defaut ne se voyait pas. Les longueurs calculees sur la
 * geometrie l'ont revele — « 1.2219212507954644 km ». Sous le kilometre, le metre
 * est l'unite juste : une desserte de 145 m ne se lit pas « 0,14 km ».
 */
function longueur(km: number): string {
  if (!Number.isFinite(km)) return "—";
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2).replace(".", ",")} km`;
}

function Ligne({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-100 py-2.5 last:border-b-0">
      <dt className="shrink-0 text-xs text-slate-500">{label}</dt>
      <dd className="text-right text-sm font-medium text-navy">{children}</dd>
    </div>
  );
}

function Pastille({ couleur }: { couleur: string }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: couleur }} />;
}

function Jauge({ pct }: { pct: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200">
        <span
          className="block h-full rounded-full bg-navy"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </span>
      <span className="tabular-nums">{pct} %</span>
    </span>
  );
}

/**
 * Fiche de consultation ouverte au clic sur un element de la carte. Strictement en
 * lecture : elle n'affiche que les champs renvoyes par /api/public/carte/geo, qui
 * sont volontairement reduits. Tout le reste (entreprise, bailleur, montant,
 * contrat, PK, trafic, inspections) reste derriere l'authentification.
 *
 * Feuille ancree en bas sur telephone, boite centree au-dela : sur un ecran tenu a
 * une main, le bas est la seule zone atteignable sans changer de prise.
 */
export function FicheElement({ feature, onClose }: { feature: SelectedFeature; onClose: () => void }) {
  const fermerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    fermerRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const entete = {
    troncon: { icone: <Route className="h-4 w-4" />, titre: "Route" },
    chantier: { icone: <HardHat className="h-4 w-4" />, titre: "Chantier" },
    pointNoir: { icone: <AlertTriangle className="h-4 w-4" />, titre: "Point noir" },
    ouvrage: { icone: <Landmark className="h-4 w-4" />, titre: "Ouvrage d'art" },
  }[feature.kind];

  return (
    <div
      className="absolute inset-0 z-[1200] flex items-end justify-center bg-navy/30 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={entete.titre}
        className="w-full max-w-sm overflow-hidden rounded-t-2xl bg-white shadow-2xl ring-1 ring-black/5 sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 bg-navy px-4 py-3 text-white">
          {entete.icone}
          <h2 className="flex-1 text-sm font-bold">{entete.titre}</h2>
          <button
            ref={fermerRef}
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="rounded p-1 transition hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <dl className="px-4 py-1">
          {feature.kind === "troncon" && (
            <>
              <Ligne label="Route">
                <Ecusson nom={feature.data.nom} />
              </Ligne>
              <Ligne label="Type">{CLASSE_LABELS[feature.data.classe] ?? feature.data.classe}</Ligne>
              <Ligne label="État de la chaussée">
                <span className="inline-flex items-center gap-2">
                  <Pastille couleur={ETAT_COLORS[feature.data.etat] ?? "#9ca3af"} />
                  {ETAT_LABELS[feature.data.etat] ?? feature.data.etat}
                  {feature.data.etatDeclare && (
                    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                      déclaré
                    </span>
                  )}
                </span>
              </Ligne>
              <Ligne label="Longueur">
                <span className="tabular-nums">{longueur(feature.data.longueurKm)}</span>
              </Ligne>
              <Ligne label="Région">{feature.data.region ?? "Non renseignée"}</Ligne>
              {/* La reference interne ne vaut d'etre montree que si elle dit autre
                  chose que le numero de route deja affiche en haut. */}
              {feature.data.code !== feature.data.nom && (
                <Ligne label="Référence">
                  <span className="tabular-nums text-xs text-slate-500">{feature.data.code}</span>
                </Ligne>
              )}
              {feature.data.etatDeclare && (
                <p className="border-t border-slate-100 py-2 text-[11px] leading-snug text-amber-700">
                  Cet état est déclaré par le gestionnaire et n'a pas fait l'objet d'un
                  relevé de terrain.
                </p>
              )}
            </>
          )}

          {feature.kind === "chantier" && (
            <>
              <Ligne label="Statut">
                <span className="inline-flex items-center gap-2">
                  <Pastille couleur={CHANTIER_COLORS[feature.data.statut]} />
                  {STATUT_LABELS[feature.data.statut] ?? feature.data.statut}
                </span>
              </Ligne>
              <Ligne label="Avancement">
                <Jauge pct={feature.data.avancementPct} />
              </Ligne>
              <Ligne label="Région">{feature.data.region ?? "Non renseignée"}</Ligne>
              {feature.data.approximate && (
                <Ligne label="Localisation">
                  <span className="text-xs italic text-slate-500">
                    Approximative — positionnée au centre de la région
                  </span>
                </Ligne>
              )}
            </>
          )}

          {feature.kind === "ouvrage" && (
            <>
              <Ligne label="Nom">{feature.data.nom}</Ligne>
              <Ligne label="Type">{TYPE_OUVRAGE_LABEL[feature.data.type] ?? feature.data.type}</Ligne>
              <Ligne label="État">
                <span className="inline-flex items-center gap-2">
                  <Pastille couleur={ETAT_COLORS[feature.data.etat as keyof typeof ETAT_COLORS] ?? "#9ca3af"} />
                  {ETAT_LABELS[feature.data.etat as keyof typeof ETAT_LABELS] ?? feature.data.etat}
                </span>
              </Ligne>
              <Ligne label="Position">
                <span className="text-xs italic text-slate-500">héritée, non vérifiée</span>
              </Ligne>
            </>
          )}

          {feature.kind === "pointNoir" && (
            <>
              <Ligne label="Gravité">{feature.data.gravite}</Ligne>
              <Ligne label="Région">{feature.data.region ?? "Non renseignée"}</Ligne>
              <Ligne label="Coordonnées">
                <span className="tabular-nums text-xs">
                  {feature.data.lat.toFixed(5)}, {feature.data.lon.toFixed(5)}
                </span>
              </Ligne>
            </>
          )}
        </dl>

        <p className="border-t border-slate-100 bg-slate-50 px-4 py-3 text-xs leading-snug text-slate-500">
          Ces informations sont publiques. La fiche complète et l'historique des
          interventions demandent un compte AGEROUTE.
        </p>
      </div>
    </div>
  );
}
