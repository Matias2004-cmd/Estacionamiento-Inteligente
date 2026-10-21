# Recolección de datos con Raspberry Pi

El despliegue sigue el flujo de microservicios del proyecto:

- La adquisición ultrasónica y la de infrarrojo (IR) se ejecutan como
  servicios `systemd` en la Raspberry Pi y publican lecturas y eventos en el
  broker MQTT local.
- El servicio de procesamiento valida las lecturas y genera un agregado por
  minuto.
- El servicio de sincronización envía hasta cinco registros por solicitud a
  la API.
- Si falla el envío, los registros permanecen en una cola SQLite persistente
  y se reintentan.

El intervalo de muestreo ultrasónico se puede configurar y su valor inicial es
de 5 segundos. Esto permite obtener hasta 12 lecturas ultrasónicas por minuto
y guardar 1.440 documentos agregados en Firestore por día. Los lotes de cinco
registros representan normalmente unas 288 solicitudes a la API por día. El
sensor IR está detenido porque produjo activaciones falsas; sus eventos no
deben considerarse mediciones válidas.

## Configuración

Copia `.env.example` como `.env` en la Raspberry Pi. Configura
`DISTANCIA_LIBRE_CM` con la distancia medida cuando el espacio está vacío.
Configura `IR_ACTIVE_LEVEL` en `0` o `1`, según el valor de salida previamente
comprobado en el módulo IR cuando un objeto bloquea el sensor. No guardes los
archivos secretos dentro de esta carpeta:

- `/home/matiascatalan/.config/estacionamiento/api-token.txt`
- `/home/matiascatalan/.config/estacionamiento/vercel-bypass.txt`

Docker Compose monta esos archivos como secretos durante la ejecución. Sus
valores no se guardan en este proyecto ni en la imagen del contenedor.

## Configuración remota del dispositivo

Configura `ADMIN_API_TOKEN` como una variable de entorno protegida en Vercel y
despliega la API. En el panel web, ingresa ese token y el identificador del
dispositivo (`raspberry-pi-1` de forma predeterminada). Luego puedes cambiar la
distancia medida del espacio vacío y/o el intervalo de muestreo ultrasónico.
El navegador envía el token únicamente con la solicitud de configuración y no
lo almacena.

El servicio de sincronización consulta el endpoint de configuración cada 60
segundos con el `API_TOKEN` del dispositivo. Publica los cambios en el tópico
MQTT retenido `configuracion/<device-id>`. El servicio de procesamiento
actualiza el umbral de espacio libre y el servicio `systemd` ultrasónico
actualiza su intervalo de muestreo sin reiniciarse. La persistencia de
Mosquitto conserva los últimos valores disponibles si se reinicia el broker.
Los rangos válidos son de 5 a 200 cm y de 0,1 a 3.600 segundos.

Los valores del archivo `.env` de la Raspberry siguen siendo los valores
iniciales hasta que se guarde una configuración remota para ese dispositivo.
Actualizar el código fuente o los secretos todavía requiere el procedimiento
habitual de despliegue o reinicio; los cambios realizados desde el panel no.

## Instalación y pruebas básicas

Ejecuta estos comandos en la Raspberry Pi, desde
`/home/matiascatalan/estacionamiento`:

```sh
unzip -o ~/estacionamiento-raspberry.zip -d ~/estacionamiento
cp -n .env.example .env
nano .env
sudo apt update
sudo apt install -y python3-gpiozero python3-lgpio python3-paho-mqtt
python3 -c "import gpiozero, lgpio, paho.mqtt.client; print('GPIO y dependencias MQTT listas')"
docker compose config --quiet
sudo docker compose build
sudo docker compose up -d mqtt procesamiento sincronizacion
```

La adquisición por GPIO se ejecuta en el sistema operativo de la Raspberry,
porque los paquetes GPIO verificados mediante firma del sistema permiten
acceder a `/dev/gpiochip0`. Instala e inicia las unidades `systemd`:

```sh
sudo install -m 0644 systemd/estacionamiento-adquisicion-ultrasonico.service /etc/systemd/system/
sudo install -m 0644 systemd/estacionamiento-adquisicion-ir.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now estacionamiento-adquisicion-ultrasonico.service estacionamiento-adquisicion-ir.service
sudo systemctl status estacionamiento-adquisicion-ultrasonico.service estacionamiento-adquisicion-ir.service --no-pager
```

Consulta los registros de adquisición ultrasónica:

```sh
sudo journalctl -u estacionamiento-adquisicion-ultrasonico.service -n 30 --no-pager
```

El servicio IR se mantiene detenido: en las pruebas generó activaciones
repetidas sin movimiento y esos eventos no son confiables. No lo inicies ni
incluyas sus registros como mediciones válidas sin haber corregido y vuelto a
validar el sensor.

Comprueba que aparezcan lecturas de distancia y revisa el procesamiento y la
sincronización:

```sh
sudo docker compose ps
sudo docker compose logs --tail=50 procesamiento sincronizacion
```

En un plazo de cinco minutos, el servicio de sincronización debería subir un
lote y Firestore debería contener agregados por minuto. El token de la API se
envía en el encabezado de autorización y el acceso protegido de Vercel usa su
encabezado específico. Comprueba la cola persistente de reintentos:

```sh
sudo docker compose exec sincronizacion python3 -c "import sqlite3; c=sqlite3.connect('/var/lib/estacionamiento/outbox.sqlite3'); print('registros pendientes:', c.execute('select count(*) from outbox').fetchone()[0])"
```

Si la conexión funciona, se espera que la cola de reintentos esté vacía. No
inicies la medición de siete días hasta que estas comprobaciones sean
satisfactorias.

Cuando las comprobaciones de los sensores y del envío hayan terminado, anota
la hora de inicio y revisa los servicios activos:

```sh
sudo docker compose ps
sudo systemctl is-active estacionamiento-adquisicion-ultrasonico.service
date -Is
```

Para cumplir con la medición continua requerida, mantén la Raspberry
encendida, conectada a la red y en funcionamiento durante al menos siete días.
Revisa la colección `mediciones` de Firestore y compara su uso con las
estimaciones anteriores.
