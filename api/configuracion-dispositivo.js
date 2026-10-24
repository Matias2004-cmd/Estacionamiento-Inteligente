const { Timestamp } = require("firebase-admin/firestore");
const { authenticateDevice, getDatabase, sendError } = require("../lib/api-auth");

// El dispositivo consulta su configuración cada minuto; registrar cada consulta
// costaría 1.440 escrituras diarias. Solo se actualiza el último contacto si
// pasaron más de cinco minutos desde el anterior.
const CONTACT_WRITE_INTERVAL_MS = 5 * 60 * 1000;

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
    const lastContact = snapshot.data().ultimoContacto?.toMillis?.() || 0;
    if (Date.now() - lastContact > CONTACT_WRITE_INTERVAL_MS) {
      await deviceRef.update({ ultimoContacto: Timestamp.now() });
    }
    return res.status(200).json({
      deviceId: device.dispositivoId,
      settings: snapshot.data().configuracion,
    });
  } catch (error) {
    return sendError(res, error);
  }
};
