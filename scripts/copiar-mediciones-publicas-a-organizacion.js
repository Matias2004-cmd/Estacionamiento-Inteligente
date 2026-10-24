const { createHash } = require("node:crypto");
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { FieldPath, Timestamp, getFirestore } = require("firebase-admin/firestore");

const DEVICE_ID = process.env.DEVICE_ID || "raspberry-pi-1";
const ORGANIZATION_ID = process.env.TARGET_ORGANIZATION_ID;
const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = 400;

function toTimestamp(value) {
  if (value && typeof value.toDate === "function") return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return Timestamp.fromDate(value);
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return Timestamp.fromDate(date);
  }
  return null;
}

function makePrivateMeasurement(snapshot) {
  const source = snapshot.data();
  const periodoInicio =
    toTimestamp(source.periodoInicio) || toTimestamp(source.timestamp);
  const distanciaCm = source.distanciaCm;

  if (
    !periodoInicio ||
    typeof distanciaCm !== "number" ||
    !Number.isFinite(distanciaCm) ||
    !["LIBRE", "OCUPADO"].includes(source.estado)
  ) {
    return null;
  }

  const measurement = {
    distanciaCm,
    estado: source.estado,
    sensorId: DEVICE_ID,
    periodoInicio,
    timestamp: toTimestamp(source.timestamp) || periodoInicio,
  };

  for (const field of [
    "distanciaMinCm",
    "distanciaMaxCm",
    "muestras",
    "deteccionesIr",
  ]) {
    if (typeof source[field] === "number" && Number.isFinite(source[field])) {
      measurement[field] = source[field];
    }
  }

  return measurement;
}

async function main() {
  if (!ORGANIZATION_ID || !/^[A-Za-z0-9_-]{1,64}$/.test(ORGANIZATION_ID)) {
    throw new Error("Define TARGET_ORGANIZATION_ID con el ID completo de Harry.");
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON no está configurada.");
  }

  const serviceAccount = JSON.parse(serviceAccountJson);
  if (serviceAccount.project_id !== "estacionamiento-intelige-f3038") {
    throw new Error("La cuenta de servicio no pertenece al proyecto de Firebase esperado.");
  }

  const app =
    getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore(app);
  const deviceRef = db.doc(
    `organizaciones/${ORGANIZATION_ID}/dispositivos/${DEVICE_ID}`,
  );
  const device = await deviceRef.get();
  if (!device.exists || device.data().activo !== true) {
    throw new Error("No existe un dispositivo activo con ese ID en la organización destino.");
  }

  const publicSnapshot = await db
    .collection("mediciones")
    .where("sensorId", "==", DEVICE_ID)
    .get();

  const eligible = publicSnapshot.docs.filter(
    (document) => !document.id.startsWith("demo__"),
  );
  const prepared = eligible
    .map((document) => ({
      source: document,
      measurement: makePrivateMeasurement(document),
    }))
    .filter((item) => item.measurement !== null);
  const skipped = publicSnapshot.size - prepared.length;

  console.log(`Organización destino: ${ORGANIZATION_ID}`);
  console.log(`Dispositivo: ${DEVICE_ID}`);
  console.log(`Documentos públicos encontrados: ${publicSnapshot.size}`);
  console.log(`Documentos aptos para copiar: ${prepared.length}`);
  console.log(`Documentos demo__ o inválidos omitidos: ${skipped}`);

  if (!APPLY) {
    console.log("Simulación: no se escribió ningún dato. Agrega --apply para copiar.");
    return;
  }

  let batch = db.batch();
  let pending = 0;
  let written = 0;
  for (const { source, measurement } of prepared) {
    const digest = createHash("sha256").update(source.id).digest("hex").slice(0, 32);
    const targetRef = db
      .collection("organizaciones")
      .doc(ORGANIZATION_ID)
      .collection("mediciones")
      .doc(`${DEVICE_ID}__import_${digest}`);
    batch.set(targetRef, measurement);
    pending += 1;

    if (pending === BATCH_SIZE) {
      await batch.commit();
      written += pending;
      batch = db.batch();
      pending = 0;
      console.log(`Copiados: ${written}/${prepared.length}`);
    }
  }

  if (pending > 0) {
    await batch.commit();
    written += pending;
  }
  console.log(`Copia terminada: ${written} mediciones privadas.`);
  console.log("Los documentos de la colección pública se conservaron.");
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
