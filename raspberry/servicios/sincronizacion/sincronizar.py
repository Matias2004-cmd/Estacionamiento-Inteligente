import json
import logging
import os
import signal
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import paho.mqtt.client as mqtt

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
stopping = False
lock = threading.Lock()
config_stop_event = threading.Event()


def stop_service(_signum, _frame):
    global stopping
    stopping = True
    config_stop_event.set()


def read_secret(path):
    with open(path, encoding="utf-8") as secret_file:
        value = secret_file.read().strip()
    if not value:
        raise ValueError(f"Secret file is empty: {path}")
    return value


def main():
    signal.signal(signal.SIGTERM, stop_service)
    signal.signal(signal.SIGINT, stop_service)

    token = read_secret(os.environ["API_TOKEN_FILE"])
    bypass = read_secret(os.environ["VERCEL_BYPASS_FILE"])
    api_url = os.environ["API_URL"]
    config_url = os.environ.get(
        "DEVICE_CONFIG_URL",
        api_url.rsplit("/", 1)[0] + "/configuracion-dispositivo",
    )
    device_id = os.environ.get("DEVICE_ID", "raspberry-pi-1")
    config_topic = f"estacionamiento/config/dispositivos/{device_id}"
    config_poll_seconds = int(os.environ.get("DEVICE_CONFIG_POLL_SECONDS", "30"))
    if not 1 <= config_poll_seconds <= 3600:
        raise ValueError("DEVICE_CONFIG_POLL_SECONDS must be between 1 and 3600")
    batch_size = int(os.environ.get("BATCH_SIZE", "5"))
    max_wait = int(os.environ.get("BATCH_MAX_WAIT_SECONDS", "300"))
    if not 1 <= batch_size <= 100:
        raise ValueError("BATCH_SIZE must be between 1 and 100")
    if not 1 <= max_wait <= 86400:
        raise ValueError("BATCH_MAX_WAIT_SECONDS must be between 1 and 86400")

    outbox_path = os.environ.get(
        "OUTBOX_PATH",
        "/var/lib/estacionamiento/outbox.sqlite3",
    )
    os.makedirs(os.path.dirname(outbox_path), exist_ok=True)
    database = sqlite3.connect(outbox_path, check_same_thread=False)
    database.execute(
        """
        CREATE TABLE IF NOT EXISTS outbox (
            record_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            created_at REAL NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at REAL NOT NULL DEFAULT 0
        )
        """
    )
    database.commit()

    def on_connect(client, _userdata, _flags, reason_code, _properties):
        if reason_code == 0:
            client.subscribe(
                os.environ.get(
                    "MQTT_AGGREGATE_TOPIC",
                    "procesados/mediciones",
                ),
                qos=1,
            )
            logging.info("Subscribed to processed measurement topic")
        else:
            logging.error("MQTT connection failed: %s", reason_code)

    def on_message(_client, _userdata, message):
        try:
            payload = json.loads(message.payload)
            record_id = payload["recordId"]
            if not isinstance(record_id, str) or not record_id:
                raise ValueError("recordId is missing")
            with lock, database:
                database.execute(
                    """
                    INSERT OR IGNORE INTO outbox
                        (record_id, payload, created_at)
                    VALUES (?, ?, ?)
                    """,
                    (record_id, json.dumps(payload), time.time()),
                )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            logging.error("Could not queue aggregate: %s", error)

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="sincronizacion",
        clean_session=False,
    )
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(os.environ.get("MQTT_HOST", "mqtt"), 1883, 60)
    client.loop_start()
    logging.info("Synchronization started; outbox=%s", outbox_path)
    config_worker = threading.Thread(
        target=poll_remote_config,
        args=(
            client,
            config_url,
            config_topic,
            device_id,
            token,
            bypass,
            config_poll_seconds,
        ),
        name="remote-config-poll",
        daemon=True,
    )

    try:
        config_worker.start()
        while not stopping:
            now = time.time()
            with lock:
                rows = database.execute(
                    """
                    SELECT record_id, payload, created_at, attempts
                    FROM outbox
                    WHERE next_attempt_at <= ?
                    ORDER BY created_at
                    LIMIT ?
                    """,
                    (now, batch_size),
                ).fetchall()
                pending_count = database.execute(
                    "SELECT COUNT(*) FROM outbox WHERE next_attempt_at <= ?",
                    (now,),
                ).fetchone()[0]

            if rows and (
                pending_count >= batch_size
                or now - rows[0][2] >= max_wait
                or stopping
            ):
                send_batch(database, rows, api_url, token, bypass)
            time.sleep(2)
    finally:
        config_stop_event.set()
        config_worker.join(timeout=12)
        client.loop_stop()
        client.disconnect()
        database.close()
        logging.info("Synchronization stopped")


