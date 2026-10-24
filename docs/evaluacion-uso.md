# Evaluación de uso y capacidad (requisito 5)

> Las cifras **estimadas** se derivan del código actual. Las celdas marcadas
> **[MEDIR]** se completan con las consolas de Firebase (*Firestore → Uso*) y
> Vercel (*Usage* / *Observability*) del periodo de 7 días, adjuntando capturas.
> Precios y límites consultados el 23-10-2026 en las fuentes de la sección 8.
> Para recalcular las proyecciones con otros supuestos: `npm run proyeccion`.

## 1. Escenario de uso

| Variable | Valor |
| --- | --- |
| Dispositivos | 1 Raspberry Pi (`raspberry-pi-1`) |
| Sensores | HC-SR04 (distancia) + módulo IR (paso por la entrada) |
| Frecuencia de muestreo | Ultrasónico cada 5 s ⇒ 17.280 lecturas/día; IR por evento |
| Agregación en el dispositivo | 1 documento por minuto ⇒ 1.440 documentos/día |
| Envío a la nube | Lotes de 5 documentos (o cada 300 s) ⇒ 288 `POST`/día |
| Configuración remota | 1 `GET` cada 60 s ⇒ 1.440/día |
| Tamaño de un documento | ≈ 365 B de datos + 4 entradas de índice ≈ **1,1 KB** (ver 1.1) |
| Usuarios del dashboard | 3 usuarios × 4 sesiones/día × ~30 min |

### 1.1 Tamaño de documento (fórmula oficial de Firestore)

Nombre del documento
`organizaciones/<uuid>/mediciones/raspberry-pi-1__raspberry-pi-1_<epoch>`:
15 + 37 + 11 + 42 + 16 = **121 B**. Campos (nombre + 1 + valor; número y
timestamp = 8 B): distanciaCm 20, estado 15, sensorId 24, timestamp 18,
distanciaMinCm 23, distanciaMaxCm 23, muestras 17, deteccionesIr 22,
ingresosConfirmados 28, periodoInicio 22 = **212 B**. Total 121 + 212 + 32 =
**≈ 365 B**.

Cada entrada de índice simple ≈ nombre del documento + campo + valor + 32 ≈
175 B. Con la indexación automática (10 campos × ascendente y descendente = 20
entradas) el documento ocupa **≈ 3,9 KB**; con las exenciones de
[firestore.indexes.json](../firestore.indexes.json) quedan 4 entradas
(`periodoInicio` y `sensorId`) ⇒ **≈ 1,1 KB**.

`npm run uso` calcula el tamaño de un documento real y cuenta los documentos por día.

## 2. Estimación de consumo diario y mensual (1 dispositivo)

| Operación | Origen | Por día | Por mes (30 d) | % cuota diaria |
| --- | --- | ---: | ---: | ---: |
| **Escrituras** | 1.440 agregados + 288 `ultimaMedicion` + ≤ 288 `ultimoContacto` | **2.016** | 60.480 | 10 % de 20.000 |
| Lecturas del dispositivo | 2 por `POST` (credencial + dispositivo) × 288 + 2 por `GET` de configuración × 1.440 | 3.456 | 103.680 | 7 % |
| Lecturas del dashboard en vivo | 12 sesiones × (100 iniciales + ~30 nuevas + ~7 del dispositivo) | ≈ 1.650 | ≈ 49.500 | 3 % |
| Lecturas de históricos | 12 consultas × 101 (página de 100 + 1 para saber si hay más) | ≈ 1.210 | ≈ 36.300 | 2 % |
| Lecturas de sesión | `collectionGroup(miembros)` + organización × 12 | ≈ 40 | ≈ 1.200 | < 1 % |
| **Lecturas totales** | | **≈ 6.356** | ≈ 190.700 | **13 % de 50.000** |
| Eliminaciones | Sin política de retención activa | 0 | 0 | 0 % |
| **Almacenamiento** | 1.440 × 1,1 KB | ≈ 1,5 MB | ≈ 45 MB | — |
| **Invocaciones Vercel** | 288 + 1.440 + ~60 del dashboard | ≈ 1.788 | ≈ 53.640 | 5 % de 1.000.000/mes |

Una carga del histórico de 24 h completo cuesta 1.440 lecturas (15 páginas de 100):
caben ≈ 30 cargas diarias en la cuota.

## 3. Medición real (7 días)

Periodo declarado: 15-10-2026 18:35 → 22-10-2026 18:35 (UTC-3); ver
[bitacora-recoleccion.md](bitacora-recoleccion.md). Completar con las consolas:

