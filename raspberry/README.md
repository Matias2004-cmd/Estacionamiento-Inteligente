# Raspberry Pi: sensores y microservicios

Cinco contenedores orquestados con Docker Compose (ver
[docker-compose.yml](docker-compose.yml)):

| Contenedor | Archivo | Entrada → salida |
| --- | --- | --- |
| `estacionamiento-mqtt` | Mosquitto 2 | Broker local (`127.0.0.1:1883`) |
| `estacionamiento-adquisicion-ultrasonico` | [servicios/adquisicion/ultrasonico.py](servicios/adquisicion/ultrasonico.py) | HC-SR04 → `sensores/ultrasonico` |
| `estacionamiento-adquisicion-ir` | [servicios/adquisicion/ir.py](servicios/adquisicion/ir.py) | Sensor IR → `sensores/ir` |
| `estacionamiento-procesamiento` | [servicios/procesamiento/procesar.py](servicios/procesamiento/procesar.py) | `sensores/*` → `procesados/mediciones` (1 por minuto) |
| `estacionamiento-sincronizacion` | [servicios/sincronizacion/sincronizar.py](servicios/sincronizacion/sincronizar.py) | Cola SQLite → `POST /api/mediciones`; `GET /api/configuracion-dispositivo` → tópico de configuración retenido |

La imagen es `python:3.12-slim-bookworm` (multi-arquitectura ARM) con
`paho-mqtt`, `gpiozero` y `lgpio` desde wheels precompiladas. Los contenedores
de adquisición acceden al GPIO mapeando **solo** `/dev/gpiochip0` (sin
`privileged`). Se usa `gpiochip0` en vez de `/dev/gpiomem` porque `lgpio` usa la
interfaz de caracteres del kernel, que es la recomendada en Raspberry Pi OS
actual.

## Conexión del hardware

```text
HC-SR04                          Raspberry Pi (pines físicos)
  VCC  ───────────────────────── 5V        (pin 2)
  GND  ───────────────────────── GND       (pin 6)
  TRIG ───────────────────────── GPIO17    (pin 11)
  ECHO ──[ R1 1 kΩ ]──┬───────── GPIO27    (pin 13)
                      └─[ R2 2 kΩ ]── GND
       divisor: 5 V × 2k / (1k + 2k) = 3,33 V  ✔ (el GPIO tolera máx. 3,3 V)

Módulo IR de obstáculos
  VCC  ───────────────────────── 3V3       (pin 1)   ← alimentar a 3,3 V: salida ya es segura
  GND  ───────────────────────── GND       (pin 9)
  OUT  ───────────────────────── GPIO18    (pin 12)
```

**Lecturas falsas del IR:** se observaron eventos sin movimiento. Revisa, en
este orden: que el módulo esté alimentado a 3,3 V con GND común, ajusta el
potenciómetro de sensibilidad (el LED del módulo debe apagarse sin obstáculo),
evita luz solar directa y prueba `IR_PULL=up` con `IR_ACTIVE_LEVEL=0` en `.env`.
Aun con ruido, el dato útil es `ingresosConfirmados`, que solo cuenta eventos IR
seguidos de ocupación detectada por el ultrasónico.

## Instalación desde cero

Requisitos: Raspberry Pi OS 64 bits, acceso SSH y conexión a Internet.

```bash
# 1. Docker y arranque automático al encender
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker

# 2. Swap de 1 GiB (la Pi 3 tiene 1 GB de RAM; recomendado para construir la imagen)
sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
sudo systemctl restart dphys-swapfile

# 3. Código
git clone https://github.com/Matias2004-cmd/Estacionamiento-Inteligente.git ~/Estacionamiento-Inteligente
cd ~/Estacionamiento-Inteligente/raspberry
cp -n .env.example .env
nano .env                     # DEVICE_ID, DISTANCIA_LIBRE_CM, SECRETS_DIR, IR_*

# 4. Secretos (fuera del repositorio)
mkdir -p ~/.config/estacionamiento && chmod 700 ~/.config/estacionamiento
nano ~/.config/estacionamiento/api-token.txt      # token del dispositivo creado en el panel
touch ~/.config/estacionamiento/vercel-bypass.txt # vacío si Vercel no tiene Deployment Protection
chmod 600 ~/.config/estacionamiento/*.txt
```

`SECRETS_DIR` en `.env` debe apuntar a esa carpeta (por ejemplo
`/home/<usuario>/.config/estacionamiento`). `DEVICE_ID` debe ser exactamente
el ID del dispositivo creado en el panel.

```bash
# 5. Construir y levantar
sudo docker compose config --quiet
sudo docker compose up -d --build
sudo docker compose ps
```

En 1–2 minutos los cinco contenedores deben aparecer `healthy`.

### Migrar desde la versión anterior (adquisición con systemd)

Antes la adquisición corría como servicios `systemd` en el host. Ahora es un
contenedor; **detén los servicios antiguos** o ambos competirán por el GPIO:

```bash
sudo systemctl disable --now estacionamiento-adquisicion-ultrasonico.service estacionamiento-adquisicion-ir.service
sudo rm -f /etc/systemd/system/estacionamiento-adquisicion-*.service
sudo systemctl daemon-reload
cd ~/estacionamiento && git pull   # o copia la nueva carpeta raspberry/
sudo docker compose up -d --build --remove-orphans
```

La cola pendiente se conserva: el volumen `sync_data` no cambia.

## Operación

```bash
sudo docker compose ps                                     # estado y health de los 5 servicios
sudo docker compose logs -f procesamiento                  # lecturas, estado e ingresos confirmados
sudo docker compose logs --since=15m sincronizacion        # "Uploaded batch of N minute records"
sudo docker compose restart adquisicion-ultrasonico        # reiniciar un solo servicio
sudo docker compose up -d --build                          # tras cambiar código o Dockerfile

# Registros pendientes en la cola local
sudo docker compose exec sincronizacion python3 -c "import sqlite3; c=sqlite3.connect('/var/lib/estacionamiento/outbox.sqlite3'); print('registros pendientes:', c.execute('select count(*) from outbox').fetchone()[0])"

# Salud de la placa (temperatura, memoria, disco)
vcgencmd measure_temp; free -h; df -h /
```

No uses `docker compose down -v`: borra los volúmenes con la cola pendiente.

## Cómo se cumplen los requisitos

| Requisito | Implementación |
| --- | --- |
| Configuración remota sin reiniciar | `sincronizacion` consulta la API cada `DEVICE_CONFIG_POLL_SECONDS` (60 s) y publica la configuración como mensaje MQTT **retenido**; la adquisición cambia el intervalo y el procesamiento la distancia de referencia en caliente |
| Resiliencia sin duplicados | Cada agregado entra a una tabla SQLite con `record_id` como clave primaria (`INSERT OR IGNORE`); solo se borra tras `201` de la API; reintento con espera exponencial (30 s → 1 h). El ID determinista hace que un reenvío sobrescriba el mismo documento |
| Solo HTTPS saliente | La Pi no expone puertos; MQTT ligado a `127.0.0.1` y red Docker interna |
| Reinicio automático, healthcheck e inicio al encender | `restart: unless-stopped` + `systemctl enable docker`; healthcheck por latido ([salud.py](salud.py)) |
| Secretos fuera del código | Token como secreto Docker; parámetros en `.env` (ignorado por git) |
| Imágenes ARM livianas | `python:3.12-slim-bookworm`, dependencias fijadas en [requirements.txt](requirements.txt) |
| Envío por lotes | Lotes de 5 agregados (o el pendiente más antiguo tras 300 s) ⇒ 288 solicitudes/día |
