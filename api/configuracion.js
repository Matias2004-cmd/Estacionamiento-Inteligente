const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { timingSafeEqual } = require("node:crypto");

function hasValidToken(req, environmentVariable) {
  const expected = process.env[environmentVariable];
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
    initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
  }

  return getFirestore();
}

function isValidDeviceId(deviceId) {
  return (
    typeof deviceId === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(deviceId)
  );
}

function getConfigValues(body) {
  const values = {};
  if (Object.hasOwn(body, "distanciaLibreCm")) {
    const value = body.distanciaLibreCm;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 5 ||
      value > 200
    ) {
      return null;
    }
    values.distanciaLibreCm = value;
  }
  if (Object.hasOwn(body, "sampleIntervalSeconds")) {
    const value = body.sampleIntervalSeconds;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0.1 ||
      value > 3600
    ) {
      return null;
    }
    values.sampleIntervalSeconds = value;
  }

  const allowedKeys = new Set([
    "deviceId",
    "distanciaLibreCm",
    "sampleIntervalSeconds",
  ]);
  if (
    Object.keys(body).some((key) => !allowedKeys.has(key)) ||
    Object.keys(values).length === 0
  ) {
    return null;
  }
  return values;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    if (!hasValidToken(req, "API_TOKEN")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const deviceId = req.query?.deviceId;
    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: "Invalid deviceId" });
    }

    try {
      const document = await getDatabase()
        .collection("configuracion_dispositivos")
        .doc(deviceId)
        .get();
      if (!document.exists) {
        return res.status(200).json({ deviceId, config: null });
      }

      const data = document.data();
      return res.status(200).json({
        deviceId,
        config: {
          distanciaLibreCm: data.distanciaLibreCm ?? null,
          sampleIntervalSeconds: data.sampleIntervalSeconds ?? null,
        },
        updatedAt: data.updatedAt?.toDate?.().toISOString() ?? null,
      });
    } catch (error) {
      console.error("Failed to read device configuration:", error.message);
      return res.status(500).json({ error: "Could not read device configuration" });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!hasValidToken(req, "ADMIN_API_TOKEN")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const deviceId = req.body?.deviceId;
  const values = req.body && getConfigValues(req.body);
  if (!isValidDeviceId(deviceId) || !values) {
    return res.status(400).json({
      error:
        "Expected deviceId and at least one valid configuration value",
    });
  }

  try {
    const document = getDatabase()
      .collection("configuracion_dispositivos")
      .doc(deviceId);
    await document.set({ ...values, updatedAt: Timestamp.now() }, { merge: true });
    return res.status(200).json({
      deviceId,
      config: {
        distanciaLibreCm: values.distanciaLibreCm ?? null,
        sampleIntervalSeconds: values.sampleIntervalSeconds ?? null,
      },
      saved: true,
    });
  } catch (error) {
    console.error("Failed to save device configuration:", error.message);
    return res.status(500).json({ error: "Could not save device configuration" });
  }
};
