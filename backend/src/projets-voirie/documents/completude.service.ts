/**
 * « CE QUE LES DOCUMENTS PERMETTENT » pour un projet (lot D1 ; contrat CONTRAT-DOCUMENTS.md, section 6). Lecture seule (`READ ONLY`), delais cote base
 * (`statement_timeout` de la carte, `lock_timeout`), SQL brut a valeurs liees. Les regles sont dans completude.noyau.ts.
 *
 * Seuls les jeux AUTORISE comptent, pour tous les roles. Les documents : un compte qui ne decide pas ne recoit que les VALIDE (ni les pieces en cours,
 * ni leur nombre). Les decisions de deplacement : celles des dossiers visibles du compte (pour un lecteur, dossiers dont les jeux lies sont AUTORISE).
 */

import { prisma } from "../../lib/prisma";
import { estDelaiDepasse, poserDelais } from "../bd";
import { delaiCarteMs, delaiVerrouMs } from "../config";
import { estDecideur } from "../conflits/types.noyau";
import { ErreurMetier, introuvable } from "../erreurs";
import type { Acteur } from "../projets.service";
import { calculerCompletude, reseauxDepuisJeux, type TypeDocumentEntree } from "./completude.noyau";

function typeDepuisLigne(l: { code: string; libelle: string; actif: boolean; parametres: unknown }): TypeDocumentEntree {
  const p = (l.parametres ?? {}) as { obligatoire?: unknown; fonctionsDebloquees?: unknown; roleJeu?: unknown };
  return {
    code: l.code, libelle: l.libelle, actif: l.actif, obligatoire: p.obligatoire === true,
    fonctionsDebloquees: Array.isArray(p.fonctionsDebloquees) ? p.fonctionsDebloquees.filter((x): x is string => typeof x === "string") : [],
    roleJeu: typeof p.roleJeu === "string" ? p.roleJeu : null,
  };
}

export async function completudeProjet(acteur: Acteur, projetId: string) {
  const decideur = estDecideur(acteur.role);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await poserDelais(tx, delaiCarteMs(), delaiVerrouMs());
      const projet = await tx.projetVoirie.findFirst({ where: { id: projetId, deletedAt: null }, select: { id: true } });
      if (!projet) throw introuvable("Projet", "PROJET_INTROUVABLE");
      const jeux = await tx.jeuDonneesProjet.findMany({
        where: { projetId, statut: "AUTORISE" },
        select: { id: true, projetId: true, role: true, statut: true, concessionnaireId: true, typeReseau: true, typeReseauCode: true, methodeAcquisition: true, remplaceId: true, createdAt: true, concessionnaire: { select: { nom: true } } },
      });
      // Decisions de deplacement approuvees, sur des dossiers ou un deplacement est decide (TRAITEMENT_DECIDE, CLOTURE) et que le compte voit.
      const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n
          FROM "conflits_projet_decisions" d
          JOIN "conflits_projet" c ON c."id" = d."conflitId"
          LEFT JOIN "projets_voirie_jeux" jr ON jr."id" = c."jeuReseauId"
          LEFT JOIN "projets_voirie_jeux" ja ON ja."id" = c."jeuAxesId"
         WHERE c."projetId" = ${projetId}
           AND d."option"::text = 'DEPLACER_RESEAU' AND d."statut"::text = 'APPROUVEE'
           AND c."statut"::text IN ('TRAITEMENT_DECIDE', 'CLOTURE')
           AND (${decideur} OR ((jr."id" IS NULL OR jr."statut"::text = 'AUTORISE') AND (ja."id" IS NULL OR ja."statut"::text = 'AUTORISE')))`;
      const types = await tx.referentielVoirie.findMany({
        where: { domaine: "TYPE_DOCUMENT", deletedAt: null }, select: { code: true, libelle: true, actif: true, parametres: true }, orderBy: [{ ordre: "asc" }, { code: "asc" }],
      });
      const documents = await tx.documentProjetVoirie.findMany({
        where: { projetId, deletedAt: null, ...(decideur ? {} : { statut: "VALIDE" as const }) },
        select: { id: true, ligneeId: true, version: true, typeCode: true, titre: true, statut: true, format: true, concessionnaireId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 5_000,
      });
      const parRole: Record<string, number> = {};
      for (const j of jeux) parRole[j.role] = (parRole[j.role] ?? 0) + 1;
      const c = calculerCompletude({
        etat: {
          nbAxesAutorises: parRole.AXES_TRAVAUX ?? 0,
          // Revue D1, M2 : identite d'un reseau decidee par l'eligibilite du lot S1, code TYPE_RESEAU transmis.
          reseaux: reseauxDepuisJeux(jeux.map(({ concessionnaire, ...j }) => ({ ...j, concessionnaireNom: concessionnaire?.nom ?? null, typeReseauCode: j.typeReseauCode ?? null }))),
          nbDecisionsDeplacement: Number(n),
        },
        types: types.map(typeDepuisLigne), documents, jeuxAutorisesParRole: parRole, decideur,
      });
      return {
        projetId, calculeLe: new Date(), ...c,
        regle: "Une fonction est disponible des que SES conditions sont remplies par des jeux AUTORISE (ou une decision approuvee) ; aucune piece manquante ne bloque une fonction qui n'en depend pas.",
      };
    }, { timeout: delaiCarteMs() + 5_000, maxWait: 10_000 });
  } catch (e) {
    if (e instanceof ErreurMetier) throw e;
    if (estDelaiDepasse(e)) throw new ErreurMetier(504, "COMPLETUDE_TROP_LONGUE", "Le calcul de ce que les documents permettent a depasse le delai : reessayez.");
    throw e;
  }
}