| Día | Docs guardados (`npm run uso`) | Escrituras (consola) | Lecturas (consola) | Invocaciones Vercel |
| --- | ---: | ---: | ---: | ---: |
| 15-10 (desde 18:35) | [MEDIR] | [MEDIR] | [MEDIR] | [MEDIR] |
| 16-10 | [MEDIR] | [MEDIR] | [MEDIR] | [MEDIR] |
| … | | | | |
| 22-10 (hasta 18:35) | [MEDIR] | [MEDIR] | [MEDIR] | [MEDIR] |
| **Promedio diario** | [MEDIR] vs 1.440 estimado | [MEDIR] vs estimado | [MEDIR] vs estimado | [MEDIR] vs estimado |

Diferencias esperables que se deben explicar con los datos:

- **Menos de 1.440 documentos/día:** cortes de energía o red (la cola los
  recupera solo si la Pi siguió encendida) y minutos sin ecos válidos del HC-SR04.
- **Más escrituras que lo estimado durante la medición:** el código de esa
  semana consultaba la configuración cada 30 s y escribía `ultimoContacto` en
  cada consulta (+2.880/día), y si el dispositivo tenía `publicarEnDemo` se
  duplicaba cada agregado en la colección pública (+1.440/día). Ver sección 5.
- **Picos de lecturas:** recargas del panel, consultas de rangos largos y, en
  especial, **exportaciones completas** de la base. El 23-10-2026 la API
  respondió `Quota exceeded` (código 8, `RESOURCE_EXHAUSTED`): se agotó la
  cuota diaria de lecturas. Registrar ese día en el informe como evidencia de
  que el límite es real y de cómo se comporta el sistema: Firebase rechaza
  operaciones hasta el reinicio diario y la Pi conserva los agregados en SQLite
  hasta poder enviarlos.

## 4. Límites de la capa gratuita

| Recurso | Límite gratuito | Uso estimado (1 disp.) | % usado | Dispositivos que caben |
| --- | --- | ---: | ---: | ---: |
| Escrituras Firestore | 20.000/día | 2.016 | 10 % | **≈ 9,9** ← primer límite |
| Lecturas Firestore | 50.000/día | 6.356 | 13 % | ≈ 13 (con 1 dashboard por cada 10 disp.) |
| Almacenamiento Firestore | 1 GiB | 1,5 MB/día | — | 1 GiB en **≈ 678 días (1,9 años)** |
| Invocaciones Vercel Hobby | 1.000.000/mes | 53.640/mes | 5 % | ≈ 19 |
| CPU activa Vercel Hobby | 4 h/mes | ≈ 0,3 h/mes (supuesto 20 ms/invocación) | 7 % | [MEDIR en Observability] |

Sin las exenciones de índice el almacenamiento llegaría a 1 GiB en ≈ 190 días
(≈ 6 meses).

## 5. Optimizaciones (antes → después, 1 dispositivo/día)

| # | Decisión de diseño | Antes | Después | Efecto |
| --- | --- | --- | --- | --- |
| 1 | **Agregación por minuto en la Pi** (promedio, min, max, conteos) | 17.280 escrituras (86 % de la cuota) | 1.440 | −92 % escrituras; histórico de 24 h: 17.280 → 1.440 lecturas |
| 2 | **Envío por lotes de 5** | 1.440 `POST`, 2.880 lecturas de autenticación, 1.440 actualizaciones del dispositivo | 288 `POST`, 576 lecturas, 288 escrituras | −80 % invocaciones y lecturas del dispositivo |
| 3 | **Sondeo de configuración cada 60 s y `ultimoContacto` como máximo cada 5 min** | 2.880 `GET`, 5.760 lecturas, 2.880 escrituras | 1.440 `GET`, 2.880 lecturas, ≤ 288 escrituras | −2.592 escrituras (−13 pp de la cuota) y −2.880 lecturas |
| 4 | **Exención de índices** en campos no consultados | ≈ 3,9 KB/documento | ≈ 1,1 KB | −72 % almacenamiento: de ~6 meses a ~1,9 años hasta 1 GiB |
| 5 | **Caché en el edge** de `GET /api/mediciones` público (60 s) | 1 consulta a Firestore por visita | 1 por minuto como máximo | Visitas simultáneas no multiplican lecturas |
| 6 | **Copia pública opcional** (`publicarEnDemo` desmarcado) | +1.440 escrituras | 0 | La demo pública solo cuesta si se activa |

Resultado total de escrituras: **6.048 → 2.016/día (30 % → 10 % de la cuota)**.
Verificar el efecto midiendo 1–2 días con la versión nueva y comparando con la
semana de medición.

Mejoras propuestas (no implementadas): devolver la configuración en la
respuesta del `POST` (elimina 1.440 `GET` y 2.880 lecturas/día), política de
retención que borre agregados de más de 90 días tras guardar un resumen diario
por dispositivo, y que el panel en vivo cargue 60 documentos en vez de 100.

