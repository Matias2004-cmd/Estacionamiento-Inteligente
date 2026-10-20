import json
import logging
import os
import signal
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
from gpiozero import DistanceSensor
from gpiozero.exc import DistanceSensorNoEcho

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
    sensor_id = os.environ.get("SENSOR_ID", "puesto-1")
    interval = float(os.environ.get("SAMPLE_INTERVAL_SECONDS", "5"))
    if not 0.1 <= interval <= 3600:
        raise ValueError("SAMPLE_INTERVAL_SECONDS must be between 0.1 and 3600")

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="adquisicion-ultrasonico",
    )
    client.connect(host, 1883, 60)
    client.loop_start()

    sensor = DistanceSensor(
        echo=int(os.environ.get("ECHO_GPIO", "27")),
        trigger=int(os.environ.get("TRIGGER_GPIO", "17")),
        max_distance=float(os.environ.get("MAX_DISTANCE_M", "2")),
        queue_len=1,
    )
    logging.info("Ultrasonic acquisition started; interval=%s s", interval)
    deadline = time.monotonic()

    try:
        while not stopping:
            deadline += interval
            timestamp = datetime.now(timezone.utc).isoformat()
            try:
                distance_cm = sensor.distance * 100
                payload = {
                    "sensorId": sensor_id,
                    "timestamp": timestamp,
                    "distanciaCm": round(distance_cm, 2),
                }
                result = client.publish(
                    "sensores/ultrasonico",
                    json.dumps(payload),
                    qos=1,
                )
                if result.rc != mqtt.MQTT_ERR_SUCCESS:
                    logging.warning("MQTT publish failed with code %s", result.rc)
                else:
                    logging.info("Sample published: %.2f cm", distance_cm)
            except DistanceSensorNoEcho:
                logging.warning("No echo received; invalid sample skipped")

            time.sleep(max(0, deadline - time.monotonic()))
    finally:
        sensor.close()
        client.loop_stop()
        client.disconnect()
        logging.info("Ultrasonic acquisition stopped")


if __name__ == "__main__":
    main()

