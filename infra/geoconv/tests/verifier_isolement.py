"""Verification de l'ISOLEMENT, executee A L'INTERIEUR du conteneur worker (memes options que le compose).

Chaque controle affiche OK ou KO ; le code de sortie est 1 si un controle echoue.
Aucune connexion reelle ne doit aboutir : le conteneur n'a pas de reseau.
"""
import ctypes
import errno
import os
import re
import resource
import signal
import socket
import subprocess
import sys
import time

RESULTATS = []


def controle(nom):
    def deco(f):
        try:
            detail = f()
            ok = True
        except AssertionError as e:
            ok, detail = False, str(e)
        except Exception as e:  # noqa
            ok, detail = False, f"{type(e).__name__}: {e}"
        RESULTATS.append((nom, ok, detail))
        print(("OK  " if ok else "KO  ") + nom + (f" : {detail}" if detail else ""), flush=True)
        return f
    return deco


def refuse_ecriture(chemin):
    try:
        with open(chemin, "w") as f:
            f.write("x")
    except OSError as e:
        return e.errno in (errno.EROFS, errno.EACCES, errno.EPERM)
    os.unlink(chemin)
    return False


def statut(cle):
    with open("/proc/self/status") as f:
        for l in f:
            if l.startswith(cle + ":"):
                return l.split(":", 1)[1].strip()


@controle("utilisateur non root (UID/GID 10001)")
def _():
    assert os.getuid() == 10001 and os.getgid() == 10001, (os.getuid(), os.getgid())
    assert os.geteuid() != 0
    return f"uid={os.getuid()} gid={os.getgid()}"


@controle("aucune capacite (CapEff, CapPrm, CapBnd, CapAmb a zero)")
def _():
    for k in ("CapEff", "CapPrm", "CapBnd", "CapAmb"):
        v = int(statut(k), 16)
        assert v == 0, f"{k}={v:x}"


@controle("no-new-privileges actif")
def _():
    assert statut("NoNewPrivs") == "1", statut("NoNewPrivs")


@controle("systeme de fichiers racine en lecture seule (/, /usr, /opt/geoconv, /etc, /var, /root, /home)")
def _():
    for d in ("/", "/usr", "/opt/geoconv", "/etc", "/var", "/root", "/home", "/srv", "/usr/local/bin"):
        assert refuse_ecriture(os.path.join(d, "intrusion.txt")), f"ecriture possible dans {d}"
    assert refuse_ecriture("/opt/geoconv/geoconv_worker.py"), "code du worker modifiable"
    assert refuse_ecriture("/etc/passwd"), "/etc/passwd modifiable"


@controle("/tmp est inscriptible mais noexec")
def _():
    p = "/tmp/essai.bin"
    with open("/usr/bin/true", "rb") as s, open(p, "wb") as d:
        d.write(s.read())
    os.chmod(p, 0o755)
    try:
        subprocess.run([p], check=True, timeout=5)
    except (PermissionError, OSError) as e:
        os.unlink(p)
        assert e.errno == errno.EACCES, e
        return "execution depuis /tmp refusee (EACCES)"
    os.unlink(p)
    raise AssertionError("un binaire place dans /tmp a pu etre execute")


@controle("entree en lecture seule, sortie inscriptible")
def _():
    assert refuse_ecriture("/spool/entree/intrusion.txt"), "ecriture possible dans l'entree"
    with open("/spool/sortie/.essai", "w") as f:
        f.write("ok")
    os.unlink("/spool/sortie/.essai")
    # aucun autre point de montage inscriptible hors /tmp et /spool/sortie
    ecrivables = []
    with open("/proc/mounts") as f:
        for l in f:
            dev, pt, typ, opts = l.split()[:4]
            if "rw" in opts.split(",") and pt not in ("/tmp", "/spool/sortie") and not pt.startswith(("/proc", "/dev", "/sys")):
                ecrivables.append(pt)
    assert not ecrivables, f"montages inscriptibles inattendus : {ecrivables}"


@controle("tmpfs /tmp borne (ENOSPC avant 600 Mo)")
def _():
    ecrit = 0
    bloc = b"\x00" * (1024 * 1024)
    try:
        for i in range(3):
            with open(f"/tmp/remplissage{i}", "wb") as f:
                for _ in range(250):
                    f.write(bloc)
                    ecrit += len(bloc)
                f.flush()
    except OSError as e:
        for i in range(3):
            try:
                os.unlink(f"/tmp/remplissage{i}")
            except OSError:
                pass
        assert e.errno == errno.ENOSPC, e
        return f"ENOSPC apres {ecrit // (1024 * 1024)} Mo"
    for i in range(3):
        os.unlink(f"/tmp/remplissage{i}")
    raise AssertionError("tmpfs non borne")


