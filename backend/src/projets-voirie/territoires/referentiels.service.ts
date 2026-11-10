/**
 * REFERENTIELS CONFIGURABLES : lecture par domaine, creation, modification (version +1), retrait logique, historique en ajout seul, audit ;
 * resolution du type de reseau d'un jeu ou d'un concessionnaire (code du referentiel => famille, repli sur la famille declaree).
 * Contrat : docs/projets-voirie/CONTRAT-TERRITOIRES.md, sections 3.2 et 5. Regles pures : referentiels.noyau.ts.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditTransactionnelle } from "../../utils/audit";
import { FORME_METHODE_ACQUISITION } from "../config";
import { ErreurMetier, introuvable } from "../erreurs";
import type { Acteur } from "../projets.service";
import { CODE_REFERENTIEL, DOMAINES, estDomaine, familleEffective, prochaineVersion, validerParametres, type Domaine, type FamilleReseau } from "./referentiels.noyau";
import { instantaneReferentiel, vueReferentiel } from "./vues";

const INCLURE = { approuvePar: { select: { id: true, nomComplet: true } } } as const;
type Tx = Prisma.TransactionClient;

function domaineOuErreur(d: string): Domaine {
  if (!estDomaine(d)) throw new ErreurMetier(404, "DOMAINE_INCONNU", `Domaine de référentiel inconnu : ${DOMAINES.join(", ")} attendus.`);
  return d;
}

export async function listerDomaines() {
  const lignes = await prisma.referentielVoirie.groupBy({ by: ["domaine", "actif"], where: { deletedAt: null }, _count: { _all: true } });
  return {
    domaines: DOMAINES.map((domaine) => ({
      domaine,
      nb: lignes.filter((l) => l.domaine === domaine).reduce((s, l) => s + l._count._all, 0),
      nbActifs: lignes.filter((l) => l.domaine === domaine && l.actif).reduce((s, l) => s + l._count._all, 0),
    })),
  };
}

export async function listerValeurs(domaineBrut: string, tous: boolean) {
  const domaine = domaineOuErreur(domaineBrut);
  const valeurs = await prisma.referentielVoirie.findMany({
    where: { domaine, deletedAt: null, ...(tous ? {} : { actif: true }) }, include: INCLURE, orderBy: [{ ordre: "asc" }, { libelle: "asc" }, { code: "asc" }],
  });
  return { domaine, valeurs: valeurs.map(vueReferentiel) };
}

export async function lireValeur(domaineBrut: string, code: string) {
  const domaine = domaineOuErreur(domaineBrut);
  const v = await prisma.referentielVoirie.findFirst({ where: { domaine, code, deletedAt: null }, include: INCLURE });
  if (!v) throw introuvable("Valeur de référentiel", "VALEUR_INTROUVABLE");
  return { valeur: vueReferentiel(v) };
}

export interface CreationValeur { code: string; libelle: string; ordre?: number; actif?: boolean; parametres?: unknown }

export async function creerValeur(acteur: Acteur, domaineBrut: string, d: CreationValeur) {
  const domaine = domaineOuErreur(domaineBrut);
  const code = d.code.trim().toUpperCase();
  if (!CODE_REFERENTIEL.test(code)) throw new ErreurMetier(400, "CHAMPS_INVALIDES", "Code : lettres majuscules, chiffres, tirets et soulignés, 2 à 64 caractères.");
  // Correctifs T1+S1 (M2) : un code de methode d'acquisition doit tenir dans la colonne des jeux (forme imposee par la base : sans tiret, 40 caracteres au plus).
  if (domaine === "METHODE_ACQUISITION" && !FORME_METHODE_ACQUISITION.test(code)) {
    throw new ErreurMetier(400, "CHAMPS_INVALIDES", "Code de méthode d'acquisition : une lettre majuscule puis majuscules, chiffres et soulignés, 2 à 40 caractères.");
  }
  const p = validerParametres(domaine, d.parametres);
  if (!p.ok) throw new ErreurMetier(400, "PARAMETRES_INVALIDES", `Paramètres invalides pour le domaine ${domaine}.`, { details: p.erreurs });
  try {
    return await prisma.$transaction(async (tx) => {
      const maintenant = new Date();
      const v = await tx.referentielVoirie.create({
        data: { domaine, code, libelle: d.libelle.trim(), ordre: d.ordre ?? 0, actif: d.actif ?? true, parametres: p.parametres as object, version: 1, approuveParId: acteur.id, approuveLe: maintenant, creeParId: acteur.id },
        include: INCLURE,
      });
      await tx.referentielVoirieHistorique.create({ data: { referentielId: v.id, action: "CREATION", version: 1, apres: instantaneReferentiel(v) as object, acteurId: acteur.id } });
      await logAuditTransactionnelle(tx, { userId: acteur.id, action: "CREATE", entityType: "ReferentielVoirie", entityId: v.id, after: instantaneReferentiel(v), ipAddress: acteur.ip });
      return { valeur: vueReferentiel(v) };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ErreurMetier(409, "CODE_DEJA_UTILISE", `Le code « ${code} » existe déjà dans le domaine ${domaine} (y compris retiré).`);
    throw e;
  }
}

export interface ModifValeur { libelle?: string; ordre?: number; actif?: boolean; parametres?: unknown }

export async function modifierValeur(acteur: Acteur, domaineBrut: string, code: string, m: ModifValeur) {
  const domaine = domaineOuErreur(domaineBrut);
  return prisma.$transaction(async (tx) => {
    const avant = await tx.referentielVoirie.findFirst({ where: { domaine, code, deletedAt: null }, include: INCLURE });
    if (!avant) throw introuvable("Valeur de référentiel", "VALEUR_INTROUVABLE");
    let parametres = avant.parametres;
    if (m.parametres !== undefined) {
      const p = validerParametres(domaine, m.parametres);
      if (!p.ok) throw new ErreurMetier(400, "PARAMETRES_INVALIDES", `Paramètres invalides pour le domaine ${domaine}.`, { details: p.erreurs });
      parametres = p.parametres as Prisma.JsonValue;
      // Correctifs T1+S1 (m7) : la famille d'un type de reseau porte par un jeu ou un concessionnaire ne change plus (les jeux existants garderaient
      // l'ancienne famille, les nouveaux depots la nouvelle : un meme code porterait deux familles). Creez un nouveau code.
      const familleAvant = (avant.parametres as { famille?: unknown } | null)?.famille;
      const familleApres = (parametres as { famille?: unknown } | null)?.famille;
      if (domaine === "TYPE_RESEAU" && familleAvant !== familleApres) {
        const usages = await usagesDuCode(tx, domaine, code);
        const total = Object.values(usages).reduce((s, n) => s + n, 0);
        if (total > 0) throw new ErreurMetier(409, "FAMILLE_FIGEE", `La famille du type « ${code} » est portée par ${total} objet(s) : elle ne change plus (créez un nouveau code de type).`, { usages });
      }
    }
    const version = prochaineVersion(avant.version);
    const maintenant = new Date();
    const apres = await tx.referentielVoirie.update({
      where: { id: avant.id },
      data: {
        ...(m.libelle !== undefined ? { libelle: m.libelle.trim() } : {}), ...(m.ordre !== undefined ? { ordre: m.ordre } : {}), ...(m.actif !== undefined ? { actif: m.actif } : {}),
        parametres: parametres as object, version, approuveParId: acteur.id, approuveLe: maintenant,
      },
      include: INCLURE,
    });
    await tx.referentielVoirieHistorique.create({ data: { referentielId: avant.id, action: "MODIFICATION", version, avant: instantaneReferentiel(avant) as object, apres: instantaneReferentiel(apres) as object, acteurId: acteur.id } });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "UPDATE", entityType: "ReferentielVoirie", entityId: avant.id, before: instantaneReferentiel(avant), after: instantaneReferentiel(apres), ipAddress: acteur.ip });
    return { valeur: vueReferentiel(apres) };
  });
}

/** Objets non retires qui portent encore ce code (un code porte se desactive, il ne se retire pas). */
async function usagesDuCode(tx: Tx, domaine: Domaine, code: string): Promise<Record<string, number>> {
  if (domaine === "TYPE_RESEAU") {
    return {
      jeux: await tx.jeuDonneesProjet.count({ where: { typeReseauCode: code, statut: { not: "RETIRE" } } }),
      concessionnaires: await tx.concessionnaireReseau.count({ where: { typeReseauCode: code, deletedAt: null } }),
    };
  }
  if (domaine === "CATEGORIE_PROJET") return { projets: await tx.projetVoirie.count({ where: { categorieCode: code, deletedAt: null } }) };
  // Correctifs T1+S1 (M2) : la methode d'acquisition d'un jeu est un code de ce referentiel (et une composante de la cle de version d'un reseau).
  if (domaine === "METHODE_ACQUISITION") return { jeux: await tx.jeuDonneesProjet.count({ where: { methodeAcquisition: code, statut: { not: "RETIRE" } } }) };
  return {};
}

