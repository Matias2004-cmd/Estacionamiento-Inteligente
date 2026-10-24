# Imagen liviana compatible con ARM (arm64 y armv7) para los cuatro servicios Python.
# lgpio publica wheels precompiladas para Python 3.12 en aarch64/armv7, por lo que
# no se necesita compilador ni el repositorio APT de Raspberry Pi.
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    GPIOZERO_PIN_FACTORY=lgpio \
    LG_WD=/tmp
WORKDIR /opt/estacionamiento

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY servicios/ ./servicios/
COPY salud.py .
