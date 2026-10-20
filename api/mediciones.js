const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { timingSafeEqual } = require("node:crypto");

function hasValidToken(req) {
  const expected = process.env.API_TOKEN;
  const provided = req.headers.authorization?.replace(/^Bearer\s+/i, "");

  if (!expected || !provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function getDatabase() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
  }

  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    initializeApp({ credential: cert(serviceAccount) });
  }

  return getFirestore();
}

function isValidMeasurement(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }

  const {
    distanciaCm,
    distanciaMinCm,
    distanciaMaxCm,
    muestras,
    deteccionesIr,
    periodoInicio,
    recordId,
    estado,
    sensorId,
  } = record;

  if (
    typeof distanciaCm !== "number" ||
    !Number.isFinite(distanciaCm) ||
    distanciaCm < 0 ||
    distanciaCm > 200 ||
    !["LIBRE", "OCUPADO"].includes(estado) ||
    typeof sensorId !== "string" ||
    sensorId.length < 1 ||
    sensorId.length > 64 ||
    (distanciaMinCm !== undefined &&
      (typeof distanciaMinCm !== "number" ||
        !Number.isFinite(distanciaMinCm) ||
        distanciaMinCm < 0 ||
        distanciaMinCm > distanciaCm)) ||
    (distanciaMaxCm !== undefined &&
      (typeof distanciaMaxCm !== "number" ||
        !Number.isFinite(distanciaMaxCm) ||
        distanciaMaxCm < distanciaCm ||
        distanciaMaxCm > 200)) ||
    (distanciaMinCm !== undefined &&
      distanciaMaxCm !== undefined &&
      distanciaMinCm > distanciaMaxCm) ||
    (muestras !== undefined &&
      (!Number.isInteger(muestras) || muestras < 1 || muestras > 10000)) ||
    (deteccionesIr !== undefined &&
      (!Number.isInteger(deteccionesIr) ||
        deteccionesIr < 0 ||
        deteccionesIr > 10000)) ||
    (periodoInicio !== undefined &&
      (typeof periodoInicio !== "string" ||
        !Number.isFinite(Date.parse(periodoInicio)))) ||
    (recordId !== undefined &&
      (typeof recordId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(recordId)))
  ) {
    return false;
  }

  return true;
}

function toFirestoreMeasurement(record) {
  const measurement = {
    distanciaCm: record.distanciaCm,
    estado: record.estado,
    sensorId: record.sensorId,
    timestamp: Timestamp.now(),
  };

  if (record.distanciaMinCm !== undefined) {
    measurement.distanciaMinCm = record.distanciaMinCm;
  }
  if (record.distanciaMaxCm !== undefined) {
    measurement.distanciaMaxCm = record.distanciaMaxCm;
  }
  if (record.muestras !== undefined) {
    measurement.muestras = record.muestras;
  }
  if (record.deteccionesIr !== undefined) {
    measurement.deteccionesIr = record.deteccionesIr;
  }
  if (record.periodoInicio !== undefined) {
    measurement.periodoInicio = Timestamp.fromDate(new Date(record.periodoInicio));
  }

  return measurement;
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const db = getDatabase();
      const requestedLimit = Number.parseInt(req.query?.limit, 10);
      const limit = Number.isInteger(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 500)
        : 100;
      const from = req.query?.from;
      const to = req.query?.to;
      if (
        (from !== undefined && !Number.isFinite(Date.parse(from))) ||
        (to !== undefined && !Number.isFinite(Date.parse(to))) ||
        (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to))
      ) {
        return res.status(400).json({ error: "Invalid date range" });
      }

      let query = db.collection("mediciones");
      if (from !== undefined) {
        query = query.where("periodoInicio", ">=", Timestamp.fromDate(new Date(from)));
      }
      if (to !== undefined) {
        query = query.where("periodoInicio", "<=", Timestamp.fromDate(new Date(to)));
      }
      const snapshot = await query.orderBy("periodoInicio", "desc").limit(limit).get();
      const records = snapshot.docs.map((document) => {
        const data = document.data();
        return {
          id: document.id,
          ...data,
          periodoInicio: data.periodoInicio?.toDate?.().toISOString() ?? null,
          timestamp: data.timestamp?.toDate?.().toISOString() ?? null,
        };
      });
      return res.status(200).json({ records });
    } catch (error) {
      console.error("Failed to read Firestore measurements:", error.message);
      return res.status(500).json({ error: "Could not read measurements" });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!hasValidToken(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const isBatch = Array.isArray(req.body?.records);
  const records = isBatch ? req.body.records : [req.body];
  if (
    records.length < 1 ||
    records.length > 100 ||
    records.some((record) => !isValidMeasurement(record)) ||
    (isBatch &&
      (records.some((record) => typeof record.recordId !== "string") ||
        new Set(records.map((record) => record.recordId)).size !== records.length))
  ) {
    return res.status(400).json({
      error:
        "Expected 1–100 valid measurements; batch records require unique recordId values",
    });
  }

  try {
    const db = getDatabase();
    const collection = db.collection("mediciones");
    const batch = db.batch();
    const documents = records.map((record) => {
      const document = record.recordId
        ? collection.doc(record.recordId)
        : collection.doc();
      batch.set(document, toFirestoreMeasurement(record));
      return document;
    });
    await batch.commit();

    return res.status(201).json({
      ids: documents.map((document) => document.id),
      saved: true,
      count: documents.length,
    });
  } catch (error) {
    console.error("Failed to save Firestore measurement:", error.message);
    return res.status(500).json({ error: "Could not save measurement" });
  }
};
