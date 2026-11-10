/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useId, useMemo, useState } from "react";
import { FolderTree, PenLine, Plus, Trash2 } from "lucide-react";
import { Button } from "../../ui/Button";
import { Input, Select } from "../../ui/Input";
import { CadreDialogue, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { EtatChargement, EtatErreur, EtatVide } from "../EtatsPv";
import { EditeurEmprise } from "./EditeurEmprise";
import {
  useArbreTerritoires, useConfiguration, useCreerTerritoire, useFicheTerritoire, useModifierTerritoire, useRegions, useRetirerTerritoire,
} from "../../../lib/projetsVoirieTerritoiresHooks";
import type { AvertissementTerritoire, CorpsModifTerritoire, CorpsTerritoire } from "../../../lib/projetsVoirieTerritoiresApi";
import {
  LIBELLE_NIVEAU, MOTIF_CODE, SAISIE_EMPRISE_VIDE, classerErreurTerritoires, empriseDepuisSaisie, filtrerTerritoires, formaterBbox, listeBlancheEffective, niveauxEnfantsPossibles,
  type NiveauTerritoire, type SaisieEmprise, type Territoire,
} from "../../../lib/projetsVoirieTerritoires";
import type { Bbox } from "../../../lib/projetsVoirie";

/**
 * Administration des territoires (ADMIN) : arborescence, creation, modification, retrait LOGIQUE. Le serveur reste la reference : parent, niveau
 * et code sont immuables apres creation ; un territoire qui porte des enfants ou des projets ne se retire pas (409 TERRITOIRE_UTILISE, explique) ;
 * les avertissements d'emprise (hors du parent, hors de l'emprise nationale) sont affiches sans bloquer. Aucun nom de lieu n'est code.
 */
/** Retrait par profondeur : classes de l'echelle d'espacement (revue m5 : plus de style en ligne). */
const RETRAIT = ["ml-0", "ml-4", "ml-8", "ml-12", "ml-16", "ml-20", "ml-24"] as const;

export function OngletTerritoires({ enLigne }: { enLigne: boolean }) {
  const arbre = useArbreTerritoires(true);
  const config = useConfiguration(true);
  const [saisie, setSaisie] = useState("");
  const [creation, setCreation] = useState<{ parent: Territoire | null } | null>(null);
  const [edition, setEdition] = useState<Territoire | null>(null);
  const [retrait, setRetrait] = useState<Territoire | null>(null);
  const [annonce, setAnnonce] = useState<{ texte: string; avertissements: AvertissementTerritoire[] } | null>(null);
  const liste = useMemo(() => filtrerTerritoires(arbre.data?.territoires ?? [], { q: saisie }), [arbre.data, saisie]);
  const aUneNation = (arbre.data?.territoires ?? []).some((t) => t.niveau === "NATION");
  const crsAdmis = (listeBlancheEffective(config.data?.configuration) ?? []).filter((e) => e !== 4326);
  // Revue m10 : reference stable (la carte d'emprise recadre quand la reference change ; un nouveau rendu ne doit pas annuler le zoom).
  const empriseNationale = useMemo(() => {
    const e = config.data?.configuration.find((c) => c.cle === "EMPRISE_PLAUSIBILITE")?.valeur as { bbox?: unknown } | undefined;
    return Array.isArray(e?.bbox) && e.bbox.length === 4 && e.bbox.every((x) => typeof x === "number") ? (e.bbox as Bbox) : null;
  }, [config.data]);

  return (
    <section aria-labelledby="pv-titre-territoires" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="pv-titre-territoires" className="flex items-center gap-1 text-base font-semibold text-navy"><FolderTree aria-hidden="true" className="h-4 w-4" />Territoires</h2>
          <p className="text-xs text-gray-700">Une nouvelle ville s&apos;ajoute ici, sans code : région, préfecture, commune, quartier, secteur ou zone (corridor d&apos;un projet linéaire). Un niveau peut être sauté ; le parent, le niveau et le code ne changent plus après la création.</p>
        </div>
        {arbre.isSuccess && !aUneNation && (
          <Button type="button" className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => setCreation({ parent: null })}><Plus aria-hidden="true" /> Créer la nation</Button>
        )}
      </div>
      {annonce && (
        <div role="status" data-testid="annonce-territoire" className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-950">
          <p>{annonce.texte}</p>
          {annonce.avertissements.map((a) => <p key={a.code} className="font-semibold text-amber-900">Avertissement ({a.code}) : {a.message}</p>)}
        </div>
      )}
      <div className="max-w-md">
        <label htmlFor="pv-recherche-territoire" className={LIBELLE_CHAMP}>Rechercher un territoire</label>
        <Input id="pv-recherche-territoire" type="search" value={saisie} onChange={(e) => setSaisie(e.target.value)} maxLength={100} autoComplete="off" className="mt-1 border-gray-300" />
      </div>
      {arbre.isPending && <EtatChargement libelle="Chargement des territoires…" />}
      {arbre.isError && <EtatErreur erreur={classerErreurTerritoires(arbre.error)} sujet="Territoires" onReessayer={() => void arbre.refetch()} enCours={arbre.isFetching} />}
      {arbre.isSuccess && arbre.data.territoires.length === 0 && (
        <EtatVide titre="Aucun territoire">
          <p>Commencez par créer la nation, puis ses régions et leurs subdivisions.</p>
        </EtatVide>
      )}
      {arbre.data?.tronque && <p className="text-xs text-amber-900">L&apos;arborescence compte plus de territoires qu&apos;il n&apos;en est affiché ici : utilisez la recherche.</p>}
      {liste.length > 0 && (
        <ul aria-label="Arborescence des territoires" className="space-y-1">
          {liste.map((t) => (
            <li key={t.id} data-profondeur={t.profondeur} className={`rounded border border-gray-200 p-2 text-sm ${RETRAIT[Math.min(t.profondeur, RETRAIT.length - 1)]}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-gray-900">{t.nom}</span>
                <span className="sr-only">, profondeur {t.profondeur}</span>
                <span className="rounded bg-gray-100 px-1 text-xs text-gray-800">{LIBELLE_NIVEAU[t.niveau]}</span>
                <span className="text-xs text-gray-700">{t.code}</span>
                {!t.actif && <span className="rounded border border-amber-400 bg-amber-50 px-1 text-xs font-semibold text-amber-900">Inactif</span>}
              </div>
              <p className="text-xs text-gray-700">
                Emprise : {t.bbox ? formaterBbox(t.bbox) : "aucune"} · CRS de calcul : {t.crsMetriqueEpsg ? `EPSG:${t.crsMetriqueEpsg} (imposé)` : "règle nationale par bandes"}{t.source ? ` · Source : ${t.source}` : ""}
              </p>
              <div className="mt-1 flex flex-wrap gap-2">
                {niveauxEnfantsPossibles(t.niveau).length > 0 && (
                  <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => setCreation({ parent: t })}>
                    <Plus aria-hidden="true" /> Sous-territoire<span className="sr-only"> de {t.nom}</span>
                  </Button>
                )}
                <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => setEdition(t)}>
                  <PenLine aria-hidden="true" /> Modifier<span className="sr-only"> {t.nom}</span>
                </Button>
                <Button type="button" size="sm" variant="ghost" className="min-h-[44px] text-red-800 xl:min-h-8" disabled={!enLigne} onClick={() => setRetrait(t)}>
                  <Trash2 aria-hidden="true" /> Retirer<span className="sr-only"> {t.nom}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {creation && (
        <DialogueCreation parent={creation.parent} crsAdmis={crsAdmis} empriseNationale={empriseNationale} enLigne={enLigne} onFermer={() => setCreation(null)}
          onCree={(nom, av) => setAnnonce({ texte: `Territoire « ${nom} » créé.`, avertissements: av })} />
      )}
      {edition && (
        <DialogueModification territoire={edition} parent={edition.parentId ? arbre.parId.get(edition.parentId) ?? null : null} crsAdmis={crsAdmis} empriseNationale={empriseNationale} enLigne={enLigne}
          onFermer={() => setEdition(null)} onModifie={(nom, av) => setAnnonce({ texte: `Territoire « ${nom} » modifié.`, avertissements: av })} />
      )}
      {retrait && <DialogueRetrait territoire={retrait} enLigne={enLigne} onFermer={() => setRetrait(null)} onRetire={(nom) => setAnnonce({ texte: `Territoire « ${nom} » retiré (retrait logique, historisé).`, avertissements: [] })} />}
    </section>
  );
}

function ChampsCommuns({ id, v, maj, crsAdmis, desactive }: {
  id: string; v: { nom: string; region: string; crs: string; source: string }; maj: (p: Partial<{ nom: string; region: string; crs: string; source: string }>) => void; crsAdmis: number[]; desactive: boolean;
}) {
  const regions = useRegions(true);
  return (
    <>
      <div>
        <label htmlFor={`${id}-nom`} className={LIBELLE_CHAMP}>Nom</label>
        <Input id={`${id}-nom`} value={v.nom} onChange={(e) => maj({ nom: e.target.value })} maxLength={200} autoComplete="off" disabled={desactive} className="mt-1 border-gray-300" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-region`} className={LIBELLE_CHAMP}>Région administrative (périmètre des comptes)</label>
          <Select id={`${id}-region`} value={v.region} onChange={(e) => maj({ region: e.target.value })} disabled={desactive || regions.isPending} className="mt-1 border-gray-300">
            <option value="">Héritée du parent</option>
            {(regions.data ?? []).map((r) => <option key={r.id} value={String(r.id)}>{r.nom}</option>)}
          </Select>
          {regions.isError && <p role="alert" className="mt-0.5 text-xs text-red-700">Les régions n&apos;ont pas pu être chargées.</p>}
        </div>
        <div>
          <label htmlFor={`${id}-crs`} className={LIBELLE_CHAMP}>Système métrique de calcul</label>
          <Select id={`${id}-crs`} value={v.crs} onChange={(e) => maj({ crs: e.target.value })} disabled={desactive} className="mt-1 border-gray-300">
            <option value="">Règle nationale par bandes de longitude</option>
            {crsAdmis.map((e) => <option key={e} value={String(e)}>EPSG:{e}</option>)}
            {v.crs && !crsAdmis.includes(Number(v.crs)) && <option value={v.crs}>EPSG:{v.crs} (hors de la liste blanche)</option>}
          </Select>
          <p className="mt-0.5 text-xs text-gray-700">Liste blanche de la configuration nationale (systèmes projetés).</p>
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-source`} className={LIBELLE_CHAMP}>Source (facultatif)</label>
        <Input id={`${id}-source`} value={v.source} onChange={(e) => maj({ source: e.target.value })} maxLength={500} autoComplete="off" disabled={desactive} placeholder="Provenance de l'emprise, par exemple « relevé approximatif »" className="mt-1 border-gray-300" />
      </div>
    </>
  );
}

function DialogueCreation({ parent, crsAdmis, empriseNationale, enLigne, onFermer, onCree }: {
  parent: Territoire | null; crsAdmis: number[]; empriseNationale: Bbox | null; enLigne: boolean; onFermer: () => void; onCree: (nom: string, av: AvertissementTerritoire[]) => void;
}) {
  const id = useId();
  const creer = useCreerTerritoire();
  const niveaux = niveauxEnfantsPossibles(parent?.niveau ?? null);
  const [v, setV] = useState({ code: "", nom: "", niveau: niveaux[0] as NiveauTerritoire, region: "", crs: "", source: "" });
  const [emprise, setEmprise] = useState<SaisieEmprise>(SAISIE_EMPRISE_VIDE);
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurTerritoires);
  const maj = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));
  const e = empriseDepuisSaisie(emprise);
  const code = v.code.trim().toUpperCase();
  const erreurs = [
    ...(!MOTIF_CODE.test(code) ? ["Code : 2 à 64 caractères, majuscules, chiffres, tiret ou souligné (il ne changera plus)."] : []),
    ...(!v.nom.trim() ? ["Saisissez le nom du territoire."] : []),
    ...(e.erreur ? [e.erreur] : []),
  ];
  function valider() {
    const corps: CorpsTerritoire = {
      code, nom: v.nom.trim(), niveau: v.niveau, ...(parent ? { parentId: parent.id } : {}),
      ...(v.region ? { regionId: Number(v.region) } : {}), ...(v.crs ? { crsMetriqueEpsg: Number(v.crs) } : {}),
      ...(e.valeur ? { emprise: e.valeur } : {}), ...(v.source.trim() ? { source: v.source.trim() } : {}),
    };
    void envoyer(async () => { const r = await creer.mutateAsync(corps); onCree(r.territoire.nom, r.avertissements); });
  }
  return (
    <CadreDialogue
      titre={parent ? `Nouveau territoire sous « ${parent.nom} »` : "Créer la nation"}
      description={<p>Le parent, le niveau et le code sont définitifs. La création est consignée (audit, historique).</p>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Créer le territoire" libelleEnCours="Création…"
      onFermer={onFermer} onValider={valider} enLigne={enLigne} large
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-code`} className={LIBELLE_CHAMP}>Code</label>
          <Input id={`${id}-code`} value={v.code} onChange={(ev) => maj({ code: ev.target.value })} maxLength={64} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300 uppercase" />
        </div>
        <div>
          <label htmlFor={`${id}-niveau`} className={LIBELLE_CHAMP}>Niveau</label>
          <Select id={`${id}-niveau`} value={v.niveau} onChange={(ev) => maj({ niveau: ev.target.value as NiveauTerritoire })} disabled={enCours || niveaux.length === 1} className="mt-1 border-gray-300">
            {niveaux.map((n) => <option key={n} value={n}>{LIBELLE_NIVEAU[n]}</option>)}
          </Select>
        </div>
      </div>
      <ChampsCommuns id={id} v={v} maj={maj} crsAdmis={crsAdmis} desactive={enCours} />
      <EditeurEmprise saisie={emprise} onChange={setEmprise} modification={false} actuelle={null} bboxActuelle={null} parent={parent?.bbox ?? null} cadrage={empriseNationale} desactive={enCours} />
    </CadreDialogue>
  );
}

function DialogueModification({ territoire: t, parent, crsAdmis, empriseNationale, enLigne, onFermer, onModifie }: {
  territoire: Territoire; parent: Territoire | null; crsAdmis: number[]; empriseNationale: Bbox | null; enLigne: boolean; onFermer: () => void; onModifie: (nom: string, av: AvertissementTerritoire[]) => void;
}) {
  const id = useId();
  const fiche = useFicheTerritoire(t.id);
  const modifier = useModifierTerritoire();
  const [v, setV] = useState({ nom: t.nom, region: t.regionId ? String(t.regionId) : "", crs: t.crsMetriqueEpsg ? String(t.crsMetriqueEpsg) : "", source: t.source ?? "", actif: t.actif });
  const [emprise, setEmprise] = useState<SaisieEmprise>({ ...SAISIE_EMPRISE_VIDE, mode: "conserver" });
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurTerritoires);
  const maj = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));
  const e = empriseDepuisSaisie(emprise);
  const corps: CorpsModifTerritoire = {
    ...(v.nom.trim() !== t.nom ? { nom: v.nom.trim() } : {}),
    ...((v.region ? Number(v.region) : null) !== t.regionId ? { regionId: v.region ? Number(v.region) : null } : {}),
    ...((v.crs ? Number(v.crs) : null) !== t.crsMetriqueEpsg ? { crsMetriqueEpsg: v.crs ? Number(v.crs) : null } : {}),
    ...((v.source.trim() || null) !== t.source ? { source: v.source.trim() || null } : {}),
    ...(v.actif !== t.actif ? { actif: v.actif } : {}),
    ...(e.valeur !== undefined && !(e.valeur === null && !t.bbox) ? { emprise: e.valeur } : {}),
  };
  const erreurs = [...(!v.nom.trim() ? ["Le nom ne peut pas être vide."] : []), ...(e.erreur ? [e.erreur] : []), ...(Object.keys(corps).length === 0 ? ["Aucune modification à enregistrer."] : [])];
  return (
    <CadreDialogue
      titre={`Modifier « ${t.nom} »`}
      description={<p>{LIBELLE_NIVEAU[t.niveau]}, code {t.code} (définitifs). Désactiver un territoire le garde lisible sur ses projets ; il n&apos;est plus proposé à la création d&apos;un projet.</p>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Enregistrer" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(async () => { const r = await modifier.mutateAsync({ tid: t.id, corps }); onModifie(r.territoire.nom, r.avertissements); })} enLigne={enLigne} large
    >
      <ChampsCommuns id={id} v={v} maj={maj} crsAdmis={crsAdmis} desactive={enCours} />
      {(v.region ? Number(v.region) : null) !== t.regionId && (
        <p role="note" data-testid="avertissement-region" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">
          Changer la région administrative modifie le périmètre de ce territoire et de ses subdivisions, mais les projets déjà rattachés à ce territoire et à ses subdivisions gardent leur région actuelle : vérifiez-les avec la liste des projets filtrée par ce territoire.
        </p>
      )}
      <label className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0">
        <input type="checkbox" className="h-4 w-4" checked={v.actif} disabled={enCours} onChange={(ev) => maj({ actif: ev.target.checked })} />Territoire actif (proposé à la création d&apos;un projet)
      </label>
      {fiche.isError && <p role="alert" className="text-xs text-red-700">L&apos;emprise actuelle n&apos;a pas pu être lue : {classerErreurTerritoires(fiche.error).message}</p>}
      <EditeurEmprise saisie={emprise} onChange={setEmprise} modification actuelle={fiche.data?.emprise ?? null} bboxActuelle={t.bbox} parent={parent?.bbox ?? null} cadrage={empriseNationale} desactive={enCours} />
    </CadreDialogue>
  );
}

function DialogueRetrait({ territoire: t, enLigne, onFermer, onRetire }: { territoire: Territoire; enLigne: boolean; onFermer: () => void; onRetire: (nom: string) => void }) {
  const retirer = useRetirerTerritoire();
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurTerritoires);
  return (
    <CadreDialogue
      titre={`Retirer « ${t.nom} » ?`}
      description={<>
        <p>Retrait logique : le territoire reste en base et dans l&apos;historique, mais n&apos;est plus visible ni proposé. Rien n&apos;est supprimé physiquement.</p>
        <p>Le serveur refuse le retrait d&apos;un territoire qui porte encore des sous-territoires ou des projets : désactivez-le plutôt (bouton Modifier).</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider libelleValider="Retirer le territoire" libelleEnCours="Retrait…"
      onFermer={onFermer} onValider={() => void envoyer(async () => { await retirer.mutateAsync(t.id); onRetire(t.nom); })} enLigne={enLigne}
    >
      <span className="sr-only">Confirmation du retrait</span>
    </CadreDialogue>
  );
}
