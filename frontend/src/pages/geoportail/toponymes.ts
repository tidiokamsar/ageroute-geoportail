// Reperes extraits d'OpenStreetMap (ponts, tunnels, parkings nommes) - dataset statique
// et de petite taille (29 points), pas besoin d'aller-retour API pour cette couche de
// contexte purement visuelle, contrairement aux couches metier (troncons/ouvrages/...).
export interface Toponyme {
  nom: string;
  nature: "Parking" | "Pont" | "Tunnel";
  lat: number;
  lon: number;
}

export const TOPONYMES: Toponyme[] = [
  { nom: "Parking SOGEAC (Aéroport de Conakry-Gbessia)", nature: "Parking", lat: 9.57523385, lon: -13.62122737669193 },
  { nom: "Parking Auto", nature: "Parking", lat: 9.5320171, lon: -13.679959204475537 },
  { nom: "Le Parking de Conakry", nature: "Parking", lat: 9.5502032, lon: -13.660845807753674 },
  { nom: "Parking Publique", nature: "Parking", lat: 9.5478933, lon: -13.664220248484488 },
  { nom: "Parking Publique", nature: "Parking", lat: 9.54689605, lon: -13.666701478474838 },
  { nom: "Parking Esplanade", nature: "Parking", lat: 9.5478824, lon: -13.674802366320552 },
  { nom: "Esplanade Palais du peuple", nature: "Parking", lat: 9.52076655, lon: -13.691700149978786 },
  { nom: "Pont Kaporo", nature: "Pont", lat: 9.6157449, lon: -13.64158365 },
  { nom: "Pont de Madina", nature: "Pont", lat: 9.54548465, lon: -13.6696655 },
  { nom: "Pont Kenien", nature: "Pont", lat: 9.55325415, lon: -13.6566554 },
  { nom: "Pont du 8 Novembre", nature: "Pont", lat: 9.525530485366998, lon: -13.68822858670902 },
  { nom: "Pont Taouyah", nature: "Pont", lat: 9.5728269, lon: -13.6642002 },
  { nom: "Pont Dixinn Gare", nature: "Pont", lat: 9.5496241, lon: -13.66094355 },
  { nom: "Pont de Kaka", nature: "Pont", lat: 9.727141753798907, lon: -13.41651990467269 },
  { nom: "Pont d'Avaria", nature: "Pont", lat: 9.5470934, lon: -13.6655705 },
  { nom: "Pont Oudiala", nature: "Pont", lat: 10.6052982, lon: -8.6936193 },
  { nom: "Pont Tougnefili", nature: "Pont", lat: 10.4080876, lon: -14.39990585 },
  { nom: "Pont Kaaka", nature: "Pont", lat: 9.748767790367085, lon: -13.361093122970779 },
  { nom: "Pont", nature: "Pont", lat: 11.77735155, lon: -9.72274165 },
  { nom: "Gbangban", nature: "Tunnel", lat: 9.1825614, lon: -10.1045252 },
  { nom: "Yesafe", nature: "Tunnel", lat: 9.19271885, lon: -10.09267175 },
  { nom: "Samou", nature: "Tunnel", lat: 9.9523369, lon: -12.99219565 },
  { nom: "Bankalan", nature: "Tunnel", lat: 10.514228792659173, lon: -9.32425894322614 },
];
