import json
import logging
import os
import signal
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
from gpiozero import DigitalInputDevice

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
stopping = False

HEARTBEAT_FILE = os.environ.get("HEARTBEAT_FILE", "/tmp/latido")
last_heartbeat = 0.0


def heartbeat():
    """Actualiza el archivo que revisa el healthcheck (como máximo cada 10 s)."""
    global last_heartbeat
    now = time.monotonic()
    if now - last_heartbeat >= 10:
        with open(HEARTBEAT_FILE, "w", encoding="utf-8") as heartbeat_file:
            heartbeat_file.write(str(time.time()))
        last_heartbeat = now


def stop_service(_signum, _frame):
    global stopping
    stopping = True


def main():
    signal.signal(signal.SIGTERM, stop_service)
    signal.signal(signal.SIGINT, stop_service)

    host = os.environ.get("MQTT_HOST", "mqtt")
    sensor_id = os.environ.get("SENSOR_ID", "entrada-ir-1")
    pin = int(os.environ.get("IR_GPIO", "18"))
    active_level = int(os.environ.get("IR_ACTIVE_LEVEL", "0"))
    debounce_seconds = float(os.environ.get("IR_DEBOUNCE_SECONDS", "0.15"))
    pull = os.environ.get("IR_PULL", "none").lower()
    if active_level not in (0, 1):
        raise ValueError("IR_ACTIVE_LEVEL must be 0 or 1")
    if not 0 <= debounce_seconds <= 2:
        raise ValueError("IR_DEBOUNCE_SECONDS must be between 0 and 2")
    # "up" activa la resistencia interna de pull-up (salida activa en bajo) y
    # "down" la de pull-down (activa en alto); evitan lecturas falsas si el pin flota.
    if pull not in ("none", "up", "down"):
        raise ValueError("IR_PULL must be none, up or down")
    if (pull == "up" and active_level != 0) or (pull == "down" and active_level != 1):
        raise ValueError("IR_PULL=up requires IR_ACTIVE_LEVEL=0; IR_PULL=down requires 1")

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="adquisicion-ir",
    )
    client.connect(host, 1883, 60)
    client.loop_start()

    if pull == "none":
        sensor = DigitalInputDevice(
            pin=pin,
            pull_up=None,
            active_state=bool(active_level),
        )
    else:
        sensor = DigitalInputDevice(pin=pin, pull_up=pull == "up")
    stable_active = sensor.is_active
    candidate_active = stable_active
    candidate_since = time.monotonic()
    logging.info(
        "IR acquisition started on GPIO%s; active level=%s; pull=%s",
        pin,
        active_level,
        pull,
    )

    try:
        while not stopping:
            now = time.monotonic()
            raw_active = sensor.is_active
            if raw_active != candidate_active:
                candidate_active = raw_active
                candidate_since = now
            elif (
                candidate_active != stable_active
                and now - candidate_since >= debounce_seconds
            ):
                became_active = candidate_active and not stable_active
                stable_active = candidate_active
                if became_active:
                    payload = {
                        "sensorId": sensor_id,
                        "tipo": "entrada",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    result = client.publish(
                        "sensores/ir",
                        json.dumps(payload),
                        qos=1,
                    )
                    if result.rc != mqtt.MQTT_ERR_SUCCESS:
                        logging.warning(
                            "MQTT publish failed with code %s",
                            result.rc,
                        )
                    else:
                        logging.info("IR entry event published")
            heartbeat()
            time.sleep(0.02)
    finally:
        sensor.close()
        client.loop_stop()
        client.disconnect()
        logging.info("IR acquisition stopped")


if __name__ == "__main__":
    main()
