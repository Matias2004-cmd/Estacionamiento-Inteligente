# Recolección de datos en Raspberry Pi

El despliegue sigue el flujo de microservicios del proyecto:

- La adquisición ultrasónica e infrarroja se ejecuta como servicios `systemd`
  en la Raspberry Pi y publica lecturas y eventos en el broker MQTT local.
- El procesamiento valida las lecturas y genera un agregado por minuto.
- La sincronización envía hasta cinco registros por solicitud a la API.
- Los envíos fallidos permanecen en una cola SQLite persistente y se reintentan.

Docker Compose ejecuta estos tres servicios en la Raspberry Pi:
`mqtt` (broker), `procesamiento` (agregación) y `sincronizacion` (envío de
lotes a la API). Los dos programas de adquisición GPIO siguen siendo servicios
`systemd` independientes porque necesitan acceso directo al hardware GPIO de
la Pi; no son servicios adicionales de Compose.

El intervalo predeterminado de muestreo ultrasónico se puede configurar y está
establecido en 5 segundos. Esto permite obtener hasta 12 lecturas ultrasónicas
por minuto y 1.440 documentos agregados en Firestore por día. Los lotes de cinco
registros representan normalmente unas 288 solicitudes a la API por día. El
sensor IR aporta el conteo de eventos al agregado por minuto.

## Configuración

En la Raspberry Pi, copia `.env.example` a `.env`. Configura
`DISTANCIA_LIBRE_CM` con la distancia medida cuando el espacio está vacío.
Establece `IR_ACTIVE_LEVEL` en `0` o `1`, según el valor de salida comprobado
del módulo IR cuando un objeto bloquea el sensor. Guarda los dos archivos con
secretos fuera de esta carpeta:

- `/home/matiascatalan/.config/estacionamiento/api-token.txt`
- `/home/matiascatalan/.config/estacionamiento/vercel-bypass.txt`

Docker Compose monta esos archivos como secretos durante la ejecución; sus
valores no se guardan en este proyecto ni en la imagen del contenedor.

Para vincular esta Raspberry con una organización, crea un dispositivo
ultrasónico desde el panel privado como administrador. Copia la credencial que
se muestra una sola vez al archivo local
`/home/matiascatalan/.config/estacionamiento/api-token.txt`; este archivo queda
montado como secreto `api_token`. El `DEVICE_ID` de `.env` debe coincidir
exactamente con el ID indicado al crear el dispositivo en el panel. El token
legado de demostración solo escribe en la colección pública. La credencial
creada desde el panel escribe en la organización y, solo si el administrador
marcó el dispositivo como **demo público**, también publica una copia en la
vista pública.

La sincronización consulta los ajustes del dispositivo cada
`DEVICE_CONFIG_POLL_SECONDS` (30 segundos por defecto) y publica los cambios
como mensaje MQTT retenido. El procesador aplica la nueva distancia de
referencia y la adquisición ultrasónica aplica el intervalo de muestreo.
El sondeo se ejecuta en un hilo independiente, por lo que las llamadas a la
API de configuración no bloquean el envío normal de lotes. Los cambios que
realices en la configuración del dispositivo desde el panel privado se
aplican sin reiniciar la Raspberry ni sus servicios. Esta integración usa la
credencial del dispositivo y queda aislada de los endpoints globales heredados
de configuración.

Después de cambiar `DEVICE_ID` o actualizar las unidades de `systemd`, reinicia
los servicios para que tomen la configuración:

```sh
sudo install -m 0644 systemd/estacionamiento-adquisicion-ultrasonico.service /etc/systemd/system/
sudo install -m 0644 systemd/estacionamiento-adquisicion-ir.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart estacionamiento-adquisicion-ultrasonico.service
sudo docker compose up -d --build procesamiento sincronizacion
```

Las alertas de ocupación/distancia y falta de lecturas recientes se muestran en
el panel privado de la organización; no se envían por correo.

## Instalación y pruebas iniciales

Ejecuta estos comandos en la Pi desde
`/home/matiascatalan/estacionamiento`:

```sh
unzip -o ~/estacionamiento-raspberry.zip -d ~/estacionamiento
cp -n .env.example .env
nano .env
sudo apt update
sudo apt install -y python3-gpiozero python3-lgpio python3-paho-mqtt
python3 -c "import gpiozero, lgpio, paho.mqtt.client; print('Dependencias GPIO y MQTT listas')"
docker compose config --quiet
sudo docker compose build
sudo docker compose up -d mqtt procesamiento sincronizacion
```

La adquisición GPIO se ejecuta en el sistema anfitrión de la Pi, porque los
paquetes GPIO verificados por el sistema proporcionan acceso a
`/dev/gpiochip0`. Instala e inicia las unidades de `systemd`:

