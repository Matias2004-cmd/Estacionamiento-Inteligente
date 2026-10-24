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
    sensor_id = os.environ.get(
        "SENSOR_ID",
        os.environ.get("DEVICE_ID", "raspberry-pi-1"),
    )
    device_id = os.environ.get("DEVICE_ID", sensor_id)
    interval = float(os.environ.get("SAMPLE_INTERVAL_SECONDS", "5"))
    if not 0.1 <= interval <= 3600:
        raise ValueError("SAMPLE_INTERVAL_SECONDS must be between 0.1 and 3600")
    settings = {"intervaloMuestreoSegundos": interval}
    settings_lock = threading.Lock()
    config_changed = threading.Event()
    config_topic = f"estacionamiento/config/dispositivos/{device_id}"

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="adquisicion-ultrasonico",
    )

    def on_connect(connected_client, _userdata, _flags, reason_code, _properties):
        if reason_code == 0:
            connected_client.subscribe(config_topic, qos=1)
            logging.info("Subscribed to remote device configuration")
        else:
            logging.error("MQTT connection failed: %s", reason_code)

    def on_message(_client, _userdata, message):
        try:
            payload = json.loads(message.payload)
            new_interval = payload.get("intervaloMuestreoSegundos")
            if (
                not isinstance(new_interval, (int, float))
                or isinstance(new_interval, bool)
                or not 0.1 <= new_interval <= 3600
            ):
                raise ValueError("Invalid remote sampling interval")
            with settings_lock:
                settings["intervaloMuestreoSegundos"] = float(new_interval)
            config_changed.set()
            logging.info("Remote sampling interval updated to %s s", new_interval)
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
    logging.info("Ultrasonic acquisition started; interval=%s s", interval)

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

            heartbeat()
            with settings_lock:
                interval = settings["intervaloMuestreoSegundos"]
            # Espera en tramos cortos para mantener el latido con intervalos largos;
            # un cambio de configuración interrumpe la espera de inmediato.
            deadline = time.monotonic() + interval
            while not stopping:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or config_changed.wait(min(remaining, 10)):
                    break
                heartbeat()
            config_changed.clear()
    finally:
        sensor.close()
        client.loop_stop()
        client.disconnect()
        logging.info("Ultrasonic acquisition stopped")


if __name__ == "__main__":
    main()
