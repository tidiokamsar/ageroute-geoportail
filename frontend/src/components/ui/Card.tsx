import * as React from "react"

import { cn } from "@/lib/utils"
import { assombrirPour, estHex, surFond } from "@/lib/contraste"

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-xl border bg-card text-card-foreground shadow-sm p-5",
      className
    )}
    {...props}
  />
))
Card.displayName = "Card"

function KpiCard({
  label,
  value,
  sub,
  icon,
  accent = "#1a2942",
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon?: React.ReactNode;
  accent?: string;
}) {
  // `accent` est choisi pour les aplats (barre, halo) ; en TEXTE sur blanc, l'or #f5a623 ou le gris
  // #9ca3af mesuraient 2,0:1 et 2,5:1 (seuil 3:1 pour du grand texte). On assombrit pour la lecture,
  // l'aplat garde la couleur d'origine. Voir docs/accessibilite/CONTRASTE.md.
  const accentTexte = estHex(accent) ? assombrirPour(accent, "#ffffff", 4.5) : accent;
  const accentIcone = estHex(accent) ? assombrirPour(accent, surFond(accent, 0.082, "#ffffff"), 4.5) : accent;
  return (
    <Card className="relative overflow-hidden p-4 transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 border-gray-200/70 group cursor-default">
      {/* Gradient blob background */}
      <span
        className="absolute -top-4 -right-4 h-20 w-20 rounded-full blur-2xl opacity-[0.08] group-hover:opacity-[0.14] transition-opacity"
        style={{ backgroundColor: accent }}
      />
      {/* Left accent bar */}
      <span className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: accent }} />
      <div className="flex items-start justify-between gap-2 pl-2">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground/70 truncate font-medium">{label}</p>
          <p className="mt-1.5 text-2xl md:text-3xl font-black leading-tight" style={{ color: accentTexte }}>
            {value}
          </p>
          {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
        </div>
        {icon && (
          <span
            className="shrink-0 flex items-center justify-center h-10 w-10 rounded-xl text-xl shadow-sm group-hover:scale-110 transition-transform duration-200"
            style={{ backgroundColor: `${accent}15`, color: accentIcone }}
          >
            {icon}
          </span>
        )}
      </div>
    </Card>
  );
}

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("font-semibold leading-none tracking-tight", className)}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent, KpiCard }
