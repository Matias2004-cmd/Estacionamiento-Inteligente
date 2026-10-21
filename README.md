# Bitacora de recoleccion - Solemne 1

**Fecha documentada:** 15 de octubre de 2026  
**Proyecto:** estacionamiento inteligente con Raspberry Pi, MQTT y Firestore  
**Proposito:** conservar una descripcion verificable del trabajo realizado hoy y servir de insumo para el informe o la presentacion. Esta bitacora no reemplaza el informe final ni demuestra por si sola siete dias completos de operacion.

## Periodo de recoleccion declarado

- **Inicio declarado:** 15 de octubre de 2026, 18:35 (UTC-3, hora de Chile continental).
- **Fin de siete dias:** 22 de octubre de 2026, 18:35 (UTC-3), siempre que la adquisicion se mantenga durante todo el periodo.
- **Alcance de los datos:** recoleccion ultrasónica. El IR sigue detenido y sus lecturas no se consideran validas.
- **Verificacion:** este horario registra el inicio indicado por el usuario; no confirma por si mismo que los servicios permanecieran activos desde ese minuto. Si la adquisicion efectiva comenzo despues, anotar la hora real y calcular el fin siete dias despues. Registrar reinicios, cortes y pausas; no presentar un periodo con interrupciones como siete dias continuos.

## Resumen

Se puso en marcha una ruta de adquisicion y almacenamiento para medir la distancia de un puesto, clasificarlo como `LIBRE` u `OCUPADO`, resumir las lecturas por minuto y enviar los resumenes a Firestore mediante una API desplegada en Vercel. Se comprobo que Firestore contiene documentos reales de esta ruta.

La captura en vivo mostro lecturas de aproximadamente 25 cm con el espacio despejado (`LIBRE`) y lecturas menores al acercar un objeto (`OCUPADO`). Tambien se observaron agregados por minuto con 12 muestras. El IR produjo eventos repetidos aun cuando el usuario indico que nada se movia frente al sensor; por eso se detuvo y sus conteos no deben tratarse como mediciones validas. El periodo de recoleccion de siete dias se declara iniciado el 15 de octubre de 2026 a las 18:35 (UTC-3), solo para la adquisicion ultrasónica.

Hubo al menos una interrupcion por apagado de la Raspberry y pausas para depurar antes del periodo de recoleccion declarado. Por tanto, **los siete dias continuos aun no quedan acreditados**: deben completarse desde el inicio declarado o desde la hora real de inicio si fue posterior, registrando cualquier interrupcion.

## Arquitectura que se probo

```text
HC-SR04 (GPIO17 TRIG, GPIO27 ECHO)
    -> servicio de adquisicion en Raspberry Pi (systemd)
    -> MQTT local (Mosquitto en Docker, puerto ligado a 127.0.0.1:1883)
    -> procesamiento en Docker (estabilizacion y agregado por minuto)
    -> sincronizacion en Docker (cola SQLite y lotes HTTPS)
    -> API propia en Vercel
    -> Cloud Firestore / coleccion mediciones
```

El programa IR se configuro en GPIO18 (pin fisico 12), pero al publicar eventos sin movimiento se dejo detenido. No se deben usar esos eventos como conteos de entradas.

### Parametros y procesamiento observados

- Intervalo ultrasónico configurado: **5 segundos**.
- Maximo esperado en condiciones normales: **12 lecturas por minuto**.
- Referencia de espacio libre configurada: **23 cm**.
- Histéresis: el umbral de ocupado es 5 cm por debajo de la referencia (18 cm); el de libre es 3 cm por debajo (20 cm). Se requieren varias lecturas consecutivas para confirmar un cambio y evitar oscilaciones por ruido.
- El procesador valida las lecturas y calcula promedio, minimo, maximo, cantidad de muestras, estado y cantidad de eventos IR recibidos para cada minuto.
- La vista de logs en vivo mostro distancia y estado aproximadamente cada cinco segundos. `Ctrl+C` cierra esa vista, no detiene por si mismo los servicios.
- El servicio de sincronizacion conserva pendientes en una base SQLite persistente y los reintenta. En esta configuracion forma lotes de hasta cinco registros y tambien envia los pendientes cuando vencen los tiempos de espera configurados.

## Evidencia observada el 15 de octubre

