/**
 * Retrograde un compte : retire son role eleve et le desactive.
 *
 * POURQUOI LES DEUX ET NON L'UN DES DEUX
 *
 * Desactiver seul laisse le role ADMIN sur la ligne : le jour ou quelqu'un reactive le
 * compte — ce qui arrive, et sans malice — il revient avec les pleins pouvoirs. Retrograder
 * seul laisse un compte utilisable. Les deux ensemble rendent le retour arriere explicite :
 * il faudra reactiver ET repromouvoir, donc le decider deux fois.
 *
 * RIEN N'EST SUPPRIME
 *
 * La ligne reste, avec son historique de connexions et ses references dans `audit_logs`.
 * Supprimer un compte casserait les cles etrangeres de tout ce qu'il a fait, et effacerait
 * la tracabilite de ses actions passees — l'inverse de ce qu'un durcissement cherche.
 *
 * L'AUTEUR DOIT ETRE NOMME
 *
 * Aucune valeur par defaut. Une modification de droits en production doit etre imputable a
 * quelqu'un (paragraphe 26 du cahier, regle 3 d'AGENTS.md), et laisser le script choisir
 * l'auteur reviendrait a attribuer une decision a qui se trouve en base.
 *
 * REFUS DE SE TIRER DANS LE PIED
 *
 * Le script refuse de retrograder le dernier ADMIN actif, et refuse qu'un auteur se
 * retrograde lui-meme. Le premier cas verrouillerait l'application ; le second est la meme
 * separation des roles que pour les validations.
 *
 * Usage : tsx scripts/retrograder-compte.ts --compte <email> --par <email> --motif "..."
 */
import { AuditAction, Role } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { logAuditTransactionnelle } from "../src/utils/audit";

function argument(nom: string): string | null {
  const i = process.argv.indexOf(`--${nom}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const emailCompte = argument("compte");
  const emailAuteur = argument("par");
  const motif = argument("motif");

  if (!emailCompte || !emailAuteur || !motif) {
    throw new Error(
      "Usage : --compte <email> --par <email> --motif \"raison\"\n"
      + "  Les trois sont obligatoires : une modification de droits sans motif ni auteur "
      + "n'est pas auditable.",
    );
  }
  if (emailCompte === emailAuteur) {
    throw new Error("Un compte ne se retrograde pas lui-meme. Faites-le faire par un autre administrateur.");
  }

  const [compte, auteur] = await Promise.all([
    prisma.user.findUnique({
      where: { email: emailCompte },
      select: { id: true, email: true, nomComplet: true, role: true, actif: true, derniereConnexion: true },
    }),
    prisma.user.findUnique({ where: { email: emailAuteur }, select: { id: true, email: true, role: true, actif: true } }),
  ]);

  if (!compte) throw new Error(`Compte introuvable : ${emailCompte}`);
  if (!auteur) throw new Error(`Auteur introuvable : ${emailAuteur}`);
  if (auteur.role !== Role.ADMIN || !auteur.actif) {
    throw new Error(`${emailAuteur} n'est pas un administrateur actif : il ne peut pas retrograder un compte.`);
  }

  if (compte.role === Role.LECTEUR && !compte.actif) {
    console.log(`${compte.email} est deja retrograde et desactive. Rien a faire.`);
    return;
  }

  // Le garde-fou qui compte : ne jamais retirer le dernier administrateur actif.
  if (compte.role === Role.ADMIN && compte.actif) {
    const adminsActifs = await prisma.user.count({ where: { role: Role.ADMIN, actif: true } });
    if (adminsActifs <= 1) {
      throw new Error(
        "Refus : c'est le dernier administrateur actif. Le retrograder verrouillerait "
        + "l'application sans moyen de revenir.",
      );
    }
    console.log(`${adminsActifs} administrateurs actifs avant l'operation, ${adminsActifs - 1} apres.`);
  }

  const avant = { role: compte.role, actif: compte.actif };
  const apres = { role: Role.LECTEUR, actif: false };

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: compte.id }, data: apres });
    await logAuditTransactionnelle(tx, {
      userId: auteur.id,
      action: AuditAction.SECURITY_EVENT,
      entityType: "User",
      entityId: compte.id,
      before: avant,
      after: { ...apres, motif },
    });
  });

  console.log(`${compte.email} : ${avant.role} actif=${avant.actif} -> LECTEUR actif=false`);
  console.log(`  auteur : ${auteur.email}`);
  console.log(`  motif  : ${motif}`);
  console.log(`  derniere connexion du compte : ${compte.derniereConnexion?.toISOString().slice(0, 10) ?? "jamais"}`);
  console.log("  La ligne est conservee : rien n'est supprime, et le retour arriere demande");
  console.log("  de reactiver ET de repromouvoir, donc de le decider deux fois.");
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
