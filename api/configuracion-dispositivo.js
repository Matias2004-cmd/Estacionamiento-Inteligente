const { Timestamp } = require("firebase-admin/firestore");
const { authenticateDevice, getDatabase, sendError } = require("../lib/api-auth");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    res.setHeader("Cache-Control", "private, no-store");
    const db = getDatabase();
    const device = await authenticateDevice(req, db);
    const deviceRef = db.doc(
      `organizaciones/${device.organizacionId}/dispositivos/${device.dispositivoId}`,
    );
    const snapshot = await deviceRef.get();
    if (!snapshot.exists || snapshot.data().activo !== true) {
      return res.status(404).json({ error: "Device is not active" });
    }
    await deviceRef.update({ ultimoContacto: Timestamp.now() });
    return res.status(200).json({
      deviceId: device.dispositivoId,
      settings: snapshot.data().configuracion,
    });
  } catch (error) {
    return sendError(res, error);
  }
};
