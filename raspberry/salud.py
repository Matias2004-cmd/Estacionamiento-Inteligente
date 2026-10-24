"""Healthcheck de Docker: el servicio está sano si su latido tiene menos de 90 s."""
import os
import sys
import time

ARCHIVO = os.environ.get("HEARTBEAT_FILE", "/tmp/latido")
MAXIMO = float(os.environ.get("HEARTBEAT_MAX_AGE_SECONDS", "90"))

try:
    edad = time.time() - os.path.getmtime(ARCHIVO)
except OSError:
    sys.exit(1)
sys.exit(0 if edad <= MAXIMO else 1)
