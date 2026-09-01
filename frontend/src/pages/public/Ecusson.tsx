/**
 * Ecusson de route : le numero repris dans le vocabulaire de la signalisation
 * routiere (RN1, RES-807...), cadre plutot que texte nu.
 *
 * Ce n'est pas qu'un ornement — sur une carte chargee, un texte pose a plat se
 * confond avec les libelles du fond OpenStreetMap. Un cadre opaque le detache
 * franchement, et c'est la forme que les usagers reconnaissent deja au bord de la
 * route.
 */
export function Ecusson({ nom, taille = "md" }: { nom: string; taille?: "sm" | "md" }) {
  return (
    <span
      className={
        "inline-block shrink-0 rounded-[3px] border-2 border-navy bg-white font-bold tabular-nums text-navy " +
        (taille === "sm" ? "px-1 py-0 text-[10px] leading-4" : "px-1.5 py-0.5 text-xs leading-4")
      }
    >
      {nom}
    </span>
  );
}

/**
 * Meme ecusson en HTML brut, pour le divIcon Leaflet : les etiquettes de la carte
 * ne passent pas par React. Styles en ligne car le HTML injecte dans un divIcon
 * echappe au balayage de classes de Tailwind.
 */
export function ecussonHtml(nom: string): string {
  const texte = nom.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return (
    `<span style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);` +
    `white-space:nowrap;font:700 10px/14px system-ui,sans-serif;font-variant-numeric:tabular-nums;` +
    `color:#1a2942;background:#fff;border:2px solid #1a2942;border-radius:3px;padding:0 3px;` +
    `box-shadow:0 1px 2px rgba(0,0,0,.15)">${texte}</span>`
  );
}
