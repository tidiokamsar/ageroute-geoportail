"""Point d'entree du worker de conversion GDAL isole.

Usage :
  python3 geoconv_worker.py              boucle : traite les jobs de entree/ au fil de l'eau
  python3 geoconv_worker.py --une-fois   traite les jobs en attente puis s'arrete (tests)
  python3 geoconv_worker.py --autotest   verifie la liste blanche de pilotes puis s'arrete
"""
import json
import os
import shutil
import signal
import sys
import time

sys.dont_write_bytecode = True

import config
import processus
from erreurs import ErreurGeoconv, nettoyer
from gdalio import Gdal
from travail import Job, RE_JOB, ecrire_json

BATTEMENT = "/tmp/geoconv.battement"


def journal(**kw):
    ligne = {"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    for k, v in kw.items():
        ligne[k] = nettoyer(v, 300) if isinstance(v, str) else v
    print(json.dumps(ligne, ensure_ascii=False), flush=True)


def battement():
    try:
        with open(BATTEMENT, "w") as f:
            f.write(str(time.time()))
    except OSError:
        pass


def arret(signum, frame):
    processus.interruption_demandee = True


def jobs_en_attente(cfg):
    base = os.path.join(cfg.spool, "entree")
    sortie = os.path.join(cfg.spool, "sortie")
    try:
        noms = os.listdir(base)
    except OSError:
        return []
    jobs = []
    for n in noms[:20000]:
        if not RE_JOB.fullmatch(n) or os.path.exists(os.path.join(sortie, n)):
            continue
        dossier = os.path.join(base, n)
        try:
            st = os.lstat(os.path.join(dossier, "demande.json"))
        except OSError:
            continue  # demande.json absent : le backend n'a pas fini de deposer
        if os.path.isdir(dossier) and not os.path.islink(dossier):
            jobs.append((st.st_mtime, n))
    return [n for _, n in sorted(jobs)]


def recuperer_orphelins(cfg):
    """Un statut 'en_cours' laisse par un arret brutal est transforme en echec INTERROMPU."""
    base = os.path.join(cfg.spool, "sortie")
    try:
        noms = os.listdir(base)
    except OSError:
        return
    for n in noms:
        if not RE_JOB.fullmatch(n):
            continue
        p = os.path.join(base, n, "statut.json")
        try:
            with open(p, "rb") as f:
                s = json.loads(f.read(65536))
        except (OSError, ValueError):
            continue
        if s.get("statut") == "en_cours":
            s.update({"statut": "echec", "code": "INTERROMPU", "etape": "echec",
                      "message": "traitement interrompu (redemarrage du worker)",
                      "fin": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            shutil.rmtree(os.path.join(base, n, "couches"), ignore_errors=True)
            ecrire_json(p, s)
            journal(evt="orphelin-recupere", job=n)


def purger_anciennes_sorties(cfg):
    if cfg.retention_h <= 0:
        return
    base = os.path.join(cfg.spool, "sortie")
    limite = time.time() - cfg.retention_h * 3600
    try:
        noms = os.listdir(base)
    except OSError:
        return
    for n in noms:
        p = os.path.join(base, n)
        try:
            if RE_JOB.fullmatch(n) and os.path.isdir(p) and not os.path.islink(p) and os.lstat(p).st_mtime < limite:
                shutil.rmtree(p)
                journal(evt="sortie-purgee", job=n)
        except OSError:
            pass


def traiter(cfg, gdal, job_id):
    t0 = time.monotonic()
    try:
        code = Job(cfg, gdal, job_id).executer()
    except FileExistsError:
        return  # pris par une autre instance ou deja traite
    journal(evt="job", job=job_id, resultat=code or "termine", dureeMs=int((time.monotonic() - t0) * 1000))


def main(argv):
    os.umask(0o022)
    cfg = config.charger()
    os.makedirs(cfg.tmp, mode=0o700, exist_ok=True)
    gdal = Gdal(cfg, cfg.tmp)
    try:
        gdal.initialiser()
    except ErreurGeoconv as e:
        journal(evt="demarrage-refuse", code=e.code, message=e.message)
        return 3
    journal(evt="demarrage", worker=config.VERSION_WORKER, gdal=gdal.version, proj=gdal.proj,
            pilotes=gdal.pilotes_actifs, limites=vars(cfg.limites))
    if "--autotest" in argv:
        print(json.dumps({"gdal": gdal.version, "proj": gdal.proj, "pilotesActifs": gdal.pilotes_actifs,
                          "gdalSkip": gdal.skip.split(","), "pilotesInstalles": gdal.pilotes_installes}, ensure_ascii=False))
        return 0
    signal.signal(signal.SIGTERM, arret)
    signal.signal(signal.SIGINT, arret)
    recuperer_orphelins(cfg)
    une_fois = "--une-fois" in argv
    derniere_purge = 0
    while not processus.interruption_demandee:
        battement()
        if time.time() - derniere_purge > 600:
            purger_anciennes_sorties(cfg)
            derniere_purge = time.time()
        attente = jobs_en_attente(cfg)
        for job_id in attente:
            if processus.interruption_demandee:
                break
            traiter(cfg, gdal, job_id)
            battement()
        if une_fois and not attente:
            break
        if not attente:
            time.sleep(cfg.scrutation_s)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
