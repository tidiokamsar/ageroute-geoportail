/**
 * Déclaration du script de politique du service worker.
 *
 * `public/sw-policy.js` est un script CLASSIQUE, chargé par `importScripts` depuis le
 * worker : il ne peut donc pas être un module ES, et pose `globalThis.politiqueSw`. Son
 * import dans un test n'apporte aucune valeur typée — seul l'effet de bord compte, et c'est
 * ce que cette déclaration dit.
 */
declare module "*/sw-policy.js" {
  const _default: void;
  export default _default;
}
