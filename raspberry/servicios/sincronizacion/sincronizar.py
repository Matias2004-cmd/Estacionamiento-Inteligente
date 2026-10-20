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


def stop_service(_signum, _frame):
    global stopping
    stopping = True


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

    try:
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
        client.loop_stop()
        client.disconnect()
        database.close()
        logging.info("Synchronization stopped")


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