@controle("limite de taille de fichier (RLIMIT_FSIZE) appliquee")
def _():
    soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
    assert soft == hard == 268435456, (soft, hard)
    return f"{soft} octets"


@controle("RLIMIT_NOFILE et RLIMIT_CORE")
def _():
    n = resource.getrlimit(resource.RLIMIT_NOFILE)
    c = resource.getrlimit(resource.RLIMIT_CORE)
    assert n == (512, 512), n
    assert c == (0, 0), c


def lire_cgroup(nom):
    for base in ("/sys/fs/cgroup/", "/sys/fs/cgroup/memory/", "/sys/fs/cgroup/pids/"):
        try:
            with open(base + nom) as f:
                return f.read().strip()
        except OSError:
            continue
    return None


@controle("limites cgroup : memoire 1 Go sans swap, 64 processus, 1 CPU")
def _():
    mem = lire_cgroup("memory.max")
    swap = lire_cgroup("memory.swap.max")
    pids = lire_cgroup("pids.max")
    cpu = lire_cgroup("cpu.max")
    assert mem == str(1024 ** 3), f"memory.max={mem}"
    assert swap in ("0", None), f"memory.swap.max={swap}"
    assert pids == "64", f"pids.max={pids}"
    assert cpu and cpu.split()[0] == cpu.split()[1], f"cpu.max={cpu}"
    return f"memory.max={mem} swap={swap} pids.max={pids} cpu.max={cpu}"


@controle("limite de processus (pids_limit) : creation de 200 processus refusee avant la fin")
def _():
    enfants = []
    refus = None
    try:
        for i in range(200):
            pid = os.fork()
            if pid == 0:
                time.sleep(20)
                os._exit(0)
            enfants.append(pid)
    except OSError as e:
        refus = e
    for pid in enfants:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except OSError:
            pass
    assert refus is not None and refus.errno == errno.EAGAIN, f"{len(enfants)} processus crees sans refus"
    return f"refus (EAGAIN) apres {len(enfants)} processus"


@controle("aucune interface reseau hors loopback, aucune route")
def _():
    with open("/proc/net/dev") as f:
        ifaces = [l.split(":")[0].strip() for l in f.readlines()[2:]]
    assert ifaces == ["lo"] or ifaces == [], ifaces
    with open("/proc/net/route") as f:
        routes = f.readlines()[1:]
    assert not routes, routes
    return f"interfaces={ifaces}"


@controle("resolution de nom impossible (DNS)")
def _():
    try:
        socket.getaddrinfo("example.com", 80)
    except socket.gaierror:
        return "getaddrinfo -> gaierror"
    raise AssertionError("un nom a ete resolu")


@controle("aucune connexion sortante (TCP 1.1.1.1:443, TCP 93.184.216.34:80, UDP 8.8.8.8:53)")
def _():
    for hote, port in (("1.1.1.1", 443), ("93.184.216.34", 80)):
        try:
            socket.create_connection((hote, port), timeout=3).close()
        except OSError as e:
            assert e.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ECONNREFUSED), e
        else:
            raise AssertionError(f"connexion a {hote}:{port} aboutie")
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(2)
    try:
        s.sendto(b"\x00", ("8.8.8.8", 53))
    except OSError as e:
        assert e.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH), e
    else:
        raise AssertionError("datagramme UDP parti")
    finally:
        s.close()


@controle("aucun service en ecoute sur la boucle locale, socket brut refuse")
def _():
    try:
        socket.create_connection(("127.0.0.1", 5432), timeout=2).close()
        raise AssertionError("127.0.0.1:5432 repond")
    except OSError as e:
        assert e.errno == errno.ECONNREFUSED or isinstance(e, TimeoutError) or e.errno in (errno.ENETUNREACH, errno.EADDRNOTAVAIL), e
    try:
        socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
    except (PermissionError, OSError) as e:
        assert e.errno in (errno.EPERM, errno.EACCES, errno.EAFNOSUPPORT), e
    else:
        raise AssertionError("socket brut AF_PACKET cree")


