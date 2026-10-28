# Image du worker de conversion GDAL isole (module Projets de voirie et reseaux).
# Base : image officielle OSGeo, version ET empreinte epinglees (verifiees le 28/10/2026).
# Ne jamais utiliser un tag mobile (latest, ubuntu-small-latest) : l'image fait partie de la
# surface d'attaque et sa mise a jour est une decision, pas un effet de bord.
ARG GDAL_IMAGE=ghcr.io/osgeo/gdal:ubuntu-small-3.13.3@sha256:64250faf833c06d4b21afce4c27190039ba7ab58d70f0eebc87cf77d929c0b40
FROM ${GDAL_IMAGE}

LABEL org.opencontainers.image.title="ageroute-geoconv" \
      org.opencontainers.image.description="Conversion GDAL isolee (GeoPackage, Shapefile ZIP, DXF vers GeoJSON), sans reseau ni secret"

# Utilisateur non privilegie, UID/GID fixes. Pas de repertoire personnel, pas de shell de connexion.
RUN groupadd --gid 10001 geoconv \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin geoconv

COPY --chown=root:root worker/ /opt/geoconv/
RUN python3 -m compileall -q /opt/geoconv \
 && chmod -R a-w,a+rX /opt/geoconv

# Reduction de la surface : plus de shell, de gestionnaire de paquets ni de binaire setuid.
# Le dernier RUN utilise la forme exec (pas de shell) puisqu'il supprime le shell lui-meme.
# /var/lib/dpkg/status est CONSERVE : les scanneurs de vulnerabilites en ont besoin.
COPY reduire-image.py /tmp/reduire-image.py
RUN ["python3", "-E", "-s", "/tmp/reduire-image.py"]

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    GEOCONV_SPOOL=/spool \
    GEOCONV_TMP=/tmp/geoconv \
    PROJ_NETWORK=OFF \
    GDAL_DRIVER_PATH=disable \
    GDAL_HTTP_MAX_RETRY=0 \
    HOME=/tmp

USER 10001:10001
WORKDIR /tmp
ENTRYPOINT ["python3", "-E", "-s", "/opt/geoconv/geoconv_worker.py"]