```sh
sudo install -m 0644 systemd/estacionamiento-adquisicion-ultrasonico.service /etc/systemd/system/
sudo install -m 0644 systemd/estacionamiento-adquisicion-ir.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now estacionamiento-adquisicion-ultrasonico.service estacionamiento-adquisicion-ir.service
sudo systemctl status estacionamiento-adquisicion-ultrasonico.service estacionamiento-adquisicion-ir.service --no-pager
```

Revisa los registros de los sensores:

```sh
sudo journalctl -u estacionamiento-adquisicion-ultrasonico.service -n 30 --no-pager
```

Bloquea y desbloquea el sensor IR una vez. Confirma que se registre un evento
cuando el objeto bloquee el sensor. Si el evento se registra al retirar el
objeto, cambia `IR_ACTIVE_LEVEL` en `.env` de `0` a `1` (o viceversa) y reinicia
el servicio:

```sh
sudo systemctl restart estacionamiento-adquisicion-ir.service
```

Confirma que aparezcan lecturas de distancia y luego comprueba los tres
servicios de Compose:

```sh
sudo docker compose ps --all
sudo docker compose logs --tail=50 mqtt procesamiento sincronizacion
```

`docker compose ps --all` debe mostrar
`estacionamiento-mqtt`, `estacionamiento-procesamiento` y
`estacionamiento-sincronizacion` en ejecución. El broker debe aparecer como
`healthy` (saludable); las comprobaciones de los trabajadores verifican que
cada contenedor pueda conectarse al broker. Confirma el flujo de datos en los
registros: procesamiento debe mostrar lecturas en tiempo real y agregados por
minuto; sincronización debe mostrar `Uploaded batch of ... minute records`
(lote de ... registros por minuto enviado).

En un plazo de cinco minutos, sincronización debería enviar un lote y Firestore
debería contener agregados por minuto. La solicitud incluye el token de la API;
el bypass de Vercel usa su encabezado específico. Comprueba la cola persistente
de reintentos:

```sh
sudo docker compose exec sincronizacion python3 -c "import sqlite3; c=sqlite3.connect('/var/lib/estacionamiento/outbox.sqlite3'); print('registros pendientes:', c.execute('select count(*) from outbox').fetchone()[0])"
```

Si la conectividad funciona, lo esperado es que la cola de reintentos esté
vacía. No comiences la medición de siete días hasta que estas comprobaciones
sean satisfactorias.

## Estado y recuperación de los servicios

Los contenedores de Compose usan `restart: unless-stopped` y los servicios
GPIO de `systemd` usan `Restart=on-failure`. Se reinician después de un fallo o
del reinicio de la Pi, salvo que se hayan detenido explícitamente.

Ejecuta estos comandos desde la carpeta del despliegue en la Pi para comprobar
los tres contenedores y seguir sus registros:

```sh
sudo docker compose ps --all
sudo docker compose logs --tail=100 mqtt procesamiento sincronizacion
sudo docker compose logs --follow procesamiento sincronizacion
```

Si un servicio está detenido o no está saludable, primero revisa sus registros
y luego reinicia únicamente ese servicio:

```sh
sudo docker compose restart mqtt
sudo docker compose restart procesamiento
sudo docker compose restart sincronizacion
```

Después de modificar el código de la aplicación o el Dockerfile, vuelve a
generar la imagen y recrea el trabajador afectado:

```sh
sudo docker compose up -d --build procesamiento sincronizacion
```

Para iniciar o recuperar todo el despliegue de Compose, valida la configuración
y levanta los tres servicios:

```sh
sudo docker compose config --quiet
sudo docker compose up -d
sudo docker compose ps --all
```

Los servicios de adquisición de los sensores se administran por separado.
Comprueba su estado y recupéralos con `systemd`:

```sh
sudo systemctl status estacionamiento-adquisicion-ir.service estacionamiento-adquisicion-ultrasonico.service --no-pager
sudo systemctl restart estacionamiento-adquisicion-ir.service
sudo systemctl restart estacionamiento-adquisicion-ultrasonico.service
```

Si falla la conexión con la API, sincronización conserva los registros
pendientes en el volumen persistente `sync_data` y los reintenta
automáticamente. Revisa sus registros y el número de registros pendientes,
restablece la conexión y, si hace falta, reinicia `sincronizacion`. No elimines
los volúmenes de Compose durante la recuperación: borrar `sync_data` descarta
los registros pendientes de envío y borrar `mqtt_data` elimina la persistencia
del broker.

Cuando las comprobaciones de los sensores y de los envíos sean satisfactorias,
anota la hora de inicio y comprueba los servicios en ejecución:

```sh
sudo docker compose ps
sudo systemctl is-active estacionamiento-adquisicion-ultrasonico.service
date -Is
```

Para completar la medición continua requerida, mantén la Pi encendida,
conectada a la red y en funcionamiento durante al menos siete días. Revisa la
colección `mediciones` de Firestore y compara su uso con las estimaciones
anteriores.
