import { useId } from "react";
import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import type { BudgetSynthese, DegradationSynthese, MontantEtat, QualiteSynthese, RepartitionEtat, Section } from "../../lib/aideDecisionApi";
import type { FiltresDecision } from "./types";
import { Card } from "../ui/Card";
import { EtatInattendu, EtatPermission, EtatVide } from "./EtatsDecision";
import {
  ABSENT, arcsAnneau, formaterEntier, formaterGnf, formaterKm, formaterPct, LIBELLE_ETAT_MONTANT, nomRegion, partDuTotalContractuel,
  repartitionVide, segmentsRepartition, texteCouverture, trierBailleurs, trierRegions, type SegmentRepartition,
} from "../../lib/decision";
import { symbole } from "../../features/geoportail/map/symbology";

/**
 * Zone inferieure de la maquette (cahier paragraphe 4.1) : repartition de l'etat du reseau, degradation par region,
 * budget (quatre montants separes + bailleurs en montants CONTRACTUELS), qualite des donnees.
 * Chaque panneau lit SA section de la reponse : une section mal formee devient « reponse inattendue » dans ce seul
 * panneau. Aucun panneau ne convertit une absence en zero.
 */

function Panneau({ titre, sousTitre, children, id }: { titre: string; sousTitre?: ReactNode; children: ReactNode; id: string }) {
  return (
    <Card className="min-w-0 p-4" role="group" aria-labelledby={id}>
      <h3 id={id} className="text-sm font-semibold text-navy">{titre}</h3>
      {sousTitre && <p className="mt-0.5 text-xs text-gray-700">{sousTitre}</p>}
      <div className="mt-3">{children}</div>
    </Card>
  );
}

/** Marque qui DOUBLE la couleur par une forme (le rouge et le vert ne se distinguent pas pour tous). */
function MarqueSegment({ segment }: { segment: Pick<SegmentRepartition, "forme" | "couleur"> }) {
  const c = segment.couleur;
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" className="shrink-0">
      {segment.forme === "cercle" && <circle cx="7" cy="7" r="6" fill={c} />}
      {segment.forme === "losange" && <polygon points="7,0.5 13.5,7 7,13.5 0.5,7" fill={c} />}
      {segment.forme === "triangle" && <polygon points="7,1 13.5,13 0.5,13" fill={c} />}
      {segment.forme === "carre" && <rect x="1" y="1" width="12" height="12" fill={c} />}
      {segment.forme === "carre-creux" && <rect x="2" y="2" width="10" height="10" fill="none" stroke={c} strokeWidth="2.5" />}
    </svg>
  );
}

// ------------------------------------------------------------------------------------------ repartition

function Anneau({ segments }: { segments: SegmentRepartition[] }) {
  const R = 44;
  const { arcs, circonference, totalKm } = arcsAnneau(segments, R);
  return (
    <svg viewBox="0 0 120 120" role="img" aria-label="Anneau de répartition de l'état du réseau en kilomètres ; le détail est dans le tableau" className="h-36 w-36 shrink-0">
      <g transform="rotate(-90 60 60)">
        {arcs.map((a) => {
          const seg = segments.find((s) => s.cle === a.cle) as SegmentRepartition;
          return (
            <circle
              key={a.cle}
              cx="60" cy="60" r={R} fill="none" stroke={seg.couleur} strokeWidth="20"
              strokeDasharray={`${a.trace} ${circonference - a.trace}`} strokeDashoffset={a.decalage}
            />
          );
        })}
      </g>
      {arcs.length === 0 ? (
        <text x="60" y="64" textAnchor="middle" className="fill-gray-700 text-[10px]">km non disponibles</text>
      ) : (
        <>
          <text x="60" y="58" textAnchor="middle" className="fill-gray-900 text-[13px] font-bold">{formaterKm(totalKm).replace(/\u00a0km$/, "")}</text>
          <text x="60" y="73" textAnchor="middle" className="fill-gray-700 text-[10px]">km</text>
        </>
      )}
    </svg>
  );
}

