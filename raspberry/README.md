# Raspberry Pi data collection

The deployment follows the assignment's microservice flow:

- Ultrasonic and IR acquisition run as Raspberry Pi systemd services and
  publish readings/events to the local MQTT broker.
- Processing validates readings and creates one aggregate per minute.
- Synchronization sends up to five minute records per API request.
- Failed uploads remain in a persistent SQLite outbox and are retried.

Docker Compose runs these three services on the Raspberry Pi:
`mqtt` (broker), `procesamiento` (aggregation), and `sincronizacion` (API
batch uploads). The two GPIO acquisition programs remain separate systemd
services because they need direct access to the Pi's GPIO hardware; they are
not additional Compose services.

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

Confirm distance readings appear, then check all three Compose services:

```sh
sudo docker compose ps --all
sudo docker compose logs --tail=50 mqtt procesamiento sincronizacion
```

`docker compose ps --all` should list `estacionamiento-mqtt`,
`estacionamiento-procesamiento`, and `estacionamiento-sincronizacion` as
running. The broker should report `healthy`; the worker health checks verify
that each container can reach the broker. Confirm actual data flow in the logs:
processing should report live readings and minute aggregates, and
synchronization should report `Uploaded batch of ... minute records`.

Within five minutes, synchronization should upload a batch and Firestore
should contain minute aggregates. The API token is sent as a Bearer token and
the Vercel bypass uses its dedicated header. Check the persistent retry queue:

```sh
sudo docker compose exec sincronizacion python3 -c "import sqlite3; c=sqlite3.connect('/var/lib/estacionamiento/outbox.sqlite3'); print('pending records:', c.execute('select count(*) from outbox').fetchone()[0])"
```

An empty retry queue is expected when connectivity is working. Do not start
the seven-day measurement until these checks succeed.

## Service status and recovery

Compose containers use `restart: unless-stopped`, and the GPIO systemd
services use `Restart=on-failure`; they restart after a crash or Pi reboot
unless they were explicitly stopped.

Run these commands from the deployment directory on the Pi to check the three
containers and follow their logs:

```sh
sudo docker compose ps --all
sudo docker compose logs --tail=100 mqtt procesamiento sincronizacion
sudo docker compose logs --follow procesamiento sincronizacion
```

For an unhealthy or stopped service, inspect its logs first, then restart only
that service:

```sh
sudo docker compose restart mqtt
sudo docker compose restart procesamiento
sudo docker compose restart sincronizacion
```

After changing application code or the Dockerfile, rebuild and recreate the
affected worker:

```sh
sudo docker compose up -d --build procesamiento sincronizacion
```

To start or recover the complete Compose deployment, validate the configuration
and bring all three services up:

```sh
sudo docker compose config --quiet
sudo docker compose up -d
sudo docker compose ps --all
```

The sensor acquisition services are managed independently. Check and recover
them with systemd:

```sh
sudo systemctl status estacionamiento-adquisicion-ir.service estacionamiento-adquisicion-ultrasonico.service --no-pager
sudo systemctl restart estacionamiento-adquisicion-ir.service
sudo systemctl restart estacionamiento-adquisicion-ultrasonico.service
```

If API connectivity fails, synchronization retains queued records in the
persistent `sync_data` volume and retries automatically. Check its logs and
pending count, restore connectivity, and restart `sincronizacion` if needed.
Do not remove Compose volumes when recovering: deleting `sync_data` discards
records waiting to be uploaded, and deleting `mqtt_data` removes broker
persistence.

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
