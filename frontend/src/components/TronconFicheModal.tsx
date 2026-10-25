import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { EtatBadge } from "./ui/Badge";
import { QualiteBadge, qualiteDe, type QualiteChamp } from "./QualiteBadge";
import { EntityForm } from "./EntityForm";
import { FicheChildManager } from "./FicheChildManager";
import { TronconDocumentsTab } from "./TronconDocumentsTab";
import { VoletPortions, VoletProgrammation } from "./Fiche360Volets";
import { ChantiersDuTroncon } from "./ChantiersDuTroncon";
import { useEntityMutations } from "../hooks/useEntity";
import { useAuth, canWrite as canWriteRole } from "../lib/auth";
import { parseApiError } from "../lib/errors";
import { printFiche } from "../lib/print";
import { formaterPk } from "../lib/pk";
import { tronconFields, ouvrageFields, pointNoirFields, posteFields, chantierFields, inspectionFields } from "../lib/fieldConfigs";
import type { Chantier, Inspection, Ouvrage, PointNoir, Poste, Troncon } from "../types";

interface PortionFiche {
  id: string;
  debutM: number;
  finM: number;
  statutValidation: string;
  origine: string;
  observeeLe: string | null;
  revetementRef: { libelle: string; bitumineux: boolean } | null;
  etatRef: { libelle: string; critique: boolean } | null;
  praticabiliteRef: { libelle: string } | null;
  creePar: { nomComplet: string } | null;
}

interface LigneRepartition { cle: string; longueurM: number; part: number }

/** Ce que la fiche rend du tronçon, au-delà du type de liste : provenance, localisation, validation. */
type TronconFiche = Troncon & {
  prefecture?: string | null; commune?: string | null; statutValidation?: string | null;
  sourceType?: string | null; sourceReference?: string | null; sourceConfidence?: string | null; observations?: string | null;
};

const LIBELLE_CLASSE: Record<string, string> = { RN: "Route nationale", RR: "Route préfectorale", RU: "Voirie urbaine", PISTE: "Piste rurale", NON_CLASSEE: "Non classée" };
const LIBELLE_REVETEMENT: Record<string, string> = { BITUME: "Bitume", TERRE: "Terre", LATERITE: "Latérite", PAVE: "Pavé", NON_RENSEIGNE: "Non renseigné" };
const LIBELLE_VALIDATION: Record<string, string> = { VALIDE: "Validé", A_VALIDER: "À valider", REJETE: "Rejeté", A_CORRIGER: "À corriger" };
const LIBELLE_STATUT_ANOMALIE: Record<string, string> = { A_EXAMINER: "À examiner", CORRECTION_PROPOSEE: "Correction proposée", VALIDEE: "Validée", REJETEE: "Rejetée", CORRIGEE: "Corrigée" };
/** Valeur absente : dite comme telle, jamais un zéro ni un tiret ambigu. */
const nonRenseigne = <span className="font-normal text-gray-500">non renseigné</span>;

interface AnomalieFiche { id: string; regle: string; gravite: string; statut: string; detecteeLe: string; disparueLe: string | null }
interface EntreeAudit { id: string; action: string; createdAt: string; user?: { nomComplet?: string } | null; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null }

interface Fiche {
  troncon: TronconFiche;
  /** Longueur MESUREE sur la géométrie. Nulle quand le tracé n'est pas exploitable. */
  longueurGeometriqueM: number | null;
  ouvrages: Ouvrage[];
  pointsNoirs: PointNoir[];
  postes: Poste[];
  chantiers: Chantier[];
  inspections: (Inspection & { inspecteur?: { nomComplet: string } })[];
  portions: PortionFiche[];
  defauts: { id: string; code: string; gravite: number | null; catalogue?: { libelle: string } }[];
  missions: { id: string; code: string; intitule: string; statut: string }[];
  couverture: {
    longueurTronconM: number; qualifieM: number; part: number;
    trous: { debutM: number; finM: number; longueurM: number }[];
  } | null;
  repartitions: {
    revetement: LigneRepartition[];
    etat: LigneRepartition[];
    praticabilite: LigneRepartition[];
  } | null;
  chevauchements: { a: string; b: string; longueurM: number }[];
}

type TabKey = "infos" | "portions" | "versions" | "ouvrages" | "pointsNoirs" | "postes" | "chantiers" | "inspections" | "defauts" | "anomalies" | "historique" | "programmation" | "documents";

function metres(v: number): string {
  return v >= 1_000 ? `${(v / 1_000).toFixed(2)} km` : `${Math.round(v)} m`;
}

