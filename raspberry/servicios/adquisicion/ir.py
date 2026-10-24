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
    if active_level not in (0, 1):
        raise ValueError("IR_ACTIVE_LEVEL must be 0 or 1")
    if not 0 <= debounce_seconds <= 2:
        raise ValueError("IR_DEBOUNCE_SECONDS must be between 0 and 2")

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="adquisicion-ir",
    )
    client.connect(host, 1883, 60)
    client.loop_start()

    sensor = DigitalInputDevice(
        pin=pin,
        pull_up=None,
        active_state=bool(active_level),
    )
    stable_active = sensor.is_active
    candidate_active = stable_active
    candidate_since = time.monotonic()
    logging.info(
        "IR acquisition started on GPIO%s; active level=%s",
        pin,
        active_level,
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
            time.sleep(0.02)
    finally:
        sensor.close()
        client.loop_stop()
        client.disconnect()
        logging.info("IR acquisition stopped")


if __name__ == "__main__":
    main()
