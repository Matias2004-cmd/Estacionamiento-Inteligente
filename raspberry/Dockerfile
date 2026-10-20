FROM debian:trixie-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /opt/estacionamiento

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        python3-paho-mqtt \
    && rm -rf /var/lib/apt/lists/*

COPY servicios/ ./servicios/
