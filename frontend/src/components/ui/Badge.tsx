import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import type { ClasseRoute, EtatPatrimoine, Gravite, StatutPoste, StatutChantier, Role, DocumentType } from "../../types"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-white shadow hover:bg-destructive/80",
        outline: "text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

const etatColors: Record<EtatPatrimoine, string> = {
  BON: "bg-green-100 text-green-700 border-transparent",
  MOYEN: "bg-yellow-100 text-yellow-700 border-transparent",
  MAUVAIS: "bg-orange-100 text-orange-700 border-transparent",
  CRITIQUE: "bg-red-100 text-red-700 border-transparent",
  NON_EVALUE: "bg-gray-100 text-gray-600 border-transparent",
};

function EtatBadge({ etat }: { etat: EtatPatrimoine }) {
  return <Badge className={etatColors[etat]}>{etat.replace("_", " ")}</Badge>;
}

const classeColors: Record<ClasseRoute, string> = {
  RN: "bg-navy/10 text-navy border-transparent",
  RR: "bg-blue-100 text-blue-700 border-transparent",
  RU: "bg-teal-100 text-teal-700 border-transparent",
  PISTE: "bg-amber-100 text-amber-700 border-transparent",
  NON_CLASSEE: "bg-gray-100 text-gray-600",
};

const classeDisplayLabels: Record<ClasseRoute, string> = {
  RN: "RN",
  RR: "RP",
  RU: "VU",
  PISTE: "PISTE",
  NON_CLASSEE: "NC",
};

function ClasseBadge({ classe }: { classe: ClasseRoute }) {
  return <Badge className={classeColors[classe]}>{classeDisplayLabels[classe]}</Badge>;
}

const graviteColors: Record<Gravite, string> = {
  FAIBLE: "bg-green-100 text-green-700 border-transparent",
  MOYENNE: "bg-orange-100 text-orange-700 border-transparent",
  FORTE: "bg-red-100 text-red-700 border-transparent",
};

function GraviteBadge({ gravite }: { gravite: Gravite }) {
  return <Badge className={graviteColors[gravite]}>{gravite}</Badge>;
}

const statutPosteColors: Record<StatutPoste, string> = {
  EN_SERVICE: "bg-green-100 text-green-700 border-transparent",
  HORS_SERVICE: "bg-red-100 text-red-700 border-transparent",
  EN_CONSTRUCTION: "bg-amber-100 text-amber-700 border-transparent",
};
const statutPosteLabels: Record<StatutPoste, string> = {
  EN_SERVICE: "En service",
  HORS_SERVICE: "Hors service",
  EN_CONSTRUCTION: "En construction",
};

function StatutPosteBadge({ statut }: { statut: StatutPoste }) {
  return <Badge className={statutPosteColors[statut]}>{statutPosteLabels[statut]}</Badge>;
}

const statutChantierColors: Record<StatutChantier, string> = {
  PLANIFIE: "bg-gray-100 text-gray-600 border-transparent",
  EN_COURS: "bg-amber-100 text-amber-700 border-transparent",
  SUSPENDU: "bg-red-100 text-red-700 border-transparent",
  TERMINE: "bg-green-100 text-green-700 border-transparent",
};
const statutChantierLabels: Record<StatutChantier, string> = {
  PLANIFIE: "Planifié",
  EN_COURS: "En cours",
  SUSPENDU: "Suspendu",
  TERMINE: "Terminé",
};

function StatutChantierBadge({ statut }: { statut: StatutChantier }) {
  return <Badge className={statutChantierColors[statut]}>{statutChantierLabels[statut]}</Badge>;
}

const roleColors: Record<Role, string> = {
  ADMIN: "bg-navy/10 text-navy border-transparent",
  GESTIONNAIRE: "bg-blue-100 text-blue-700 border-transparent",
  INSPECTEUR: "bg-teal-100 text-teal-700 border-transparent",
  LECTEUR: "bg-gray-100 text-gray-600 border-transparent",
};
const roleLabels: Record<Role, string> = {
  ADMIN: "Administrateur",
  GESTIONNAIRE: "Gestionnaire",
  INSPECTEUR: "Inspecteur",
  LECTEUR: "Lecteur",
};

function RoleBadge({ role }: { role: Role }) {
  return <Badge className={roleColors[role]}>{roleLabels[role]}</Badge>;
}

const docTypeColors: Record<DocumentType, string> = {
  ARRETE: "bg-navy/10 text-navy border-transparent",
  CAHIER_CHARGES: "bg-blue-100 text-blue-700 border-transparent",
  CAHIER_ENGAGEMENT: "bg-teal-100 text-teal-700 border-transparent",
  AUTRE: "bg-gray-100 text-gray-600 border-transparent",
};
const docTypeLabels: Record<DocumentType, string> = {
  ARRETE: "Arrêté",
  CAHIER_CHARGES: "Cahier des charges",
  CAHIER_ENGAGEMENT: "Cahier d'engagement",
  AUTRE: "Autre",
};

function DocTypeBadge({ type }: { type: DocumentType }) {
  return <Badge className={docTypeColors[type]}>{docTypeLabels[type]}</Badge>;
}

export { Badge, EtatBadge, ClasseBadge, GraviteBadge, StatutPosteBadge, StatutChantierBadge, RoleBadge, DocTypeBadge, badgeVariants }
