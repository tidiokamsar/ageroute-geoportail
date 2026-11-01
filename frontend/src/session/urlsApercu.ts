/**
 * Registre des URL d'apercu (Blob) des photos de saisie, pour pouvoir les REVOQUER au verrou de la session.
 *
 * POURQUOI. Une photo en cours de saisie est affichee par une URL `blob:` creee par la page. Le verrou de la session masque
 * l'interface (voir ProtectedRoute) mais ne demonte pas la page : l'URL, elle, reste valable tant qu'on ne la revoque pas, et
 * l'image reste lisible par quiconque obtient cette adresse dans l'origine. Revoquer l'URL au verrou ferme cette porte.
 *
 * CONTRAT POUR LES PAGES. Une page qui montre un apercu de photo :
 *   - cree l'URL avec `creerUrlApercu(blob)` (au lieu de `URL.createObjectURL`) et la libere avec `revoquerUrlApercu(url)` ;
 *   - NE PEUT PAS compter sur l'URL apres un verrou : elle recree l'apercu au deverrouillage (la photo elle-meme, le `Blob`,
 *     reste dans l'etat de la page : seul son apercu est revoque). `abonnerRevocationApercus` previent la page.
 *
 * ETAT D'ADOPTION : ce registre est branche sur le verrou (useSessionLocale, effet OUBLIER_DEK). DefautTerrainPage et
 * InspectionTerrainPage l'utilisent : elles creent et retirent leurs URL avec `creerUrlApercu` / `revoquerUrlApercu`, et le hook
 * `useApercusPhotos` les recree au deverrouillage. Une page qui afficherait un apercu avec `URL.createObjectURL` directement
 * echapperait a la revocation : le contrat ci-dessus vaut pour toute nouvelle page.
 */
const urls = new Set<string>();
const abonnes = new Set<() => void>();

export function creerUrlApercu(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  urls.add(url);
  return url;
}

export function revoquerUrlApercu(url: string): void {
  urls.delete(url);
  try { URL.revokeObjectURL(url); } catch { /* deja revoquee */ }
}

/** Revoque toutes les URL d'apercu connues. Rend leur nombre. Previent ensuite les pages abonnees. */
export function revoquerToutesLesUrlsApercu(): number {
  const n = urls.size;
  for (const u of [...urls]) revoquerUrlApercu(u);
  if (n > 0) for (const a of [...abonnes]) { try { a(); } catch { /* un abonne defaillant ne bloque pas les autres */ } }
  return n;
}

export function nombreUrlsApercu(): number {
  return urls.size;
}

/** La page recree ses apercus quand elle est prevenue (au verrou, les URL sont mortes). */
export function abonnerRevocationApercus(rappel: () => void): () => void {
  abonnes.add(rappel);
  return () => { abonnes.delete(rappel); };
}