export function TronconFicheModal({ open, onClose, tronconId }: { open: boolean; onClose: () => void; tronconId: string }) {
  const { user } = useAuth();
  const writable = canWriteRole(user?.role);
  const [tab, setTab] = useState<TabKey>("infos");
  const [editingInfos, setEditingInfos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const qc = useQueryClient();
  const { update } = useEntityMutations("troncons");

  const { data, isLoading } = useQuery({
    queryKey: ["troncon", "fiche", tronconId],
    queryFn: async () => (await api.get<Fiche>(`/troncons/${tronconId}/fiche`)).data,
    enabled: open,
  });

  // Ce que l'on sait des valeurs affichees. Requete separee : la fiche reste lisible
  // si l'appel echoue, et l'absence de qualite se traduit par une absence de badge,
  // jamais par une valeur presentee comme plus sure qu'elle ne l'est.
  const { data: qualite } = useQuery({
    queryKey: ["troncon", "qualite", tronconId],
    queryFn: async () =>
      (await api.get<{ champs: QualiteChamp[] }>(`/qualite/Troncon/${tronconId}`)).data.champs,
    enabled: open,
    retry: false,
  });

  // Anomalies du registre du referentiel pour CE troncon (lot C), et historique de ses modifications : chargees
  // a l'ouverture de leur onglet seulement.
  const anomalies = useQuery({
    queryKey: ["referentiel", "anomalies", "troncon", tronconId],
    queryFn: async () => (await api.get<{ data: AnomalieFiche[]; total: number }>("/v2/referentiel/troncons/anomalies", { params: { tronconId, inclureDisparues: "true", pageSize: 100 } })).data,
    enabled: open && tab === "anomalies",
    retry: false,
  });
  const historique = useQuery({
    queryKey: ["troncon", "audit", tronconId],
    queryFn: async () => (await api.get<{ data: EntreeAudit[] }>("/audit", { params: { entityType: "Troncon", entityId: tronconId, pageSize: 50 } })).data.data,
    enabled: open && tab === "historique",
    retry: false,
  });

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "infos", label: "Infos" },
    { key: "portions", label: "Portions", count: data?.portions.length },
    { key: "versions", label: "Historique des portions" },
    { key: "ouvrages", label: "Ouvrages", count: data?.ouvrages.length },
    { key: "pointsNoirs", label: "Points noirs", count: data?.pointsNoirs.length },
    { key: "postes", label: "Péages", count: data?.postes.length },
    { key: "chantiers", label: "Chantiers", count: data?.chantiers.length },
    { key: "inspections", label: "Inspections", count: data?.inspections.length },
    { key: "defauts", label: "Défauts et missions", count: data ? (data.defauts?.length ?? 0) + (data.missions?.length ?? 0) : undefined },
    { key: "anomalies", label: "Anomalies du référentiel" },
    { key: "historique", label: "Historique" },
    { key: "programmation", label: "Programmation" },
    { key: "documents", label: "Documents" },
  ];

  const title = data ? `${data.troncon.code} — ${data.troncon.nom}` : "Fiche tronçon";

  async function handleInfosSubmit(values: Record<string, unknown>) {
    setError(null);
    setFieldErrors({});
    try {
      await update.mutateAsync({ id: tronconId, payload: values });
      await qc.invalidateQueries({ queryKey: ["troncon", "fiche", tronconId] });
      setEditingInfos(false);
    } catch (err) {
      const parsed = parseApiError(err);
      setError(parsed.message);
      setFieldErrors(parsed.fieldErrors);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title}>
      {isLoading || !data ? (
        <p className="text-sm text-gray-500">Chargement...</p>
      ) : (
        <div>
          <div className="flex justify-end mb-2">
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={printFiche}>
              🖨 Imprimer / PDF
            </Button>
          </div>
          <div className="flex flex-wrap gap-1 border-b border-gray-100 mb-3">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${
                  tab === t.key ? "border-gold text-navy font-medium" : "border-transparent text-gray-500 hover:text-navy"
                }`}
              >
                {t.label}
                {t.count != null && <span className="ml-1 text-xs text-gray-500">({t.count})</span>}
              </button>
            ))}
          </div>

          <div className="max-h-80 overflow-y-auto text-sm">
            {tab === "infos" &&
              (editingInfos ? (
                <EntityForm
                  fields={tronconFields}
                  defaultValues={{ ...data.troncon }}
                  onSubmit={handleInfosSubmit}
                  submitting={update.isPending}
                  serverError={error}
                  serverFieldErrors={fieldErrors}
                />
              ) : (
                <div className="space-y-1">
                  <Row label="Code" value={data.troncon.code} />
                  <Row label="Classe" value={LIBELLE_CLASSE[data.troncon.classe] ?? data.troncon.classe} />
                  <Row label="Région" value={data.troncon.region?.nom ?? nonRenseigne} />
                  <Row label="Préfecture, commune" value={data.troncon.prefecture || data.troncon.commune ? [data.troncon.prefecture, data.troncon.commune].filter(Boolean).join(", ") : nonRenseigne} />
                  <Row
                    label="Longueur déclarée"
                    value={
                      <>
                        {data.troncon.longueurKm > 0 ? `${data.troncon.longueurKm.toFixed(2)} km` : nonRenseigne}{" "}
                        <QualiteBadge qualite={qualiteDe(qualite, "longueurKm")} />
                      </>
                    }
                  />
                  <Row
                    label="Longueur du tracé"
                    value={data.longueurGeometriqueM != null ? <span title="ST_Length(geom::geography), géodésique">{metres(data.longueurGeometriqueM)}</span> : <span className="font-normal text-amber-800">sans tracé exploitable</span>}
                  />
                  <Row
                    label="Revêtement"
                    value={
                      <>
                        {LIBELLE_REVETEMENT[data.troncon.revetement] ?? data.troncon.revetement} <QualiteBadge qualite={qualiteDe(qualite, "revetement")} />
                      </>
                    }
                  />
                  <Row
                    label="PK début → fin"
                    value={data.troncon.pkDebut === 0 && data.troncon.pkFin === 0
                      ? <span className="font-normal text-orange-700">non renseignés</span>
                      : `${formaterPk(data.troncon.pkDebut, { prefixe: false })} → ${formaterPk(data.troncon.pkFin, { prefixe: false })}`}
                  />
                  <Row label="Statut de validation" value={data.troncon.statutValidation ? LIBELLE_VALIDATION[data.troncon.statutValidation] ?? data.troncon.statutValidation : nonRenseigne} />
                  <Row
                    label="Source"
                    value={data.troncon.sourceType || data.troncon.sourceReference
                      ? [data.troncon.sourceType, data.troncon.sourceReference, data.troncon.sourceConfidence && `confiance ${data.troncon.sourceConfidence}`].filter(Boolean).join(" · ")
                      : nonRenseigne}
                  />
                  <Row
                    label="Trafic moyen (j)"
                    value={
                      <>
                        {data.troncon.traficMoyenJma ?? "—"}{" "}
                        <QualiteBadge qualite={qualiteDe(qualite, "traficMoyenJma")} />
                      </>
                    }
                  />
                  <Row
                    label="État"
                    value={
                      <>
                        <EtatBadge etat={data.troncon.etat} />{" "}
                        <QualiteBadge qualite={qualiteDe(qualite, "etat")} />
                      </>
                    }
                  />
                  {writable && (
                    <div className="flex justify-end pt-2">
                      <Button className="px-2 py-1 text-xs" onClick={() => setEditingInfos(true)}>
                        Modifier
                      </Button>
                    </div>
                  )}
                </div>
              ))}

            {tab === "ouvrages" && (
              <FicheChildManager
                tronconId={tronconId}
                endpoint="ouvrages"
                title="Ouvrage"
                fields={ouvrageFields}
                items={data.ouvrages}
                renderItem={(o) => `${o.nom} (${o.type})`}
                emptyLabel="Aucun ouvrage."
                canWrite={writable}
                geolocatable
                withPhotos
              />
            )}
            {tab === "pointsNoirs" && (
              <FicheChildManager
                tronconId={tronconId}
                endpoint="points-noirs"
                title="Point noir"
                fields={pointNoirFields}
                items={data.pointsNoirs}
                renderItem={(p) => `${p.description} — gravité ${p.gravite}`}
                emptyLabel="Aucun point noir."
                canWrite={writable}
                geolocatable
              />
            )}
            {tab === "postes" && (
              <FicheChildManager
                tronconId={tronconId}
                endpoint="postes"
                title="Péage / Pesage"
                fields={posteFields}
                items={data.postes}
                renderItem={(p) => `${p.nom} (${p.type}) — ${p.statut}`}
                emptyLabel="Aucun poste."
                canWrite={writable}
                geolocatable
              />
            )}
            {tab === "chantiers" && (
              <div className="space-y-3">
              <ChantiersDuTroncon tronconId={tronconId} inspections={data.inspections ?? []} />
              <FicheChildManager
                tronconId={tronconId}
                endpoint="chantiers"
                title="Chantier"
                fields={chantierFields}
                items={data.chantiers}
                renderItem={(c) => `${c.intitule} — ${c.statut} (${c.avancementPct}%)`}
                emptyLabel="Aucun chantier."
                canWrite={writable}
              />
              </div>
            )}
            {tab === "inspections" && (
              <FicheChildManager
                tronconId={tronconId}
                endpoint="inspections"
                title="Inspection"
                fields={inspectionFields}
                items={data.inspections}
                renderItem={(i) => `${new Date(i.dateInspection).toLocaleDateString("fr-FR")} — ${i.etatObserve}${i.inspecteur ? ` (${i.inspecteur.nomComplet})` : ""}`}
                emptyLabel="Aucune inspection."
                canWrite={writable}
                withPhotos
              />
            )}
            {tab === "portions" && (
              <div className="space-y-4">
                {/* LA LONGUEUR MESUREE A COTE DE LA DECLAREE, jamais a sa place : l'une
                    vient d'AGEROUTE, l'autre de la numerisation. 1 028 des 1 029 troncons
                    regionaux n'ont aucune longueur declaree, et rendre la seule
                    geometrique les ferait passer pour documentes. */}
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <dt className="text-slate-500">Longueur déclarée</dt>
                  <dd>{data.troncon.longueurKm ? `${data.troncon.longueurKm} km` : <span className="text-amber-700">non renseignée</span>}</dd>
                  <dt className="text-slate-500">Longueur mesurée sur le tracé</dt>
                  <dd>{data.longueurGeometriqueM !== null ? metres(data.longueurGeometriqueM) : <span className="text-amber-700">tracé non exploitable</span>}</dd>
                </dl>

                {data.couverture === null ? (
                  <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
                    Aucune couverture calculable : le tracé n'a pas de longueur mesurable, donc
                    aucune portion ne peut y être bornée. Un pourcentage serait inventé.
                  </p>
                ) : (
                  <div className="space-y-2 text-sm">
                    <p>
                      Qualifié : <strong>{metres(data.couverture.qualifieM)}</strong> sur{" "}
                      {metres(data.couverture.longueurTronconM)} ({Math.round(data.couverture.part * 100)} %).
                    </p>
                    {data.couverture.trous.length > 0 && (
                      /* LES TROUS SONT NOMMES PAR LEURS ABSCISSES. « 60 % qualifie »
                         n'envoie personne nulle part. */
                      <p className="text-slate-700">
                        Non qualifié :{" "}
                        {data.couverture.trous.map((t) => `${metres(t.debutM)} à ${metres(t.finM)}`).join(", ")}.
                      </p>
                    )}
                  </div>
                )}

                {data.chevauchements.length > 0 && (
                  /* SIGNALE, JAMAIS CORRIGE : deux portions qui se recouvrent disent deux
                     choses du meme metre, et trancher appartient a un humain. */
                  <p className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">
                    <strong>{data.chevauchements.length} chevauchement(s)</strong> entre portions :{" "}
                    {data.chevauchements.map((c) => `${metres(c.longueurM)}`).join(", ")}. À arbitrer :
                    deux portions décrivent les mêmes mètres.
                  </p>
                )}

                {data.repartitions && (
                  <div className="grid gap-3 sm:grid-cols-3">
                    {([["revetement", "Revêtement"], ["etat", "État"], ["praticabilite", "Praticabilité"]] as const).map(([cle, titre]) => (
                      <div key={cle}>
                        <h4 className="text-xs font-semibold uppercase text-slate-500">{titre}</h4>
                        <ul className="mt-1 space-y-0.5 text-sm">
                          {data.repartitions![cle].length === 0 && <li className="text-slate-500">—</li>}
                          {data.repartitions![cle].map((r) => (
                            <li key={r.cle} className={r.cle === "NON_QUALIFIE" ? "text-amber-700" : undefined}>
                              {r.cle === "NON_QUALIFIE" ? "Non qualifié" : r.cle === "NON_RENSEIGNE" ? "Non renseigné" : r.cle}
                              {" : "}{metres(r.longueurM)} ({Math.round(r.part * 100)} %)
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}

                {data.portions.length === 0 ? (
                  <p className="text-sm text-slate-600">
                    Aucune portion. Ce tronçon n'a jamais été inventorié : il n'hérite ni du
                    revêtement ni de l'état portés par sa fiche, qui sont des valeurs déclarées.
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-slate-500">
                      <tr>
                        <th className="py-1">Emprise</th><th>Revêtement</th><th>État</th>
                        <th>Statut</th><th>Constatée</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.portions.map((p) => (
                        <tr key={p.id} className="border-t">
                          <td className="py-1">{metres(p.debutM)} – {metres(p.finM)}</td>
                          <td>{p.revetementRef?.libelle ?? <span className="text-slate-500">—</span>}</td>
                          <td className={p.etatRef?.critique ? "text-red-700" : undefined}>
                            {p.etatRef?.libelle ?? <span className="text-slate-500">—</span>}
                          </td>
                          <td>
                            {p.statutValidation === "VALIDE"
                              ? <span className="text-green-700">Validée</span>
                              : <span className="text-amber-700">Proposition</span>}
                          </td>
                          <td>
                            {p.observeeLe
                              ? new Date(p.observeeLe).toLocaleDateString("fr-FR")
                              : <span className="text-amber-700">non renseignée</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* Fiche 360 : volets portion (versions, historique, etat a une date) et programmation. */}
            {tab === "versions" && <VoletPortions tronconId={tronconId} />}
            {tab === "defauts" && (
              <div className="space-y-3">
                <section>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-600">Défauts relevés ({data.defauts?.length ?? 0})</h3>
                  {(data.defauts ?? []).length === 0 ? <p className="text-xs text-gray-600">Aucun défaut relevé sur ce tronçon.</p> : (
                    <ul className="divide-y text-xs">{(data.defauts ?? []).map((d) => <li key={d.id} className="py-1">{d.catalogue?.libelle ?? "Type non renseigné"}{d.code ? ` · ${d.code}` : ""} · gravité {d.gravite ?? "non renseignée"}</li>)}</ul>
                  )}
                </section>
                <section>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-600">Missions ({data.missions?.length ?? 0})</h3>
                  {(data.missions ?? []).length === 0 ? <p className="text-xs text-gray-600">Aucune mission rattachée.</p> : (
                    <ul className="divide-y text-xs">{(data.missions ?? []).map((m) => <li key={m.id} className="py-1">{m.code} · {m.intitule} · {m.statut.toLowerCase().replace(/_/g, " ")}</li>)}</ul>
                  )}
                </section>
              </div>
            )}
            {tab === "anomalies" && (
              anomalies.isLoading ? <p className="text-xs text-gray-500">Chargement…</p>
                : anomalies.isError ? <p className="text-xs text-amber-800">Registre des anomalies indisponible pour votre compte.</p>
                : (anomalies.data?.data.length ?? 0) === 0 ? <p className="text-xs text-gray-600">Aucune anomalie enregistrée pour ce tronçon (le registre se remplit par une analyse).</p>
                : (
                  <ul className="divide-y text-xs">
                    {anomalies.data!.data.map((a) => (
                      <li key={a.id} className="flex flex-wrap justify-between gap-2 py-1">
                        <span>{a.regle.toLowerCase().replace(/_/g, " ")} · {a.gravite.toLowerCase()}{a.disparueLe ? " · ne se constate plus" : ""}</span>
                        <span className="text-gray-700">{LIBELLE_STATUT_ANOMALIE[a.statut] ?? a.statut}</span>
                      </li>
                    ))}
                    <li className="py-1"><a className="text-navy underline" href="/troncons/audit">Examiner dans le registre</a></li>
                  </ul>
                )
            )}
            {tab === "historique" && (
              historique.isLoading ? <p className="text-xs text-gray-500">Chargement…</p>
                : historique.isError ? <p className="text-xs text-amber-800">Historique indisponible pour votre compte.</p>
                : (historique.data?.length ?? 0) === 0 ? <p className="text-xs text-gray-600">Aucune modification enregistrée.</p>
                : (
                  <ol className="space-y-1 text-xs">
                    {historique.data!.map((e) => (
                      <li key={e.id} className="border-l-2 border-navy/20 pl-2">
                        <span className="font-medium">{e.action}</span> · {new Date(e.createdAt).toLocaleString("fr-FR")} · {e.user?.nomComplet ?? "auteur non renseigné"}
                        {e.after && <p className="break-all text-gray-700">{Object.keys(e.after).slice(0, 6).join(", ")}</p>}
                      </li>
                    ))}
                  </ol>
                )
            )}
            {tab === "programmation" && <VoletProgrammation tronconId={tronconId} />}

            {tab === "documents" && <TronconDocumentsTab tronconId={tronconId} canWrite={writable} />}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2 py-0.5">
      <span className="text-gray-500">{label}</span>
      <span className="text-navy font-medium text-right">{value}</span>
    </div>
  );
}
