"""Configuration du worker : limites (plafonds fixes par l'operateur) et chemins.

Les limites sont des PLAFONDS lus dans l'environnement du conteneur. Le fichier
demande.json peut les ABAISSER pour un job, jamais les relever : meme si le backend
etait compromis, il ne pourrait pas desserrer la protection.
"""
import os
from dataclasses import dataclass, asdict

VERSION_WORKER = "0.1.0"
VERSION_CONTRAT = 1

# Liste blanche des pilotes. GPKG, ESRI Shapefile et DXF sont lus en entree ; GeoJSON sert a
# ECRIRE la sortie et a la relire pour verification. Rien d'autre ne doit rester enregistre.
PILOTES_ENTREE = ("GPKG", "ESRI Shapefile", "DXF")
PILOTES_AUTORISES = frozenset(PILOTES_ENTREE) | {"GeoJSON"}


def _entier(nom, defaut, mini=1):
    brut = os.environ.get(nom)
    if brut is None or brut == "":
        return defaut
    try:
        v = int(brut)
    except ValueError:
        raise SystemExit(f"configuration invalide : {nom} n'est pas un entier")
    if v < mini:
        raise SystemExit(f"configuration invalide : {nom} < {mini}")
    return v


@dataclass(frozen=True)
class Limites:
    taille_entree_octets: int
    entrees_archive_max: int
    taille_decompressee_octets: int
    taux_compression_max: int
    objets_max: int
    couches_max: int
    champs_max: int
    sortie_octets_max: int
    delai_s: int

    def abaisser(self, demande: dict):
        """Retourne de nouvelles limites ; leve ValueError si une valeur depasse le plafond."""
        valeurs = asdict(self)
        for cle, v in (demande or {}).items():
            if cle not in valeurs:
                raise ValueError(f"limite inconnue : {cle}")
            if isinstance(v, bool) or not isinstance(v, int) or v < 1:
                raise ValueError(f"limite {cle} : entier strictement positif attendu")
            if v > valeurs[cle]:
                raise ValueError(f"limite {cle} : {v} depasse le plafond de l'operateur ({valeurs[cle]})")
            valeurs[cle] = v
        return Limites(**valeurs)


@dataclass(frozen=True)
class Config:
    spool: str
    tmp: str
    scrutation_s: int
    retention_h: int
    memoire_enfant_octets: int
    nofile_enfant: int
    limites: Limites


def charger() -> Config:
    lim = Limites(
        taille_entree_octets=_entier("GEOCONV_LIMITE_TAILLE_ENTREE", 50 * 1024 * 1024),
        entrees_archive_max=_entier("GEOCONV_LIMITE_ENTREES_ARCHIVE", 200),
        taille_decompressee_octets=_entier("GEOCONV_LIMITE_TAILLE_DECOMPRESSEE", 250 * 1024 * 1024),
        taux_compression_max=_entier("GEOCONV_LIMITE_TAUX_COMPRESSION", 100),
        objets_max=_entier("GEOCONV_LIMITE_OBJETS", 50_000),
        couches_max=_entier("GEOCONV_LIMITE_COUCHES", 50),
        champs_max=_entier("GEOCONV_LIMITE_CHAMPS", 500),
        sortie_octets_max=_entier("GEOCONV_LIMITE_SORTIE", 200 * 1024 * 1024),
        delai_s=_entier("GEOCONV_LIMITE_DELAI_S", 120),
    )
    return Config(
        spool=os.environ.get("GEOCONV_SPOOL", "/spool"),
        tmp=os.environ.get("GEOCONV_TMP", "/tmp/geoconv"),
        scrutation_s=_entier("GEOCONV_SCRUTATION_S", 2),
        retention_h=_entier("GEOCONV_RETENTION_H", 72, mini=0),
        memoire_enfant_octets=_entier("GEOCONV_MEMOIRE_ENFANT", 1536 * 1024 * 1024),
        nofile_enfant=_entier("GEOCONV_NOFILE_ENFANT", 256),
        limites=lim,
    )