1. El `docker compose build` termino correctamente despues de quitar del Dockerfile la instalacion desde el repositorio Raspberry Pi que Debian rechazaba por su firma. No se desactivo la verificacion de firmas.
2. Se confirmaron importables en la Pi `gpiozero`, `lgpio` y `paho-mqtt`.
3. Los servicios MQTT, procesamiento y sincronizacion aparecieron `healthy`; el servicio ultrasónico aparecio `active`.
4. En logs de procesamiento se vieron lecturas en vivo y cambios `LIBRE`/`OCUPADO` al mover un objeto de prueba frente al HC-SR04.
5. Se vio en Firestore un documento de `mediciones` con `distanciaCm`, `estado`, `muestras`, `periodoInicio`, minimos y maximos. Un ejemplo visible fue un resumen del periodo de las 18:20 con distancia media de 25.32 cm, estado `LIBRE` y 12 muestras.
6. Los logs de sincronizacion mostraron mensajes `Uploaded batch of 5 minute records` y `Uploaded batch of 4 minute records`. Otro lote de cinco registros se confirmo en logs a las 21:21 UTC (18:21 en UTC-3).
7. Antes de reanudar el flujo se eliminaron, con autorizacion, cinco registros especificos de la cola local que correspondian a pruebas antiguas. Esto **no borro** documentos que ya se hubieran enviado a Firestore.
8. En una prueba controlada, el IR publico eventos cada pocos segundos mientras el usuario confirmo que no movia nada frente al sensor. Se detuvo para no confiar en esos conteos. Los documentos con `deteccionesIr` de ese intervalo pueden contener eventos falsos.
9. La Raspberry se apago accidentalmente y luego volvio a arrancar. Los documentos que ya estaban en Firestore permanecieron; el intervalo apagado no tiene lecturas y es una interrupcion de la captura.

Los relojes de algunos logs de contenedores aparecen en UTC. Para compararlos con la hora local de Chile continental usada en las capturas de Firebase, convertir UTC a UTC-3 en la fecha de esta bitacora.

## Modelo de los documentos en Firestore

Coleccion: `mediciones`. Los documentos agregados usan un identificador estable por dispositivo y minuto para que los reintentos no creen duplicados. Los campos observados o previstos en cada resumen son:

| Campo | Significado |
| --- | --- |
| `recordId` / ID de documento | Identificador idempotente del dispositivo y minuto |
| `sensorId` | Identificador del dispositivo, por ejemplo `raspberry-pi-1` |
| `periodoInicio` | Inicio del minuto resumido |
| `distanciaCm` | Distancia promedio del minuto |
| `distanciaMinCm`, `distanciaMaxCm` | Extremos de las muestras validas del minuto |
| `muestras` | Numero de muestras ultrasónicas incluidas |
| `estado` | Estado estabilizado: `LIBRE` u `OCUPADO` |
| `deteccionesIr` | Eventos IR recibidos durante ese minuto; no confiable durante la prueba descrita |
| `timestamp` | Hora de escritura del documento |

La base no guarda un documento por cada lectura de cinco segundos: guarda un resumen por minuto. Si operara sin interrupciones durante una semana, el orden de magnitud esperado seria **10.080 documentos** (1.440 por dia). Es una estimacion; el resultado real debe calcularse usando los documentos y metricas efectivamente registrados.

## Plataforma web

URL publica: https://solemne-1-ti.vercel.app

`index.html` es el panel publico del proyecto. Consulta los agregados recientes y permite filtrar historicos por fecha y hora. Muestra estado, distancia promedio, cantidad de muestras y una grafica. La consulta empieza con 100 resultados y el boton **Cargar mas resultados** obtiene paginas siguientes hasta completar el rango elegido. La API permite lectura publica y de solo lectura; las escrituras desde la Raspberry requieren `API_TOKEN`. `FIREBASE_SERVICE_ACCOUNT_JSON` debe mantenerse como variable de entorno protegida en Vercel.

El usuario confirmo que el panel publico carga datos reales de Firestore en produccion el 20 de octubre de 2026. La version verificada mostro los 100 agregados mas recientes. La paginacion del historico se incorporo despues; confirmar que la ultima implementacion de Vercel este en estado `Ready` antes de afirmar que esa version esta publicada.

### Endpoints de la API

