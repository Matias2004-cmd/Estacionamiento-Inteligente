const { FieldPath, Timestamp } = require("firebase-admin/firestore");
const { randomUUID, timingSafeEqual } = require("node:crypto");
const {
  authenticateDevice,
  getDatabase,
  requireOrganization,
  sendError,
} = require("../lib/api-auth");

function hasValidPublicToken(req) {
  const expected = process.env.API_TOKEN;
  const provided = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!expected || !provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function isValidMeasurement(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const {
    distanciaCm,
    distanciaMinCm,
    distanciaMaxCm,
    muestras,
    deteccionesIr,
    ingresosConfirmados,
    periodoInicio,
    recordId,
    estado,
    sensorId,
  } = record;

  return !(
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
    (ingresosConfirmados !== undefined &&
      (!Number.isInteger(ingresosConfirmados) ||
        ingresosConfirmados < 0 ||
        ingresosConfirmados > 10000)) ||
    (periodoInicio !== undefined &&
      (typeof periodoInicio !== "string" ||
        !Number.isFinite(Date.parse(periodoInicio)))) ||
    (recordId !== undefined &&
      (typeof recordId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(recordId)))
  );
}

function toFirestoreMeasurement(record) {
  const measurement = {
    distanciaCm: record.distanciaCm,
    estado: record.estado,
    sensorId: record.sensorId,
    timestamp: Timestamp.now(),
  };
  for (const field of [
    "distanciaMinCm",
    "distanciaMaxCm",
    "muestras",
    "deteccionesIr",
    "ingresosConfirmados",
  ]) {
    if (record[field] !== undefined) measurement[field] = record[field];
  }
  if (record.periodoInicio !== undefined) {
    measurement.periodoInicio = Timestamp.fromDate(new Date(record.periodoInicio));
  }
  return measurement;
}

function parseCursor(cursorToken) {
  if (cursorToken === undefined) return null;
  if (
    typeof cursorToken !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(cursorToken)
  ) {
    throw Object.assign(new Error("Invalid cursor"), { status: 400 });
  }
  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(cursorToken, "base64url").toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid cursor"), { status: 400 });
  }
  if (
    !cursor ||
    typeof cursor.periodoInicio !== "string" ||
    !Number.isFinite(Date.parse(cursor.periodoInicio)) ||
    typeof cursor.id !== "string" ||
    cursor.id.length < 1 ||
    cursor.id.length > 150
  ) {
    throw Object.assign(new Error("Invalid cursor"), { status: 400 });
  }
  return cursor;
}

function validDateRange(from, to) {
  return !(
    (from !== undefined && !Number.isFinite(Date.parse(from))) ||
    (to !== undefined && !Number.isFinite(Date.parse(to))) ||
    (from !== undefined &&
      to !== undefined &&
      Date.parse(from) > Date.parse(to))
  );
}

async function readPage(db, req, res) {
  const { from, to, scope } = req.query || {};
  if (!validDateRange(from, to)) {
    return res.status(400).json({ error: "Invalid date range" });
  }
  if (scope !== undefined && scope !== "organizacion") {
    return res.status(400).json({ error: "Invalid measurement scope" });
  }
  if (scope === "organizacion") res.setHeader("Cache-Control", "private, no-store");

  const requestedLimit = Number.parseInt(req.query?.limit, 10);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 500)
    : 100;
  const cursor = parseCursor(req.query?.cursor);

  let collection = db.collection("mediciones");
  if (scope === "organizacion") {
    const organization = await requireOrganization(
      req,
      db,
      req.query?.organizacion,
    );
    collection = db
      .collection("organizaciones")
      .doc(organization.organizationId)
      .collection("mediciones");
  }

  let query = collection;
  if (from !== undefined) {
    query = query.where("periodoInicio", ">=", Timestamp.fromDate(new Date(from)));
  }
  if (to !== undefined) {
    query = query.where("periodoInicio", "<=", Timestamp.fromDate(new Date(to)));
  }
  query = query
    .orderBy("periodoInicio", "desc")
    .orderBy(FieldPath.documentId(), "desc");
  if (cursor) {
    query = query.startAfter(
      Timestamp.fromDate(new Date(cursor.periodoInicio)),
      cursor.id,
    );
  }
  const snapshot = await query.limit(limit + 1).get();
  const hasMore = snapshot.docs.length > limit;
  const page = snapshot.docs.slice(0, limit);
  const records = page.map((document) => {
    const data = document.data();
    return {
      id: document.id,
      ...data,
      periodoInicio: data.periodoInicio?.toDate?.().toISOString() ?? null,
      timestamp: data.timestamp?.toDate?.().toISOString() ?? null,
    };
  });
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({
            periodoInicio: last.get("periodoInicio").toDate().toISOString(),
            id: last.id,
          }),
        ).toString("base64url")
      : null;
  if (scope !== "organizacion") {
    res.setHeader(
      "Cache-Control",
      "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
    );
  }
  return res.status(200).json({ records, nextCursor });
}

async function saveMeasurements(db, req, res) {
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

  if (hasValidPublicToken(req)) {
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
      scope: "public-demo",
    });
  }

  const device = await authenticateDevice(req, db);
  res.setHeader("Cache-Control", "private, no-store");
  const deviceRef = db
    .doc(`organizaciones/${device.organizacionId}/dispositivos/${device.dispositivoId}`);
  const deviceSnapshot = await deviceRef.get();
  if (!deviceSnapshot.exists || deviceSnapshot.data().activo !== true) {
    return res.status(403).json({ error: "Device is not active" });
  }
  if (records.some((record) => record.sensorId !== device.dispositivoId)) {
    return res.status(403).json({ error: "Measurement device does not match credential" });
  }

  const collection = db
    .collection("organizaciones")
    .doc(device.organizacionId)
    .collection("mediciones");
  const batch = db.batch();
  const documents = records.map((record) => {
    const sourceRecordId = record.recordId || randomUUID();
    const measurement = toFirestoreMeasurement(record);
    const document = collection.doc(`${device.dispositivoId}__${sourceRecordId}`);
    batch.set(document, measurement);
    if (deviceSnapshot.data().publicarEnDemo === true) {
      batch.set(
        db
          .collection("mediciones")
          .doc(`demo__${device.organizacionId}__${device.dispositivoId}__${sourceRecordId}`),
        measurement,
      );
    }
    return document;
  });
  batch.update(deviceRef, {
    ultimoContacto: Timestamp.now(),
    ultimaMedicion: toFirestoreMeasurement(records.at(-1)),
  });
  await batch.commit();
  return res.status(201).json({
    ids: documents.map((document) => document.id),
    saved: true,
    count: documents.length,
    scope: "organizacion",
  });
}

module.exports = async function handler(req, res) {
  let db;
  try {
    db = getDatabase();
  } catch (error) {
    return sendError(res, error);
  }
  if (req.method === "GET") {
    try {
      return await readPage(db, req, res);
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!hasValidPublicToken(req) && !req.headers.authorization) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    return await saveMeasurements(db, req, res);
  } catch (error) {
    return sendError(res, error);
  }
};