export async function retirerValeur(acteur: Acteur, domaineBrut: string, code: string) {
  const domaine = domaineOuErreur(domaineBrut);
  return prisma.$transaction(async (tx) => {
    const avant = await tx.referentielVoirie.findFirst({ where: { domaine, code, deletedAt: null }, include: INCLURE });
    if (!avant) throw introuvable("Valeur de référentiel", "VALEUR_INTROUVABLE");
    const usages = await usagesDuCode(tx, domaine, code);
    const total = Object.values(usages).reduce((s, n) => s + n, 0);
    if (total > 0) throw new ErreurMetier(409, "VALEUR_UTILISEE", `La valeur « ${code} » est portée par ${total} objet(s) non retiré(s) : désactivez-la (actif: false) plutôt que de la retirer.`, { usages });
    const version = prochaineVersion(avant.version);
    const apres = await tx.referentielVoirie.update({ where: { id: avant.id }, data: { deletedAt: new Date(), actif: false, version }, include: INCLURE });
    await tx.referentielVoirieHistorique.create({ data: { referentielId: avant.id, action: "RETRAIT", version, avant: instantaneReferentiel(avant) as object, apres: instantaneReferentiel(apres) as object, acteurId: acteur.id } });
    await logAuditTransactionnelle(tx, { userId: acteur.id, action: "DELETE", entityType: "ReferentielVoirie", entityId: avant.id, before: instantaneReferentiel(avant), after: instantaneReferentiel(apres), ipAddress: acteur.ip });
    return { code, retire: true };
  });
}