@controle("aucun shell, gestionnaire de paquets ni outil reseau dans l'image")
def _():
    absents = ["/bin/sh", "/bin/bash", "/bin/dash", "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/dash",
               "/usr/bin/apt", "/usr/bin/apt-get", "/usr/bin/dpkg", "/usr/bin/curl", "/usr/bin/wget", "/usr/bin/nc",
               "/usr/bin/ssh", "/usr/bin/su", "/usr/bin/sudo", "/usr/bin/perl"]
    presents = [p for p in absents if os.path.lexists(p)]
    assert not presents, f"presents : {presents}"
    try:
        subprocess.run(["/bin/sh", "-c", "true"], timeout=3)
    except OSError:
        return "exec /bin/sh impossible"
    raise AssertionError("/bin/sh executable")


@controle("operations privilegiees refusees (setuid, chown root, mount)")
def _():
    for f, args in ((os.setuid, (0,)), (os.setgid, (0,))):
        try:
            f(*args)
        except PermissionError:
            pass
        else:
            raise AssertionError(f"{f.__name__}(0) a reussi")
    open("/tmp/c", "w").close()
    try:
        os.chown("/tmp/c", 0, 0)
    except PermissionError:
        pass
    else:
        raise AssertionError("chown root reussi")
    libc = ctypes.CDLL(None, use_errno=True)
    r = libc.mount(b"none", b"/tmp", b"tmpfs", 0, None)
    e = ctypes.get_errno()
    assert r != 0 and e in (errno.EPERM, errno.EACCES), (r, e)
    os.unlink("/tmp/c")


@controle("aucun secret dans l'environnement, aucun socket Docker")
def _():
    suspects = [k for k in os.environ if re.search(r"PASS|SECRET|TOKEN|KEY|CREDENTIAL|DATABASE|DB_|JWT|URL", k, re.I)]
    assert not suspects, suspects
    assert not os.path.exists("/var/run/docker.sock") and not os.path.exists("/run/docker.sock")
    return "variables : " + ",".join(sorted(os.environ))


# --------------------------------------------------------------- GDAL lui-meme
sys.path.insert(0, "/opt/geoconv")
import config  # noqa: E402
from gdalio import Gdal  # noqa: E402

_cfg = config.charger()
_g = Gdal(_cfg, "/tmp")
_g.initialiser()


def ogrinfo(args, timeout=15):
    p = subprocess.run([_g.exe_ogrinfo] + args, env=_g.env(), capture_output=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).decode("utf-8", "replace")


@controle("registre GDAL = liste blanche exacte (GPKG, ESRI Shapefile, DXF, GeoJSON)")
def _():
    assert set(_g.pilotes_actifs) == set(config.PILOTES_AUTORISES), _g.pilotes_actifs
    return ", ".join(_g.pilotes_actifs)


@controle("GDAL ne peut pas ouvrir /vsicurl/ ni une base distante PostgreSQL")
def _():
    t0 = time.time()
    rc, out = ogrinfo(["-ro", "-if", "GPKG", "/vsicurl/http://example.com/x.gpkg"])
    assert rc != 0, "ogrinfo vsicurl a reussi"
    rc2, out2 = ogrinfo(["-ro", "PG:host=127.0.0.1 port=5432 dbname=console_bdri user=x"])
    assert rc2 != 0 and ("No such file" in out2 or "supported file format" in out2), out2[:200]
    assert time.time() - t0 < 12, "tentative reseau lente"
    return "echecs immediats"


@controle("ogrinfo --formats (brut, independant du worker) ne liste que 4 pilotes, sans avertissement")
def _():
    rc, out = ogrinfo(["--formats"])
    lignes = [l for l in out.splitlines() if l.startswith("  ")]
    assert rc == 0 and len(lignes) == 4, lignes
    assert "Warning" not in out, out[:300]
    return " | ".join(l.strip().split(" -")[0] for l in lignes)


@controle("pilotes retires inutilisables : KML, GPX, CSV, SQLite, WFS, VRT")
def _():
    erreurs = []
    for pilote in ("KML", "GPX", "CSV", "SQLite", "WFS", "OGR_VRT", "HTTP"):
        rc, out = ogrinfo(["-ro", "-if", pilote, "/tmp/inexistant"])
        if "Unable to find driver" not in out and rc == 0:
            erreurs.append(pilote)
    assert not erreurs, erreurs


@controle("GDAL ne peut pas ecrire hors de /tmp et de la sortie")
def _():
    for dest in ("/etc/x.geojson", "/usr/x.geojson", "/spool/entree/x.geojson", "/opt/geoconv/x.geojson"):
        p = subprocess.run([_g.exe_ogr2ogr, "-f", "GeoJSON", dest, "/tmp/inexistant"], env=_g.env(), capture_output=True, timeout=10)
        assert p.returncode != 0 and not os.path.exists(dest)


sys.exit(0 if all(ok for _, ok, _ in RESULTATS) else 1)
