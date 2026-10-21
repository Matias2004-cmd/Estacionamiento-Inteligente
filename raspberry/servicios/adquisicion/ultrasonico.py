import json
import logging
import os
import signal
import threading
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
interval_lock = threading.Lock()
wake_event = threading.Event()
sample_interval = 5.0


def stop_service(_signum, _frame):
    global stopping
    stopping = True
    wake_event.set()


def main():
    global sample_interval
    signal.signal(signal.SIGTERM, stop_service)
    signal.signal(signal.SIGINT, stop_service)

    host = os.environ.get("MQTT_HOST", "mqtt")
    sensor_id = os.environ.get("SENSOR_ID", "puesto-1")
    sample_interval = float(os.environ.get("SAMPLE_INTERVAL_SECONDS", "5"))
    if not 0.1 <= sample_interval <= 3600:
        raise ValueError("SAMPLE_INTERVAL_SECONDS must be between 0.1 and 3600")
    config_topic = f"configuracion/{os.environ.get('DEVICE_ID', 'raspberry-pi-1')}"

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="adquisicion-ultrasonico",
    )

    def on_connect(connected_client, _userdata, _flags, reason_code, _properties):
        if reason_code == 0:
            connected_client.subscribe(config_topic, qos=1)
        else:
            logging.error("MQTT connection failed: %s", reason_code)

    def on_message(_client, _userdata, message):
        global sample_interval
        if message.topic != config_topic:
            return
        try:
            payload = json.loads(message.payload)
            if not isinstance(payload, dict):
                logging.warning("Invalid remote configuration ignored")
                return
            interval = payload.get("sampleIntervalSeconds")
            if interval is None:
                return
            if (
                not isinstance(interval, (int, float))
                or isinstance(interval, bool)
                or not 0.1 <= interval <= 3600
            ):
                logging.warning("Invalid remote sampling interval ignored")
                return
            with interval_lock:
                sample_interval = float(interval)
            wake_event.set()
            logging.info(
                "Remote ultrasonic sampling interval applied: %.1f s",
                sample_interval,
            )
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            logging.warning("Invalid remote configuration ignored: %s", error)

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(host, 1883, 60)
    client.loop_start()

    sensor = DistanceSensor(
        echo=int(os.environ.get("ECHO_GPIO", "27")),
        trigger=int(os.environ.get("TRIGGER_GPIO", "17")),
        max_distance=float(os.environ.get("MAX_DISTANCE_M", "2")),
        queue_len=1,
    )
    logging.info("Ultrasonic acquisition started; interval=%s s", sample_interval)

    try:
        while not stopping:
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

            with interval_lock:
                deadline = time.monotonic() + sample_interval
            while not stopping:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                if wake_event.wait(remaining):
                    wake_event.clear()
                    with interval_lock:
                        deadline = time.monotonic() + sample_interval
    finally:
        sensor.close()
        client.loop_stop()
        client.disconnect()
        logging.info("Ultrasonic acquisition stopped")


if __name__ == "__main__":
    main()