export function PanneauRepartition({ section, periode, situation, onReessayer }: { section: Section<RepartitionEtat>; periode: string; situation: string; onReessayer: () => void }) {
  const id = useId();
  if (!section.ok) return <Panneau id={id} titre="Répartition de l'état du réseau"><EtatInattendu panneau="état du réseau" onReessayer={onReessayer} /></Panneau>;
  const rep = section.valeur;
  const sousTitre = `Longueur en km et part de la longueur à état valide (%) · ${periode} · ${situation}`;
  if (repartitionVide(rep)) {
    return (
      <Panneau id={id} titre="Répartition de l'état du réseau" sousTitre={sousTitre}>
        <EtatVide titre="Aucun tronçon dans ce périmètre." detail="Élargissez les filtres pour voir la répartition." />
      </Panneau>
    );
  }
  const segments = segmentsRepartition(rep);
  const kmIncomplets = segments.some((s) => s.km === null);
  return (
    <Panneau id={id} titre="Répartition de l'état du réseau" sousTitre={sousTitre}>
      <div className="flex flex-wrap items-center gap-4">
        <Anneau segments={segments} />
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- region defilante : doit etre focalisable pour le clavier (axe scrollable-region-focusable, mesure en navigateur) */}
        <div role="region" aria-label="Tableau de la répartition de l'état du réseau" tabIndex={0} className="w-full min-w-0 overflow-x-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-navy sm:w-auto sm:flex-1">
          <table className="w-full text-xs">
            <caption className="sr-only">Répartition de l&apos;état du réseau : longueur en km, part de la longueur à état valide en %, nombre de tronçons</caption>
            <thead>
              <tr className="text-left text-gray-800">
                <th scope="col" className="py-1 pr-2 font-semibold">État</th>
                <th scope="col" className="py-1 pr-2 text-right font-semibold">Longueur</th>
                <th scope="col" className="py-1 pr-2 text-right font-semibold">Part (%)</th>
                <th scope="col" className="py-1 text-right font-semibold">Tronçons</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {segments.map((s) => (
                <tr key={s.cle} data-etat={s.etat} data-type={s.type} data-non-evalue={s.nonEvalue ? "oui" : undefined}>
                  <th scope="row" className="py-1.5 pr-2 text-left font-normal text-gray-900">
                    <span className="flex items-center gap-1.5"><MarqueSegment segment={s} />{s.libelle}</span>
                  </th>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{formaterKm(s.km)}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {s.horsTaux ? (
                      <span className="text-gray-700">exclu des taux{s.partPerimetrePct !== null && <> ({formaterPct(s.partPerimetrePct)} du périmètre)</>}</span>
                    ) : (
                      formaterPct(s.partPct)
                    )}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{formaterEntier(s.nbTroncons)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-2 text-xs text-gray-700">
        Les tronçons <strong>non évalués</strong> et ceux à <strong>état non valide</strong> (état renseigné mais ni constaté ni vérifié) sont comptés à part : exclus du dénominateur des parts et jamais assimilés à « bon ».
        {rep.eligibleKm !== null && <> Longueur à état valide : {formaterKm(rep.eligibleKm)}{rep.perimetreKm !== null && <> sur {formaterKm(rep.perimetreKm)} de longueur connue</>}.</>}
        {rep.longueurMetierAbsente.troncons > 0 && <> {formaterEntier(rep.longueurMetierAbsente.troncons)} tronçon{rep.longueurMetierAbsente.troncons > 1 ? "s" : ""} sans longueur métier : comptés, jamais additionnés.</>}
        {kmIncomplets && <> Certaines longueurs ne sont pas disponibles : l&apos;anneau ne les représente pas.</>}
      </p>
    </Panneau>
  );
}

// ------------------------------------------------------------------------------------------ regions

/**
 * LIBELLE DOCUMENTE : la maquette dit « Priorites par region », mais le module ne produit AUCUN score regional de
 * priorite. Le panneau montre ce qui existe : la part du reseau degrade par region, avec sa couverture, et le dit.
 */
export const TITRE_PANNEAU_REGIONS = "Part du réseau dégradé par région";
const MENTION_REGIONS_DEFAUT = "Ce n'est pas un classement de priorité : le module ne calcule pas de score régional. Part de la longueur à état valide en classes dégradées (définition provisoire).";

export function PanneauRegions({ section, filtres, onFiltres, onReessayer }: { section: Section<DegradationSynthese>; filtres: FiltresDecision; onFiltres: (f: FiltresDecision) => void; onReessayer: () => void }) {
  const id = useId();
  if (!section.ok) return <Panneau id={id} titre={TITRE_PANNEAU_REGIONS}><EtatInattendu panneau="régions" onReessayer={onReessayer} /></Panneau>;
  const lignes = trierRegions(section.valeur.regions);
  return (
    <Panneau id={id} titre={TITRE_PANNEAU_REGIONS} sousTitre={section.valeur.mention || MENTION_REGIONS_DEFAUT}>
      {lignes.length === 0 ? (
        <EtatVide titre="Aucune région dans ce périmètre." />
      ) : (
        <ul className="space-y-1">
          {lignes.map((r) => {
            const couv = texteCouverture({ eligibleKm: r.eligibleKm, nonEvalueKm: r.nonEvalueKm });
            const actif = filtres.regionId === r.regionId;
            const nom = nomRegion(r);
            return (
              <li key={r.regionId}>
                <button
                  type="button"
                  aria-pressed={actif}
                  aria-label={`Filtrer sur la région ${nom}`}
                  onClick={() => onFiltres({ ...filtres, regionId: r.regionId })}
                  className={`flex min-h-[44px] w-full flex-col gap-1 rounded-md px-2 py-1 text-left hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-0 ${actif ? "bg-gray-100" : ""}`}
                >
                  <span className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 break-words font-medium text-gray-900">{nom}</span>
                    <span className="shrink-0 tabular-nums font-semibold text-gray-900" data-testid={`degrade-${r.regionId}`}>
                      {r.partDegradeePct === null ? "Non calculable" : formaterPct(r.partDegradeePct)}
                    </span>
                  </span>
                  {r.partDegradeePct !== null && (
                    <span aria-hidden="true" className="block h-2 w-full overflow-hidden rounded bg-gray-200">
                      <span className="block h-full rounded" style={{ width: `${Math.min(100, Math.max(0, r.partDegradeePct))}%`, backgroundColor: symbole("MAUVAIS").trait }} />
                    </span>
                  )}
                  <span className="text-xs text-gray-700">
                    {r.partDegradeePct === null ? "Aucun tronçon à état valide dans cette région. " : ""}
                    {couv ? `Longueur : ${couv}` : "Couverture non fournie"}
                    {r.tronconsSansLongueurMetier > 0 ? ` · ${r.tronconsSansLongueurMetier} tronçon${r.tronconsSansLongueurMetier > 1 ? "s" : ""} sans longueur métier` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panneau>
  );
}

// ------------------------------------------------------------------------------------------ budget

const LIBELLES_MONTANTS: { cle: "contractuel" | "engage" | "decaisse" | "previsionnel"; libelle: string }[] = [
  { cle: "contractuel", libelle: "Contractuel" },
  { cle: "engage", libelle: "Engagé" },
  { cle: "decaisse", libelle: "Décaissé" },
  { cle: "previsionnel", libelle: "Prévisionnel" },
];

const MENTION_BUDGET_DEFAUT = "Quatre montants séparés, jamais confondus : un montant contractuel n'est ni engagé, ni décaissé, ni prévisionnel.";

function BlocMontant({ libelle, m }: { libelle: string; m: MontantEtat }) {
  // Un montant NON_AUTORISE n'est pas inconnu : le droit financier manque. On le dit autrement que « Non disponible ».
  const montre = m.valeurGnf !== null && (m.etat === "DISPONIBLE" || m.etat === "PARTIEL");
  const texteAbsent = m.etat === "NON_AUTORISE" ? "Non autorisé" : ABSENT;
  const ton = m.etat === "DISPONIBLE" ? "border-green-300 bg-green-100 text-green-900" : m.etat === "PARTIEL" ? "border-amber-300 bg-amber-100 text-amber-900" : "border-gray-300 bg-gray-100 text-gray-800";
  return (
    <div data-montant={libelle} data-etat={m.etat} className="min-w-0 rounded-md border border-gray-200 p-2">
      <dt className="flex flex-wrap items-center gap-1 text-xs font-semibold text-gray-800">
        {libelle}
        <span className={`rounded-full border px-1.5 py-0.5 text-[11px] font-medium ${ton}`}>{LIBELLE_ETAT_MONTANT[m.etat]}</span>
      </dt>
      <dd className="mt-1 break-words text-sm font-bold text-navy tabular-nums">{montre ? formaterGnf(m.valeurGnf) : texteAbsent}</dd>
      {m.avertissement && <dd className="mt-0.5 text-xs font-medium text-amber-900">{m.avertissement}</dd>}
      {m.source && <dd className="mt-0.5 text-xs text-gray-700">Source : {m.source}</dd>}
    </div>
  );
}

/** Montant contractuel d'une ligne : null = aucun marche avec montant GNF, dit « Montant non disponible » (jamais 0) ; les marches restent comptes. */
function CelluleMontant({ montant, avecMontant }: { montant: string | null; avecMontant: number | null }) {
  if (montant === null) {
    return (
      <td className="py-1.5 pr-2 text-right text-gray-800" data-montant-inconnu="oui" title={avecMontant === 0 ? "Aucun marché de ce bailleur n'a de montant en GNF saisi" : "Aucun marché de ces bailleurs n'a de montant en GNF saisi"}>
        Montant non disponible
      </td>
    );
  }
  return <td className="py-1.5 pr-2 text-right tabular-nums" title={formaterGnf(montant)}>{formaterGnf(montant, true)}</td>;
}

export function PanneauBudget({ section, onReessayer }: { section: Section<BudgetSynthese>; onReessayer: () => void }) {
  const id = useId();
  const idBailleurs = useId();
  if (!section.ok) return <Panneau id={id} titre="Budget"><EtatInattendu panneau="budget" onReessayer={onReessayer} /></Panneau>;
  const b = section.valeur;
  const pb = b.parBailleur;
  const lignes = trierBailleurs(pb.lignes);
  // Les parts se calculent sur le total CONTRACTUEL du budget (lignes + « autres »), jamais sur la somme des seules lignes affichees.
  const totalContractuel = b.contractuel.valeurGnf;
  const part = (montant: string | null): string => {
    const p = partDuTotalContractuel(montant, totalContractuel);
    return p === null ? ABSENT : formaterPct(p);
  };
  return (
    <Panneau id={id} titre="Budget" sousTitre={b.mention || MENTION_BUDGET_DEFAUT}>
      <dl className="grid gap-2 sm:grid-cols-2">
        {LIBELLES_MONTANTS.map((l) => <BlocMontant key={l.cle} libelle={l.libelle} m={b[l.cle]} />)}
      </dl>

      <h4 id={idBailleurs} className="mt-4 text-sm font-semibold text-navy">Budget par bailleur : montants contractuels</h4>
      <p className="mt-0.5 text-xs text-gray-700">Montants contractuels des marchés recensés, regroupés par bailleur (lien marché-bailleur de la base). Ce ne sont ni des montants engagés ni des montants décaissés.</p>
      {pb.etat === "NON_AUTORISE" ? (
        <div className="mt-2"><EtatPermission panneau="Budget par bailleur" message={pb.avertissement ?? undefined} /></div>
      ) : lignes.length === 0 ? (
        <div className="mt-2"><EtatVide titre="Aucune ventilation par bailleur disponible." detail={pb.avertissement ?? "Aucun marché avec bailleur recensé dans ce périmètre."} /></div>
      ) : (
        <>
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- region defilante : doit etre focalisable pour le clavier */}
          <div role="region" aria-label="Tableau du budget par bailleur" tabIndex={0} className="mt-2 overflow-x-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-navy">
            <table aria-labelledby={idBailleurs} className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-800">
                  <th scope="col" className="py-1 pr-2 font-semibold">Bailleur</th>
                  <th scope="col" className="py-1 pr-2 text-right font-semibold">Montant contractuel</th>
                  <th scope="col" className="py-1 pr-2 text-right font-semibold">Part du total contractuel (%)</th>
                  <th scope="col" className="py-1 text-right font-semibold">Marchés</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {lignes.map((x) => (
                  <tr key={`${x.bailleurId ?? "nr"}-${x.bailleur}`}>
                    <th scope="row" className="py-1.5 pr-2 text-left font-normal text-gray-900">{x.bailleur || "Bailleur non renseigné"}</th>
                    <CelluleMontant montant={x.contractuelGnf} avecMontant={x.marchesAvecMontantGnf} />
                    <td className="py-1.5 pr-2 text-right tabular-nums">{part(x.contractuelGnf)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formaterEntier(x.marches)}</td>
                  </tr>
                ))}
                {pb.autres && (
                  <tr data-ligne="autres">
                    <th scope="row" className="py-1.5 pr-2 text-left font-normal text-gray-900">Autres bailleurs ({formaterEntier(pb.autres.bailleurs)})</th>
                    <CelluleMontant montant={pb.autres.contractuelGnf} avecMontant={null} />
                    <td className="py-1.5 pr-2 text-right tabular-nums">{part(pb.autres.contractuelGnf)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formaterEntier(pb.autres.marches)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {totalContractuel === null && <p className="mt-1 text-xs font-medium text-amber-900">Total contractuel non disponible : les parts ne sont pas calculées.</p>}
          {pb.avertissement && <p className="mt-1 text-xs font-medium text-amber-900">{pb.avertissement}</p>}
        </>
      )}
    </Panneau>
  );
}

// ------------------------------------------------------------------------------------------ qualite

const LIBELLE_GRAVITE: Record<string, string> = { BLOQUANTE: "Bloquantes", A_TRAITER: "À traiter", A_SURVEILLER: "À surveiller" };

export function PanneauQualite({ section, onReessayer }: { section: Section<QualiteSynthese>; onReessayer: () => void }) {
  const id = useId();
  if (!section.ok) return <Panneau id={id} titre="Qualité des données"><EtatInattendu panneau="qualité des données" onReessayer={onReessayer} /></Panneau>;
  const q = section.valeur;
  const gravites = q.parGravite ? Object.entries(q.parGravite) : [];
  const borneBasse = q.famillesNonExecutees.length > 0;
  return (
    <Panneau id={id} titre="Qualité des données" sousTitre="Anomalies détectées dans le périmètre (détecteurs de qualité en lecture seule).">
      {q.total === null ? (
        <p className="text-sm font-semibold text-gray-800">{ABSENT} <span className="font-normal text-gray-700">: le nombre d&apos;anomalies n&apos;est pas fourni.</span></p>
      ) : q.total === 0 ? (
        <p className="text-sm font-semibold text-gray-900">Aucune anomalie détectée dans ce périmètre.</p>
      ) : (
        <p className="text-sm font-semibold text-gray-900">
          {borneBasse && "Au moins "}{formaterEntier(q.total)} anomalie{q.total > 1 ? "s" : ""} détectée{q.total > 1 ? "s" : ""}
          {q.population !== null && <span className="font-normal text-gray-700"> sur {formaterEntier(q.population)} tronçon{q.population > 1 ? "s" : ""} examiné{q.population > 1 ? "s" : ""}</span>}.
        </p>
      )}
      {gravites.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2 text-xs text-gray-800">
          {gravites.map(([g, n]) => <li key={g} className="rounded-full border border-gray-300 px-2 py-0.5">{LIBELLE_GRAVITE[g] ?? g} : {formaterEntier(n)}</li>)}
        </ul>
      )}
      {q.parGravite === null && q.total !== null && <p className="mt-1 text-xs text-gray-700">Répartition par gravité non fournie.</p>}
      {borneBasse && (
        <p className="mt-1 text-xs font-medium text-amber-900" data-testid="qualite-borne-basse">
          Familles de détecteurs non exécutées dans la synthèse : {q.famillesNonExecutees.join(", ")}. Le nombre est une borne basse ; le détail complet est dans « Qualité des données ».
        </p>
      )}
      {q.donneesAConfirmer !== null && <p className="mt-1 text-xs text-gray-700">Données à confirmer (tronçons non évalués + anomalies) : {formaterEntier(q.donneesAConfirmer)}.</p>}
      {q.avertissements.map((a) => <p key={a} className="mt-1 text-xs font-medium text-amber-900">{a}</p>)}
      <p className="mt-3">
        <Link to="/qualite" className="inline-flex min-h-[44px] items-center text-sm font-medium text-navy underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy xl:min-h-0">
          Voir le détail dans « Qualité des données »
        </Link>
      </p>
    </Panneau>
  );
}
