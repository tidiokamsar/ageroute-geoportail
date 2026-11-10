/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useId, useMemo, useState } from "react";
import { CadreDialogue, CHAMP_TEXTE, Compteur, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { Input, Select } from "../../ui/Input";
import { BadgeStatutRelation } from "./BadgesReseau";
import { useObjetsReseau } from "../../../lib/projetsVoirieReseauxHooks";
import type { CorpsRelation, ObjetReseau, RelationReseau } from "../../../lib/projetsVoirieReseauxApi";
import {
  AIDE_NATURE_COURTE, EFFET_ACTION_RELATION, LIBELLE_ACTION_RELATION, LIBELLE_CONFIANCE, LIBELLE_NATURE_COURT, LIBELLE_ORIGINE_VALEUR, LIBELLE_STATUT_QUALITE, LIBELLE_TYPE_RELATION_COURT,
  LIBELLE_PREUVE, MENTION_CONNEXION, NIVEAUX_CONFIANCE, PREUVES_CONNEXION, SAISIE_DESCRIPTEUR_VIDE, STATUTS_QUALITE, TYPES_OBJET_PAR_NATURE, VERBE_ACTION_RELATION, classeDeclarable, classerErreurReseau, corpsDescripteur,
  erreursDescripteur, libelleTypeObjet, naturesCompatibles, natureQuiSAppliquera, texteMetres, texteNombre, FILTRES_OBJETS_VIDES,
  type ActionRelation, type CorpsDescripteur, type NatureDeclarable, type NiveauConfiance, type PreuveConnexion, type SaisieDescripteur, type StatutQualite, type TypeRelation,
} from "../../../lib/projetsVoirieReseaux";
import { AIDE_CLASSE } from "../../../lib/projetsVoirie";
import { justificationValide } from "../../../lib/projetsVoirieConflits";

/**
 * Dialogues d'ecriture des reseaux : declaration du descripteur d'un objet, valider / refuser / revoquer une relation, declarer une relation a la main.
 * Aucune action n'ordonne ni ne deplace quoi que ce soit : ce sont des qualifications humaines, justifiees et consignees.
 */

function saisieDepuis(o: ObjetReseau): SaisieDescripteur {
  // Sans descripteur, tout ce que l'objet affiche vient du jeu : rien n'est repris, aucune valeur n'est declaree a la place de l'utilisateur.
  if (!o.descripteur) return { ...SAISIE_DESCRIPTEUR_VIDE };
  const nat = o.origineNature === "OBJET" && (["ACTIF_PHYSIQUE", "CIRCUIT_LOGIQUE", "EQUIPEMENT"] as string[]).includes(o.nature) ? (o.nature as NatureDeclarable) : "";
  return {
    nature: nat, typeObjet: o.typeObjet ?? "", classePrecision: o.qualite.origineClasse === "OBJET" ? classeDeclarable(o.qualite.classePrecision) : "",
    precisionHorizontaleM: texteNombre(o.qualite.precisionHorizontaleM), precisionVerticaleM: texteNombre(o.qualite.precisionVerticaleM),
    methodeCollecte: o.qualite.methodeCollecte ?? "", dateConstat: o.qualite.dateConstat?.slice(0, 10) ?? "", niveauConfiance: o.qualite.niveauConfiance ?? "",
    statutQualite: o.qualite.statutQualite ?? "INCONNU", profondeurM: texteNombre(o.vertical.profondeurM), altitudeM: texteNombre(o.vertical.altitudeM),
    referenceVerticale: o.vertical.referenceVerticale ?? "", justification: "",
  };
}

export function DialogueDescripteur({ objet, enLigne, onFermer, onValider }: {
  objet: ObjetReseau; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsDescripteur) => Promise<unknown>;
}) {
  const id = useId();
  const [s, setS] = useState<SaisieDescripteur>(() => saisieDepuis(objet));
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurReseau);
  const maj = (p: Partial<SaisieDescripteur>) => setS((x) => ({ ...x, ...p }));
  const natureJeu = objet.origineNature === "JEU" ? objet.nature : "INCONNUE";
  const erreurs = erreursDescripteur(s, { typeGeom: objet.typeGeom, natureHeritee: natureJeu });
  const nat = natureQuiSAppliquera(s, natureJeu);
  const types = nat ? TYPES_OBJET_PAR_NATURE[nat] : [];
  const editionExistante = objet.descripteur !== null;
  const champ = (cle: keyof SaisieDescripteur, libelle: string, extra?: { aide?: string; inputMode?: "decimal" | "text"; type?: string; max?: number }) => (
    <div>
      <label htmlFor={`${id}-${cle}`} className={LIBELLE_CHAMP}>{libelle}</label>
      <Input id={`${id}-${cle}`} type={extra?.type ?? "text"} inputMode={extra?.inputMode} value={s[cle]} maxLength={extra?.max ?? 200} autoComplete="off" disabled={enCours}
        onChange={(e) => maj({ [cle]: e.target.value } as Partial<SaisieDescripteur>)} aria-describedby={extra?.aide ? `${id}-${cle}-aide` : undefined} className="mt-1 border-gray-300" />
      {extra?.aide && <p id={`${id}-${cle}-aide`} className="mt-0.5 text-xs text-gray-700">{extra.aide}</p>}
    </div>
  );

  return (
    <CadreDialogue
      titre={editionExistante ? "Modifier le descripteur de l'objet" : "Qualifier l'objet"} large
      description={<>
        <p><strong>{objet.nom ?? "Objet sans nom"}</strong> · {LIBELLE_NATURE_COURT[objet.nature]} {objet.origineNature === "JEU" ? "(héritée du jeu)" : ""}</p>
        <p>Le descripteur précise l&apos;objet importé, qui reste inchangé. Il est <strong>remplacé</strong> à chaque enregistrement : une valeur laissée vide devient inconnue, elle n&apos;est ni héritée du jeu ni déduite. Une justification est obligatoire ; l&apos;ancienne valeur reste dans l&apos;audit.</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Enregistrer le descripteur" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider(corpsDescripteur(s)))} enLigne={enLigne}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-nature`} className={LIBELLE_CHAMP}>Nature</label>
          <Select id={`${id}-nature`} value={s.nature} disabled={enCours} onChange={(e) => maj({ nature: e.target.value as NatureDeclarable | "", typeObjet: "" })} aria-describedby={`${id}-nature-aide`} className="mt-1 border-gray-300">
            <option value="">{natureJeu === "INCONNUE" ? "Nature inconnue (non déclarée)" : `Nature du jeu : ${LIBELLE_NATURE_COURT[natureJeu]}`}</option>
            {naturesCompatibles(objet.typeGeom).map((n) => <option key={n} value={n}>{LIBELLE_NATURE_COURT[n]}</option>)}
          </Select>
          <p id={`${id}-nature-aide`} className="mt-0.5 text-xs text-gray-700">{nat ? AIDE_NATURE_COURTE[nat] : AIDE_NATURE_COURTE.INCONNUE}</p>
        </div>
        <div>
          <label htmlFor={`${id}-type`} className={LIBELLE_CHAMP}>Type d&apos;objet</label>
          <Select id={`${id}-type`} value={s.typeObjet} disabled={enCours || !nat} onChange={(e) => maj({ typeObjet: e.target.value })} aria-describedby={`${id}-type-aide`} className="mt-1 border-gray-300">
            <option value="">Type non renseigné</option>
            {types.map((t) => <option key={t} value={t}>{libelleTypeObjet(t)}</option>)}
          </Select>
          <p id={`${id}-type-aide`} className="mt-0.5 text-xs text-gray-700">{nat ? "Facultatif : un type inconnu est admis." : "Un type exige une nature connue : déclarez d'abord la nature."}</p>
        </div>
        <div>
          <label htmlFor={`${id}-classe`} className={LIBELLE_CHAMP}>Classe de précision</label>
          <Select id={`${id}-classe`} value={s.classePrecision} disabled={enCours} onChange={(e) => maj({ classePrecision: e.target.value as SaisieDescripteur["classePrecision"] })} aria-describedby={`${id}-classe-aide`} className="mt-1 border-gray-300">
            <option value="">Classe non renseignée</option>
            {(["A", "B", "C", "D", "E"] as const).map((c) => <option key={c} value={c}>{AIDE_CLASSE[c]}</option>)}
          </Select>
          <p id={`${id}-classe-aide`} className="mt-0.5 text-xs text-gray-700">
            {objet.qualite.origineClasse === "JEU" && objet.qualite.classePrecision ? `Le jeu indique la classe ${objet.qualite.classePrecision} : elle n'est pas reprise automatiquement ; choisissez-la ici pour la déclarer pour cet objet. ` : ""}
            Déclarée, jamais déduite. La classe E n&apos;entre jamais dans une association automatique.
          </p>
        </div>
        <div>
          <label htmlFor={`${id}-confiance`} className={LIBELLE_CHAMP}>Niveau de confiance</label>
          <Select id={`${id}-confiance`} value={s.niveauConfiance} disabled={enCours} onChange={(e) => maj({ niveauConfiance: e.target.value as NiveauConfiance | "" })} className="mt-1 border-gray-300">
            <option value="">Non renseigné</option>
            {NIVEAUX_CONFIANCE.map((n) => <option key={n} value={n}>{LIBELLE_CONFIANCE[n]}</option>)}
          </Select>
        </div>
        {champ("precisionHorizontaleM", "Précision horizontale (m)", { inputMode: "decimal", max: 12, aide: "Strictement positive. Vide : inconnue." })}
        {champ("precisionVerticaleM", "Précision verticale (m)", { inputMode: "decimal", max: 12, aide: "Vide : inconnue." })}
        {champ("methodeCollecte", "Méthode de collecte", { max: 200 })}
        {champ("dateConstat", "Date du constat", { type: "date", max: 10 })}
        <div>
          <label htmlFor={`${id}-qualite`} className={LIBELLE_CHAMP}>Statut de la qualité</label>
          <Select id={`${id}-qualite`} value={s.statutQualite} disabled={enCours} onChange={(e) => maj({ statutQualite: e.target.value as StatutQualite })} className="mt-1 border-gray-300">
            {STATUTS_QUALITE.map((q) => <option key={q} value={q}>{LIBELLE_STATUT_QUALITE[q]}</option>)}
          </Select>
        </div>
      </div>

      <fieldset className="grid gap-3 rounded-md border border-gray-300 p-3 sm:grid-cols-2">
        <legend className="px-1 text-sm font-semibold text-navy">Vertical (seulement si la source le fournit)</legend>
        <p className="text-xs text-gray-800 sm:col-span-2">Profondeur et altitude restent vides tant qu&apos;elles ne sont pas fournies. Même renseignées, l&apos;application ne conclut à aucun conflit en trois dimensions.</p>
        {champ("profondeurM", "Profondeur (m, positive vers le bas)", { inputMode: "decimal", max: 10 })}
        {champ("altitudeM", "Altitude (m)", { inputMode: "decimal", max: 10 })}
        <div className="sm:col-span-2">{champ("referenceVerticale", "Référence verticale (par exemple « terrain naturel »)", { max: 120, aide: "Une profondeur ou une altitude sans référence est dite incomplète : elle ne se compare à rien." })}</div>
      </fieldset>

      {objet.qualite.origineClasse === "JEU" || objet.origineNature === "JEU" ? (
        <p className="text-xs text-gray-700">Valeurs actuellement héritées du jeu : nature {LIBELLE_ORIGINE_VALEUR[objet.origineNature].toLowerCase()}, classe {LIBELLE_ORIGINE_VALEUR[objet.qualite.origineClasse].toLowerCase()}. Précision horizontale en vigueur : {texteMetres(objet.qualite.precisionHorizontaleM)}.</p>
      ) : null}

      <div>
        <label htmlFor={`${id}-j`} className={LIBELLE_CHAMP}>Justification (10 caractères minimum)</label>
        <textarea id={`${id}-j`} value={s.justification} onChange={(e) => maj({ justification: e.target.value })} rows={3} maxLength={2000} disabled={enCours} aria-describedby={`${id}-jn`} className={CHAMP_TEXTE} />
        <Compteur id={`${id}-jn`} texte={s.justification} />
      </div>
    </CadreDialogue>
  );
}