def poll_remote_config(
    client,
    config_url,
    config_topic,
    device_id,
    token,
    bypass,
    poll_seconds,
):
    last_config_payload = None
    while not config_stop_event.is_set():
        try:
            remote_config = fetch_device_config(
                config_url,
                device_id,
                token,
                bypass,
            )
            serialized_config = json.dumps(remote_config, sort_keys=True)
            if serialized_config != last_config_payload:
                result = client.publish(
                    config_topic,
                    serialized_config,
                    qos=1,
                    retain=True,
                )
                if result.rc == mqtt.MQTT_ERR_SUCCESS:
                    last_config_payload = serialized_config
                    logging.info("Published updated remote device configuration")
                else:
                    logging.error(
                        "Could not publish remote configuration: MQTT code %s",
                        result.rc,
                    )
        except (HTTPError, URLError, TimeoutError, RuntimeError, ValueError) as error:
            logging.error("Could not refresh remote configuration: %s", error)

        if config_stop_event.wait(poll_seconds):
            break


def fetch_device_config(config_url, device_id, token, bypass):
    request = Request(
        config_url,
        headers={
            "Authorization": f"Bearer {token}",
            "x-vercel-protection-bypass": bypass,
            "Accept": "application/json",
        },
    )
    with urlopen(request, timeout=10) as response:
        result = json.loads(response.read().decode("utf-8"))
    if response.status != 200 or not isinstance(result, dict):
        raise RuntimeError("Configuration API returned an unexpected response")
    if result.get("deviceId") != device_id:
        raise ValueError("Configuration response is for a different device")
    settings = result.get("settings")
    if (
        not isinstance(settings, dict)
        or not isinstance(settings.get("distanciaLibreCm"), (int, float))
        or isinstance(settings.get("distanciaLibreCm"), bool)
        or not 5 <= settings["distanciaLibreCm"] <= 200
        or not isinstance(settings.get("intervaloMuestreoSegundos"), (int, float))
        or isinstance(settings.get("intervaloMuestreoSegundos"), bool)
        or not 0.1 <= settings["intervaloMuestreoSegundos"] <= 3600
    ):
        raise ValueError("Device configuration response is invalid")
    return {"deviceId": device_id, **settings}


def send_batch(database, rows, api_url, token, bypass):
    records = [json.loads(row[1]) for row in rows]
    body = json.dumps({"records": records}).encode("utf-8")
    request = Request(
        api_url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "x-vercel-protection-bypass": bypass,
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
            if response.status != 201 or result.get("count") != len(rows):
                raise RuntimeError(
                    f"API returned HTTP {response.status} with an unexpected result"
                )
        with lock, database:
            database.executemany(
                "DELETE FROM outbox WHERE record_id = ?",
                [(row[0],) for row in rows],
            )
        logging.info("Uploaded batch of %s minute records", len(rows))
    except (HTTPError, URLError, TimeoutError, RuntimeError, ValueError) as error:
        logging.error("Batch upload failed; records retained locally: %s", error)
        now = time.time()
        updates = []
        for record_id, _payload, _created_at, attempts in rows:
            next_attempt = min(3600, 30 * (2 ** min(attempts, 7)))
            updates.append((attempts + 1, now + next_attempt, record_id))
        with lock, database:
            database.executemany(
                """
                UPDATE outbox
                SET attempts = ?, next_attempt_at = ?
                WHERE record_id = ?
                """,
                updates,
            )


if __name__ == "__main__":
    main()