// ------------------------------------------------------------------------------------------------
// Type de reseau : code du referentiel => famille (repli sur la famille declaree)
// ------------------------------------------------------------------------------------------------

/**
 * Famille et code effectifs d'un type de reseau. Un code fourni doit exister et ne pas etre retire (400 TYPE_RESEAU_INCONNU) ; une famille
 * declaree qui ne concorde pas avec celle du referentiel est refusee (400 TYPE_RESEAU_INCOHERENT). Sans code : la famille declaree, sans code.
 */
export async function resoudreTypeReseau(tx: Pick<Tx, "referentielVoirie">, d: { code: string | null | undefined; famille: FamilleReseau | string | null }): Promise<{ famille: FamilleReseau | null; code: string | null }> {
  if (!d.code) return { famille: (d.famille as FamilleReseau | null) ?? null, code: null };
  const valeurs = await tx.referentielVoirie.findMany({ where: { domaine: "TYPE_RESEAU", code: d.code, deletedAt: null }, select: { code: true, parametres: true, deletedAt: true } });
  const r = familleEffective(d.code, null, valeurs);
  if (r.codeInconnu || r.famille === null) throw new ErreurMetier(400, "TYPE_RESEAU_INCONNU", `Le type de réseau « ${d.code} » est inconnu ou retiré du référentiel TYPE_RESEAU.`);
  if (d.famille && d.famille !== r.famille) {
    throw new ErreurMetier(400, "TYPE_RESEAU_INCOHERENT", `Le type « ${d.code} » appartient à la famille ${r.famille}, pas ${d.famille} : n'envoyez que typeReseauCode, ou la famille qui lui correspond.`);
  }
  return { famille: r.famille, code: d.code };
}
