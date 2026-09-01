// Impression/PDF d'une fiche : bascule une classe sur <body> (cf. index.css,
// regle .printing-fiche) qui masque #root pour ne laisser que le modal ouvert
// visible dans la boite de dialogue d'impression du navigateur ("Enregistrer en PDF").
export function printFiche() {
  document.body.classList.add("printing-fiche");
  const cleanup = () => document.body.classList.remove("printing-fiche");
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
}

// Impression d'un rapport pleine page (cf. index.css, regle .printing-report) : masque
// l'habillage marque .no-print et imprime la zone .printable-report.
export function printReport() {
  document.body.classList.add("printing-report");
  const cleanup = () => document.body.classList.remove("printing-report");
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
}