| Metodo y ruta | Acceso | Funcion |
| --- | --- | --- |
| `GET /api/configuracion?deviceId=<id>` | Token del dispositivo (`API_TOKEN`) | Recupera la configuracion remota del dispositivo sin cache. |
| `POST /api/configuracion` | Token administrativo (`ADMIN_API_TOKEN`) | Actualiza parcialmente distancia libre (5–200 cm) y/o intervalo de muestreo (0.1–3600 s) en `configuracion_dispositivos`. |

La seccion **Configuracion remota del dispositivo** del panel aplica los parametros sin reiniciar. Configura `ADMIN_API_TOKEN` como variable de entorno protegida en Vercel y despliega la API. La Raspberry consulta la configuracion cada 60 segundos con su `API_TOKEN`; el servicio de sincronizacion la publica como mensaje MQTT retenido y los servicios de adquisicion/procesamiento actualizan sus valores activos. El intervalo y la referencia de distancia siguen vigentes despues de reinicios. El panel solicita el token administrativo al enviar el cambio, no lo guarda en el navegador; introducelo solo en una conexion HTTPS confiable y rotalo si se expone.

Los ajustes de arranque de `.env` siguen siendo los valores iniciales y aplican hasta que exista una configuracion remota para el dispositivo. La configuracion remota solo soporta el sensor ultrasonico: no habilita ni modifica el sensor IR.

| Metodo y ruta | Acceso | Funcion |
| --- | --- | --- |
| `GET /api/mediciones?limit=100&from=<ISO-8601>&to=<ISO-8601>&cursor=<token>` | Publico, solo lectura | Devuelve una pagina de agregados ordenados por periodo descendente, con un cursor opaco para la pagina siguiente. `from` y `to` son opcionales e inclusivos; el panel solicita paginas de 100 hasta completar el rango. La API limita cada pagina a 500. |
| `POST /api/mediciones` | `Authorization: Bearer <API_TOKEN>` | Valida y guarda una medicion o un lote de hasta 100 registros en Firestore. Los lotes requieren `recordId` unico por registro. |

La consulta `GET /api/mediciones` aplica cache compartida durante 60 segundos, con hasta 5 minutos de revalidacion en segundo plano. Solo se cachean respuestas GET exitosas; las escrituras POST no se cachean. Esto reduce lecturas repetidas de Firestore para la misma URL. Los datos recientes pueden tardar hasta un minuto en actualizarse y, durante la revalidacion, se puede servir una respuesta anterior.

Cuando se restablezca la cuota de Firestore, abre el panel y confirma que se muestren mediciones y que `GET /api/mediciones?limit=1` responda con HTTP 200 y un arreglo `records`. Si la pagina sigue mostrando un error, espera al menos un minuto y vuelve a consultar; si persiste, revisa los logs de la funcion en Vercel y la cuota/estado de Firestore. Evita recargar repetidamente durante la cuota agotada.

El proyecto Vercel se conecta al repositorio GitHub en la rama `main`. Para cada cambio aceptado, revisar **Deployments** y confirmar que la implementacion de produccion quede en estado `Ready` antes de compartir la URL.

Los documentos ya recibidos se mantienen en Firestore; no se deben copiar al repositorio GitHub. GitHub contiene el codigo y la documentacion, mientras que el informe puede incluir un CSV exportado de Firestore si se necesita entregar un respaldo de datos. Antes de compartir ese CSV, quitar cualquier dato sensible y etiquetar claramente las mediciones reales y simuladas.

## Comandos utiles para supervisar la Raspberry

Ejecutar en SSH, desde `~/estacionamiento`:

```bash
cd ~/estacionamiento
sudo docker compose ps
sudo systemctl is-active estacionamiento-adquisicion-ultrasonico.service
sudo docker compose logs -f --since=0s procesamiento
sudo docker compose logs --since=15m sincronizacion
```

- En procesamiento, buscar `Live reading`, `Minute aggregate published` y un estado razonable para la situacion fisica.
- En sincronizacion, buscar `Uploaded batch`.
- En Firestore, revisar la coleccion `mediciones` y que los documentos recientes tengan `distanciaCm`, `estado` y un `periodoInicio` actual.
- Para salir de una vista `logs -f`, pulsar `Ctrl+C`; no apagar ni cerrar la Raspberry.
- Si se pierde Internet, revisar la cola local; los registros pendientes deben conservarse para reintento.
- Evitar `docker compose down -v`: podria eliminar volumenes persistentes. No borrar datos de Firestore como parte de pruebas sin una decision explicita y respaldo.

## Seguridad y configuracion

