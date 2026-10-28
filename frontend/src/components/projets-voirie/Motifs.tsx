import { COULEUR_AXES, STYLE_CONFLIT, STYLE_RESEAU, type CleConflit, type TypeReseau } from "../../lib/projetsVoirie";

/**
 * Echantillon de trait pour la legende et les tableaux : COULEUR ET MOTIF. La couleur ne porte jamais l'information seule (WCAG 1.4.1) ;
 * le nom du motif est de plus ecrit en toutes lettres a cote. Un liseré sombre derriere le trait garde un contraste suffisant aux teintes
 * claires (le jaune du gaz fait 1,9:1 sur blanc).
 */

export function Echantillon({ couleur, motif, epaisseur = 4, disque = false }: { couleur: string; motif: string; epaisseur?: number; disque?: boolean }) {
  return (
    <svg aria-hidden="true" focusable="false" width="34" height="14" viewBox="0 0 34 14" className="inline-block shrink-0 align-middle">
      {disque ? (
        <circle cx="17" cy="7" r="5" fill={couleur} stroke="#ffffff" strokeWidth="2" />
      ) : (
        <>
          <line x1="1" y1="7" x2="33" y2="7" stroke="#1a2942" strokeWidth={epaisseur + 2} strokeOpacity="0.55" strokeLinecap="butt" />
          <line x1="1" y1="7" x2="33" y2="7" stroke={couleur} strokeWidth={epaisseur} strokeDasharray={motif || undefined} strokeLinecap="butt" />
        </>
      )}
    </svg>
  );
}

export function EchantillonReseau({ type }: { type: TypeReseau }) {
  const s = STYLE_RESEAU[type];
  return <Echantillon couleur={s.couleur} motif={s.motif} />;
}

export function EchantillonAxes() {
  return <Echantillon couleur={COULEUR_AXES} motif="" epaisseur={5} />;
}

export function EchantillonConflit({ cle }: { cle: CleConflit }) {
  const s = STYLE_CONFLIT[cle];
  return <Echantillon couleur={s.couleur} motif={s.motif} epaisseur={Math.min(s.epaisseur, 6)} disque={cle === "croisements"} />;
}

/** Hachures CSS du segment de la barre de repartition : une trame par type, en plus de la couleur. */
export function fondSegment(type: TypeReseau): string {
  const c = STYLE_RESEAU[type].couleur;
  const trame = "rgba(26,41,66,0.55)";
  switch (type) {
    case "TELECOM": return c;
    case "EAU_POTABLE": return `repeating-linear-gradient(90deg, ${c} 0 10px, ${trame} 10px 12px)`;
    case "ELECTRICITE": return `repeating-linear-gradient(45deg, ${c} 0 4px, ${trame} 4px 6px)`;
    case "ASSAINISSEMENT": return `repeating-linear-gradient(135deg, ${c} 0 5px, ${trame} 5px 7px)`;
    case "GAZ_HYDROCARBURES": return `repeating-linear-gradient(0deg, ${c} 0 5px, ${trame} 5px 7px)`;
    default: return `radial-gradient(${trame} 1.2px, ${c} 1.4px) 0 0 / 6px 6px`;
  }
}