// ---------------------------------------------------------------------------------------------------
// Valider, refuser, revoquer
// ---------------------------------------------------------------------------------------------------

export function DialogueRelationAction({ relation, action, enLigne, onFermer, onValider }: {
  relation: RelationReseau; action: ActionRelation; enLigne: boolean; onFermer: () => void; onValider: (justification: string) => Promise<unknown>;
}) {
  const id = useId();
  const [j, setJ] = useState("");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurReseau);
  return (
    <CadreDialogue
      titre={LIBELLE_ACTION_RELATION[action]}
      description={<>
        <p className="flex flex-wrap items-center gap-1"><BadgeStatutRelation statut={relation.statut} /> {libelleRelation(relation)}</p>
        <p>{EFFET_ACTION_RELATION[action]}</p>
        {relation.proposition && action === "valider" && <p>Cette relation est une proposition automatique de superposition géométrique : elle ne prouve pas à elle seule que le circuit suit l&apos;infrastructure.</p>}
      </>}
      enCours={enCours} erreur={erreur} peutValider={justificationValide(j)} libelleValider={`${VERBE_ACTION_RELATION[action]} la relation`} libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => void envoyer(() => onValider(j.trim()))} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-j`} className={LIBELLE_CHAMP}>Justification (10 caractères minimum)</label>
        <textarea id={`${id}-j`} value={j} onChange={(e) => setJ(e.target.value)} rows={3} maxLength={2000} disabled={enCours} aria-describedby={`${id}-jn`} className={CHAMP_TEXTE} />
        <Compteur id={`${id}-jn`} texte={j} />
      </div>
    </CadreDialogue>
  );
}

export const libelleRelation = (r: Pick<RelationReseau, "typeRelation" | "source" | "cible">): string =>
  `${r.source?.nom ?? "Objet sans nom"} · ${LIBELLE_TYPE_RELATION_COURT[r.typeRelation].toLowerCase()} · ${r.cible?.nom ?? "objet sans nom"}`;

// ---------------------------------------------------------------------------------------------------
// Declaration manuelle
// ---------------------------------------------------------------------------------------------------

type SensRelation = { type: TypeRelation; objetOuvertEstSource: boolean; natureCherchee: NatureDeclarable; phrase: string };

/**
 * Les sens possibles d'une relation depuis un objet donne : un circuit est porte par une infrastructure, un equipement est contenu dans une
 * infrastructure ; lot S1 : deux objets PHYSIQUES (infrastructure ou equipement) peuvent etre DECLARES connectes. L'autre objet se cherche par
 * son NOM, jamais par proximite : aucune connexion n'est proposee d'apres la geometrie.
 */
export function sensPossibles(o: Pick<ObjetReseau, "nature">): SensRelation[] {
  const connexions = (pronom: string): SensRelation[] => [
    { type: "CONNECTE_A", objetOuvertEstSource: true, natureCherchee: "ACTIF_PHYSIQUE", phrase: `${pronom} est déclaré connecté à l'infrastructure physique suivante` },
    { type: "CONNECTE_A", objetOuvertEstSource: true, natureCherchee: "EQUIPEMENT", phrase: `${pronom} est déclaré connecté à l'équipement suivant` },
  ];
  if (o.nature === "CIRCUIT_LOGIQUE") return [{ type: "PORTE_PAR", objetOuvertEstSource: true, natureCherchee: "ACTIF_PHYSIQUE", phrase: "Ce circuit est porté par l'infrastructure physique suivante" }];
  if (o.nature === "EQUIPEMENT") return [
    { type: "CONTENU_DANS", objetOuvertEstSource: true, natureCherchee: "ACTIF_PHYSIQUE", phrase: "Cet équipement est contenu dans l'infrastructure suivante (chambre, regard)" },
    ...connexions("Cet équipement"),
  ];
  if (o.nature === "ACTIF_PHYSIQUE") return [
    { type: "PORTE_PAR", objetOuvertEstSource: false, natureCherchee: "CIRCUIT_LOGIQUE", phrase: "Le circuit logique suivant est porté par cette infrastructure" },
    { type: "CONTENU_DANS", objetOuvertEstSource: false, natureCherchee: "EQUIPEMENT", phrase: "L'équipement suivant est contenu dans cette infrastructure" },
    ...connexions("Cette infrastructure"),
  ];
  return [];
}

