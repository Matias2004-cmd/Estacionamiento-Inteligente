import json
import logging
import os
import signal
import threading
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
stopping = False
lock = threading.Lock()
buckets = {}
state = "LIBRE"
candidate = "LIBRE"
candidate_count = 0
last_sample_ids = set()


def stop_service(_signum, _frame):
    global stopping
    stopping = True


def minute_start(timestamp):
    return int(timestamp // 60) * 60


def new_bucket(start):
    return {
        "start": start,
        "distances": [],
        "ir_events": 0,
        "estado": state,
    }


def update_state(distance, free_reference):
    global state, candidate, candidate_count
    occupied_threshold = free_reference - 5
    free_threshold = free_reference - 3

    next_candidate = state
    if state == "LIBRE" and distance < occupied_threshold:
        next_candidate = "OCUPADO"
    elif state == "OCUPADO" and distance > free_threshold:
        next_candidate = "LIBRE"

    if next_candidate == candidate:
        candidate_count += 1
    else:
        candidate = next_candidate
        candidate_count = 1

    if candidate != state and candidate_count >= 3:
        state = candidate
        logging.info("Parking state changed to %s", state)


def flush_bucket(client, current, device_id):
    if current is None:
        return
    distances = current["distances"]
    if not distances:
        logging.warning(
            "Minute %s has no valid ultrasonic samples; not aggregated",
            current["start"],
        )
        return

    start = datetime.fromtimestamp(current["start"], timezone.utc)
    average = round(sum(distances) / len(distances), 2)
    record_id = f"{device_id}_{current['start']}"
    payload = {
        "recordId": record_id,
        "sensorId": device_id,
        "periodoInicio": start.isoformat(),
        "distanciaCm": average,
        "distanciaMinCm": round(min(distances), 2),
        "distanciaMaxCm": round(max(distances), 2),
        "muestras": len(distances),
        "deteccionesIr": current["ir_events"],
        "estado": current["estado"],
    }
    result = client.publish(
        os.environ.get("MQTT_AGGREGATE_TOPIC", "procesados/mediciones"),
        json.dumps(payload),
        qos=1,
    )
    if result.rc != mqtt.MQTT_ERR_SUCCESS:
        logging.error("Could not publish minute aggregate: MQTT code %s", result.rc)
        return
    logging.info(
        "Minute aggregate published: samples=%s, average=%.2f cm, state=%s, IR events=%s",
        len(distances),
        average,
        current["estado"],
        current["ir_events"],
    )


def main():
    global stopping
    signal.signal(signal.SIGTERM, stop_service)
    signal.signal(signal.SIGINT, stop_service)

    device_id = os.environ.get("DEVICE_ID", "raspberry-pi-1")
    free_reference = float(os.environ.get("DISTANCIA_LIBRE_CM", "23"))
    if not 5 <= free_reference <= 200:
        raise ValueError("DISTANCIA_LIBRE_CM must be between 5 and 200")

    sample_topic = os.environ.get("MQTT_SAMPLE_TOPIC", "sensores/ultrasonico")
    ir_topic = os.environ.get("MQTT_IR_TOPIC", "sensores/ir")
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="procesamiento",
        clean_session=True,
    )

    def on_connect(connected_client, _userdata, _flags, reason_code, _properties):
        if reason_code == 0:
            connected_client.subscribe([(sample_topic, 1), (ir_topic, 1)])
            logging.info("Subscribed to sensor MQTT topics")
        else:
            logging.error("MQTT connection failed: %s", reason_code)

    def on_message(_client, _userdata, message):
        try:
            payload = json.loads(message.payload)
            timestamp_text = payload["timestamp"]
            timestamp = datetime.fromisoformat(
                timestamp_text.replace("Z", "+00:00")
            ).timestamp()
            start = minute_start(timestamp)
            with lock:
                current = buckets.setdefault(start, new_bucket(start))
                message_id = (
                    message.topic,
                    payload.get("sensorId"),
                    timestamp_text,
                )
                if message_id in last_sample_ids:
                    return

                if message.topic == sample_topic:
                    distance = payload.get("distanciaCm")
                    if (
                        not isinstance(distance, (int, float))
                        or isinstance(distance, bool)
                        or not 0 <= distance < 199
                    ):
                        logging.warning("Invalid ultrasonic reading ignored")
                        return
                    current["distances"].append(float(distance))
                    update_state(float(distance), free_reference)
                    current["estado"] = state
                    logging.info(
                        "Live reading: %.2f cm | State: %s",
                        float(distance),
                        state,
                    )
                elif payload.get("tipo") == "entrada":
                    current["ir_events"] += 1
                else:
                    logging.warning("Unknown MQTT message type ignored")
                    return
                last_sample_ids.add(message_id)
                if len(last_sample_ids) > 20000:
                    last_sample_ids.clear()
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            logging.warning("Invalid MQTT message ignored: %s", error)

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(os.environ.get("MQTT_HOST", "mqtt"), 1883, 60)
    client.loop_start()
    logging.info(
        "Processing started; free reference=%.1f cm; aggregation=1 minute",
        free_reference,
    )

    try:
        while not stopping:
            now_minute = minute_start(time.time())
            with lock:
                expired = sorted(start for start in buckets if start < now_minute)
                for start in expired:
                    flush_bucket(client, buckets.pop(start), device_id)
            time.sleep(1)
    finally:
        with lock:
            for start in sorted(buckets):
                flush_bucket(client, buckets[start], device_id)
        client.loop_stop()
        client.disconnect()
        logging.info("Processing stopped")


if __name__ == "__main__":
    main()
