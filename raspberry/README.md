# Raspberry Pi data collection

The deployment follows the assignment's microservice flow:

- Ultrasonic and IR acquisition run as Raspberry Pi systemd services and
  publish readings/events to the local MQTT broker.
- Processing validates readings and creates one aggregate per minute.
- Synchronization sends up to five minute records per API request.
- Failed uploads remain in a persistent SQLite outbox and are retried.

The default ultrasonic sampling interval is configurable and set to 5 seconds.
That yields up to 12 ultrasonic readings per minute and 1,440 Firestore
aggregate documents per day. A five-record batch normally means about 288 API
requests per day. IR contributes event counts to the minute aggregate.

## Configuration

Copy `.env.example` to `.env` on the Raspberry Pi. Set
`DISTANCIA_LIBRE_CM` to the measured empty-space distance. Set
`IR_ACTIVE_LEVEL` to `0` or `1` according to the already-tested IR module
output when an object blocks it. Keep both secret files outside this folder:

- `/home/matiascatalan/.config/estacionamiento/api-token.txt`
- `/home/matiascatalan/.config/estacionamiento/vercel-bypass.txt`

Docker Compose mounts those files as runtime secrets; their values are not
stored in this project or in the container image.

## Installation and smoke tests

Run these commands from `/home/matiascatalan/estacionamiento` on the Pi:

```sh
unzip -o ~/estacionamiento-raspberry.zip -d ~/estacionamiento
cp -n .env.example .env
nano .env
sudo apt update
sudo apt install -y python3-gpiozero python3-lgpio python3-paho-mqtt
python3 -c "import gpiozero, lgpio, paho.mqtt.client; print('GPIO and MQTT dependencies ready')"
docker compose config --quiet
sudo docker compose build
sudo docker compose up -d mqtt procesamiento sincronizacion
```

GPIO acquisition runs on the Pi host because the system's signature-verified
GPIO packages provide access to `/dev/gpiochip0`. Install and start the systemd
units:

```sh
sudo install -m 0644 systemd/estacionamiento-adquisicion-ultrasonico.service /etc/systemd/system/
sudo install -m 0644 systemd/estacionamiento-adquisicion-ir.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now estacionamiento-adquisicion-ultrasonico.service estacionamiento-adquisicion-ir.service
sudo systemctl status estacionamiento-adquisicion-ultrasonico.service estacionamiento-adquisicion-ir.service --no-pager
```

Check sensor logs:

```sh
sudo journalctl -u estacionamiento-adquisicion-ir.service -n 30 --no-pager
sudo journalctl -u estacionamiento-adquisicion-ultrasonico.service -n 30 --no-pager
```

Block and unblock the IR sensor once. Confirm one event is logged when the
object blocks the sensor. If it is logged when the object is removed, change
`IR_ACTIVE_LEVEL` in `.env` from `0` to `1` (or vice versa), then restart:

```sh
sudo systemctl restart estacionamiento-adquisicion-ir.service
```

Confirm distance readings appear, then check processing and synchronization:

```sh
sudo docker compose ps
sudo docker compose logs --tail=50 procesamiento sincronizacion
```

Within five minutes, synchronization should upload a batch and Firestore
should contain minute aggregates. The API token is sent as a Bearer token and
the Vercel bypass uses its dedicated header. Check the persistent retry queue:

```sh
sudo docker compose exec sincronizacion python3 -c "import sqlite3; c=sqlite3.connect('/var/lib/estacionamiento/outbox.sqlite3'); print('pending records:', c.execute('select count(*) from outbox').fetchone()[0])"
```

An empty retry queue is expected when connectivity is working. Do not start
the seven-day measurement until these checks succeed.

After the sensor and upload checks succeed, record the start time and check
the running services:

```sh
sudo docker compose ps
sudo systemctl is-active estacionamiento-adquisicion-ultrasonico.service estacionamiento-adquisicion-ir.service
date -Is
```

For the required continuous measurement, keep the Pi powered, connected to
the network, and running for at least seven days. Check the Firestore
`mediciones` collection and compare its usage with the estimates above.