export function DialogueNouvelleRelation({ projetId, objet, enLigne, onFermer, onValider }: {
  projetId: string; objet: ObjetReseau; enLigne: boolean; onFermer: () => void; onValider: (c: CorpsRelation) => Promise<unknown>;
}) {
  const id = useId();
  const sens = useMemo(() => sensPossibles(objet), [objet]);
  const [i, setI] = useState(0);
  const [q, setQ] = useState("");
  const [choix, setChoix] = useState<string | null>(null);
  const [j, setJ] = useState("");
  // Lot S1 : preuve d'une connexion declaree ; « inconnue » par defaut (recommandation du contrat) : on n'affirme pas une confirmation du fournisseur sans elle.
  const [preuve, setPreuve] = useState<PreuveConnexion>("INCONNUE");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurReseau);
  const s = sens[i];
  const filtres = useMemo(() => ({ ...FILTRES_OBJETS_VIDES, nature: s?.natureCherchee ?? ("" as const), q }), [s, q]);
  const candidats = useObjetsReseau(projetId, filtres, !!s);
  const liste = (candidats.data?.pages[0]?.objets ?? []).filter((o) => o.id !== objet.id);
  const aSuite = candidats.data?.pages[0]?.suivant != null;
  const peutValider = !!s && choix !== null && justificationValide(j);

  function valider() {
    if (!s || choix === null) return;
    void envoyer(() => onValider({
      type: s.type, sourceObjetId: s.objetOuvertEstSource ? objet.id : choix, cibleObjetId: s.objetOuvertEstSource ? choix : objet.id, justification: j.trim(),
      ...(s.type === "CONNECTE_A" ? { preuve } : {}),
    }));
  }

  return (
    <CadreDialogue
      titre="Déclarer une relation"
      description={<>
        <p><strong>{objet.nom ?? "Objet sans nom"}</strong> · {LIBELLE_NATURE_COURT[objet.nature]}</p>
        <p>Vous affirmez une relation : elle est créée <strong>validée</strong>, avec votre nom et votre justification. Une relation déjà proposée, refusée ou révoquée pour ce couple ne se contourne pas : retrouvez-la dans la liste des relations.</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider={peutValider} libelleValider="Déclarer la relation" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={valider} enLigne={enLigne} large
    >
      {sens.length > 1 && (
        <fieldset className="space-y-1">
          <legend className={LIBELLE_CHAMP}>Sens de la relation</legend>
          {sens.map((x, k) => (
            <label key={x.phrase} className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0">
              <input type="radio" name={`${id}-sens`} className="h-4 w-4" checked={i === k} disabled={enCours} onChange={() => { setI(k); setChoix(null); }} />{x.phrase}
            </label>
          ))}
        </fieldset>
      )}
      {s && sens.length === 1 && <p className="text-sm font-medium text-gray-900">{s.phrase} :</p>}
      <div>
        <label htmlFor={`${id}-q`} className={LIBELLE_CHAMP}>Rechercher l&apos;autre objet par son nom ({LIBELLE_NATURE_COURT[s?.natureCherchee ?? "ACTIF_PHYSIQUE"].toLowerCase()})</label>
        <Input id={`${id}-q`} type="search" value={q} onChange={(e) => { setQ(e.target.value); setChoix(null); }} maxLength={100} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
      </div>
      {candidats.isPending && <p role="status" className="text-xs text-gray-700">Recherche en cours…</p>}
      {candidats.isError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-900">{classerErreurReseau(candidats.error).message}</p>}
      {candidats.isSuccess && (
        <fieldset className="min-w-0 space-y-1 rounded border border-gray-300 p-2">
          <legend className="px-1 text-xs font-medium text-gray-800">{liste.length === 0 ? "Aucun objet de cette nature ne correspond" : `Objets proposés (${liste.length})`}</legend>
          <div role="region" aria-label="Objets proposés, liste défilante" tabIndex={0} className="max-h-56 space-y-1 overflow-auto">
          {liste.map((o) => (
            <label key={o.id} className="flex min-h-[44px] items-start gap-2 rounded p-1 text-sm text-gray-900 hover:bg-gray-50 xl:min-h-0">
              <input type="radio" name={`${id}-cible`} className="mt-1 h-4 w-4 shrink-0" checked={choix === o.id} disabled={enCours} onChange={() => setChoix(o.id)} />
              <span className="min-w-0 break-words">{o.nom ?? "Objet sans nom"} <span className="text-xs text-gray-700">({libelleTypeObjet(o.typeObjet)}{o.source?.nomFichier ? `, ${o.source.nomFichier}` : ""})</span></span>
            </label>
          ))}
          </div>
          {aSuite && <p className="text-xs text-gray-700">D&apos;autres objets existent : affinez la recherche pour retrouver le vôtre.</p>}
        </fieldset>
      )}
      {s?.type === "CONNECTE_A" && (
        <fieldset className="space-y-1 rounded border border-gray-300 p-2" aria-describedby={`${id}-preuve-aide`}>
          <legend className="px-1 text-sm font-medium text-gray-900">Preuve de la connexion (obligatoire)</legend>
          <p id={`${id}-preuve-aide`} className="text-xs text-gray-700">{MENTION_CONNEXION} Ne choisissez « confirmée par le fournisseur » que si un document ou un fichier du concessionnaire l&apos;atteste.</p>
          {PREUVES_CONNEXION.map((p) => (
            <label key={p} className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0">
              <input type="radio" name={`${id}-preuve`} className="h-4 w-4" checked={preuve === p} disabled={enCours} onChange={() => setPreuve(p)} />{LIBELLE_PREUVE[p]}
            </label>
          ))}
        </fieldset>
      )}
      <div>
        <label htmlFor={`${id}-j`} className={LIBELLE_CHAMP}>Justification (10 caractères minimum)</label>
        <textarea id={`${id}-j`} value={j} onChange={(e) => setJ(e.target.value)} rows={3} maxLength={2000} disabled={enCours} aria-describedby={`${id}-jn`} className={CHAMP_TEXTE} />
        <Compteur id={`${id}-jn`} texte={j} />
      </div>
    </CadreDialogue>
  );
}