- La Raspberry solo envia datos a la API HTTPS de Vercel; las credenciales administrativas de Firebase deben permanecer en variables de entorno protegidas de Vercel.
- El token de dispositivo y el bypass de proteccion de Vercel se montan como secretos locales de Docker. **No incluir sus valores, la clave de servicio Firebase ni archivos `.env` en informes, capturas, ZIP o repositorios.**
- MQTT esta publicado solo en `127.0.0.1`, no en todas las interfaces de red.
- El ECHO del HC-SR04 debe permanecer limitado a 3.3 V en el GPIO de la Raspberry.

## Pendientes antes de afirmar que el requisito completo esta cumplido

### Aclaracion del profesor (15 de octubre de 2026, 18:50)

El profesor Luis Delgado respondio que **no es necesario que el IR funcione** y que se pueden generar datos dummy si no se logra cumplir la meta de siete dias. Por lo tanto, se mantiene el IR detenido y no se deben presentar sus activaciones falsas como mediciones. Si se usan datos dummy, identificarlos claramente como simulados y separarlos de las mediciones reales del ultrasónico; no mezclarlos ni describirlos como capturados por sensores.

El enunciado solicita, entre otros puntos:

- Dos o mas sensores de tipos distintos que generen datos reales, combinados para producir informacion util.
- Al menos tres microservicios en contenedores Docker, comunicados por MQTT o API interna.
- Adquisicion configurable, resiliencia local, despliegue automatico y verificaciones de salud.
- Almacenamiento Firestore mediante API de Vercel y plataforma web para consultar datos y configurar dispositivos.
- Operacion continua durante al menos siete dias y comparacion de consumo estimado con las consolas de Firebase y Vercel.

El trabajo de hoy deja evidencia de la ruta ultrasónica hasta Firestore, pero **no demuestra por si solo que todos esos requisitos esten completos**:

1. El IR esta detenido porque dio activaciones falsas sin movimiento. Segun la aclaracion del profesor, no es necesario que funcione para esta entrega; mantener sus conteos fuera de los resultados validos.
2. Los lectores GPIO se ejecutan como servicios systemd en el host de la Pi, no como contenedores. Esta solucion permitio usar los paquetes GPIO ya instalados y evitar el repositorio APT rechazado, pero debe revisarse contra el requisito de contenedorizacion con el docente o adaptarse de forma segura.
3. La interfaz publica muestra mediciones, consulta historicos y permite cambiar remotamente la distancia de referencia y el intervalo ultrasónico. Siguen pendientes la autenticacion con dos roles, el aislamiento por organizacion, las alertas y la gestion completa del ciclo de vida de dispositivos/tokens; desplegar y verificar la ultima version en Vercel.
4. La Pi disponible es una Raspberry Pi 4; el enunciado menciona Pi 3. Confirmar con el docente que la Pi 4 es aceptada como equivalente.
5. El usuario declaro el inicio de la recoleccion ultrasónica el 15 de octubre a las 18:35 (UTC-3); el IR permanece detenido y no forma parte de estos datos validos. Anotar paradas, cortes de red, reinicios y pruebas con objetos. Si no se alcanza la meta de siete dias y se generan datos dummy, etiquetarlos y analizarlos por separado como simulados. Si hubo una interrupcion, informar el tiempo real de operacion continua y no describirlo como siete dias continuos. Las pruebas controladas no deben describirse como ocupacion real.
6. Al terminar, exportar los datos, contar registros y huecos, comparar consumo real de Firebase/Vercel con estimaciones y preparar graficos/conclusiones.

## Resumen para futura presentacion

> Se implemento una ruta de adquisicion de distancia en una Raspberry Pi. El HC-SR04 toma lecturas cada cinco segundos; un procesador estabiliza el estado del puesto y agrega las lecturas por minuto; una cola SQLite protege los agregados ante fallas de conectividad; y un servicio de sincronizacion los envia por lotes a una API HTTPS en Vercel, que escribe en Firestore. Se verificaron lecturas y documentos con distancia y estado. La recoleccion ultrasónica de siete dias se declaro iniciada el 15 de octubre de 2026 a las 18:35 (UTC-3), con termino previsto el 22 de octubre a las 18:35 si no hay interrupciones. La prueba del IR detecto activaciones falsas y fue suspendida. La evaluacion final comparara volumen estimado y consumo medido en Firebase y Vercel.