## 6. Proyección de crecimiento (fuera de la capa gratuita)

Salida de `npm run proyeccion` (Firestore Standard en Santiago; almacenamiento
acumulado de un año; 1 organización con 3 usuarios por cada 10 dispositivos):

| Dispositivos | Escrituras/día (% cuota) | Lecturas/día (% cuota) | Invocaciones/mes | GiB al año | Firestore Blaze/mes | Vercel |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 2.016 (10 %) | 6.356 (13 %) | 53.640 | 0,54 | US$ 0,00 | Hobby (US$ 0) |
| 10 | 20.160 (101 %) | 37.460 (75 %) | 520.200 | 5,38 | US$ 0,95 | Hobby (US$ 0)* |
| 100 | 201.600 (1.008 %) | 374.600 (749 %) | 5.202.000 | 53,85 | US$ 22,58 | Pro US$ 20,00 |
| 1.000 | 2.016.000 (10.080 %) | 3.746.000 (7.492 %) | 52.020.000 | 538,45 | US$ 240,48 | Pro US$ 160,11 |

\* Con 10 dispositivos el proyecto deja de caber en Spark por escrituras, por lo
que necesitaría Blaze; Hobby no permite uso comercial.

**Primer cuello de botella: las escrituras diarias de Firestore** (≈ 10
dispositivos), seguidas de las lecturas (≈ 13) y las invocaciones de Vercel
(≈ 19). A 1.000 dispositivos el costo dominante pasa a ser el
**almacenamiento acumulado** (US$ 0,215/GiB-mes, creciendo cada mes), lo que
hace necesaria una política de retención. Costo de Vercel con supuestos de 20 ms
de CPU y 300 ms de duración con 2 GB por invocación: medir los valores reales en
Observability y ajustar `MODELO` en el script.

## 7. Costos de migración

Comparación mensual para el escenario actual (1 dispositivo) y 100 dispositivos.

| Alternativa | Actual | 100 disp. | Qué administra el grupo |
| --- | ---: | ---: | --- |
| **PaaS: Vercel Pro + Firebase Blaze** (oficial) | US$ 20,00 (Pro) + US$ 0 | US$ 20,00 + US$ 22,58 ≈ **US$ 42,58** | Solo código, reglas e índices. Proveedores: parches, TLS, respaldo/replicación, escalamiento automático |
| **IaaS: AWS EC2 + base propia** (referencial) | t4g.micro (≈ US$ 6,1) + 20 GB gp3 (≈ US$ 1,6) + IPv4 pública (≈ US$ 3,7) + snapshots (≈ US$ 1) ≈ **US$ 12** | t4g.small (≈ US$ 12,3) + 50 GB gp3 (≈ US$ 4) + IPv4 (≈ US$ 3,7) + snapshots (≈ US$ 2,5) ≈ **US$ 23** | Sistema operativo y parches, PostgreSQL/MongoDB, certificados TLS, firewall, respaldos y restauración, monitoreo, alta disponibilidad (una sola VM es un punto único de falla), escalamiento manual |

> Los valores de AWS son referenciales para `us-east-1`; **confirmar en
> https://calculator.aws** (y en `sa-east-1`, más cara) antes de entregar, y
> agregar la captura de la calculadora. Equivalentes: Azure B1s/B2s en
> https://azure.microsoft.com/pricing/calculator y Compute Engine e2-micro/e2-small
> en https://cloud.google.com/products/calculator.

Conclusión: IaaS parece más barato a 100 dispositivos, pero el ahorro (~US$ 20/mes)
se pierde con pocas horas de administración al mes y además el grupo asume la
seguridad, los respaldos y la disponibilidad. Con PaaS el costo crece con el
uso real y el escalamiento es automático; la optimización del modelo de datos
(secciones 5 y 6) es la principal palanca de costo.

## 8. Fuentes

- Cuotas gratuitas y facturación de Firestore (lecturas por listener, `count()`):
  https://firebase.google.com/docs/firestore/pricing
- Precios Firestore Standard, Santiago (`southamerica-west1`): lecturas US$ 0,043,
  escrituras US$ 0,129, eliminaciones US$ 0,014 por 100.000; almacenamiento
  US$ 0,215/GiB-mes: https://cloud.google.com/firestore/pricing
- Tamaño de documentos e índices: https://firebase.google.com/docs/firestore/storage-size
- Vercel Hobby (1.000.000 invocaciones, 4 h CPU activa, 360 GB-h, 100 GB de
  transferencia) y tarifas Pro (US$ 0,60/millón de invocaciones, desde
  US$ 0,128/h CPU, desde US$ 0,0106/GB-h): https://vercel.com/docs/limits/fair-use-guidelines
- Vercel Pro US$ 20/mes con US$ 20 de crédito incluido: https://vercel.com/pricing
