const { randomBytes, randomUUID } = require("node:crypto");
const {
  getDatabase,
  hashDeviceToken,
  requireOrganizationAdmin,
  requireOrganization,
  sendError,
} = require("../lib/api-auth");

function validSettings(settings) {
  return (
    settings &&
    Number.isFinite(settings.distanciaLibreCm) &&
    settings.distanciaLibreCm >= 5 &&
    settings.distanciaLibreCm <= 200 &&
    Number.isFinite(settings.intervaloMuestreoSegundos) &&
    settings.intervaloMuestreoSegundos >= 0.1 &&
    settings.intervaloMuestreoSegundos <= 3600 &&
    Number.isFinite(settings.umbralAlertaCm) &&
    settings.umbralAlertaCm >= 0 &&
    settings.umbralAlertaCm <= 200 &&
    Number.isInteger(settings.tiempoDesconexionSegundos) &&
    settings.tiempoDesconexionSegundos >=
      Math.ceil(settings.intervaloMuestreoSegundos) + 360 &&
    settings.tiempoDesconexionSegundos <= 86400
  );
}

module.exports = async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    const db = getDatabase();
    const organizationId = req.method === "GET"
      ? req.query?.organizacion
      : req.body?.organizacion;
    const context = req.method === "GET"
      ? await requireOrganization(req, db, organizationId)
      : await requireOrganizationAdmin(req, db, organizationId);
    const devices = db
      .collection("organizaciones")
      .doc(context.organizationId)
      .collection("dispositivos");

    if (req.method === "GET") {
      const snapshot = await devices.orderBy("nombre").get();
      return res.status(200).json({
        devices: snapshot.docs.map((document) => ({
          id: document.id,
          ...document.data(),
        })),
      });
    }

    if (req.method === "POST") {
      const name = typeof req.body?.nombre === "string"
        ? req.body.nombre.trim()
        : "";
      const requestedDeviceId = req.body?.dispositivoId;
      if (
        !name ||
        name.length > 100 ||
        (req.body?.publicarEnDemo !== undefined &&
          typeof req.body.publicarEnDemo !== "boolean") ||
        (requestedDeviceId !== undefined &&
          (typeof requestedDeviceId !== "string" ||
            !/^[A-Za-z0-9_-]{1,64}$/.test(requestedDeviceId))) ||
        !validSettings(req.body?.configuracion)
      ) {
        return res.status(400).json({ error: "Invalid device name or configuration" });
      }
      const deviceId = requestedDeviceId || randomUUID();
      const token = randomBytes(32).toString("base64url");
      try {
        await db.runTransaction(async (transaction) => {
          transaction.create(devices.doc(deviceId), {
            nombre: name,
            tipo: "ultrasonico",
            activo: true,
            publicarEnDemo: req.body.publicarEnDemo === true,
            configuracion: req.body.configuracion,
            creadoEn: new Date(),
            ultimoContacto: null,
          });
          transaction.create(
            db.doc(`credencialesDispositivo/${hashDeviceToken(token)}`),
            { organizacionId: context.organizationId, dispositivoId: deviceId },
          );
        });
      } catch (error) {
        if (error.code === 6 || error.code === "already-exists") {
          return res.status(409).json({ error: "Device ID already exists" });
        }
        throw error;
      }
      return res.status(201).json({
        device: {
          id: deviceId,
          nombre: name,
          tipo: "ultrasonico",
          activo: true,
          publicarEnDemo: req.body.publicarEnDemo === true,
          configuracion: req.body.configuracion,
        },
        token,
      });
    }

    if (req.method === "PATCH") {
      const {
        dispositivoId,
        nombre,
        configuracion,
        publicarEnDemo,
        renovarCredencial,
      } = req.body || {};
      if (
        typeof dispositivoId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(dispositivoId) ||
        (nombre !== undefined && (typeof nombre !== "string" || !nombre.trim() || nombre.length > 100)) ||
        (publicarEnDemo !== undefined && typeof publicarEnDemo !== "boolean") ||
        (renovarCredencial !== undefined && typeof renovarCredencial !== "boolean") ||
        (configuracion !== undefined && !validSettings(configuracion))
      ) {
        return res.status(400).json({ error: "Invalid device update" });
      }

      if (renovarCredencial === true) {
        if (
          nombre !== undefined ||
          configuracion !== undefined ||
          publicarEnDemo !== undefined
        ) {
          return res.status(400).json({ error: "Credential renewal cannot include other updates" });
        }

        const deviceRef = devices.doc(dispositivoId);
        const token = randomBytes(32).toString("base64url");
        const credentialRef = db.doc(
          `credencialesDispositivo/${hashDeviceToken(token)}`,
        );

        await db.runTransaction(async (transaction) => {
          const deviceSnapshot = await transaction.get(deviceRef);
          if (!deviceSnapshot.exists) {
            const error = new Error("Device not found");
            error.status = 404;
            throw error;
          }
          if (deviceSnapshot.data().activo !== true) {
            const error = new Error("Device is not active");
            error.status = 409;
            throw error;
          }

          const existingCredentials = await transaction.get(
            db
              .collection("credencialesDispositivo")
              .where("dispositivoId", "==", dispositivoId),
          );
          existingCredentials.docs
            .filter(
              (document) =>
                document.data().organizacionId === context.organizationId &&
                document.data().revoked !== true,
            )
            .forEach((document) => {
              transaction.update(document.ref, { revoked: true });
            });
          transaction.create(credentialRef, {
            organizacionId: context.organizationId,
            dispositivoId,
          });
        });

        return res.status(200).json({ token, renewed: true });
      }

      const update = {};
      if (nombre !== undefined) update.nombre = nombre.trim();
      if (configuracion !== undefined) update.configuracion = configuracion;
      if (publicarEnDemo !== undefined) update.publicarEnDemo = publicarEnDemo;
      await devices.doc(dispositivoId).update(update);
      return res.status(200).json({ saved: true });
    }

    if (req.method === "DELETE") {
      const dispositivoId = req.body?.dispositivoId;
      if (
        typeof dispositivoId !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(dispositivoId)
      ) {
        return res.status(400).json({ error: "Invalid device ID" });
      }
      const credential = await db
        .collection("credencialesDispositivo")
        .where("dispositivoId", "==", dispositivoId)
        .get();
      const batch = db.batch();
      credential.docs
        .filter((document) => document.data().organizacionId === context.organizationId)
        .forEach((document) => batch.update(document.ref, { revoked: true }));
      batch.update(devices.doc(dispositivoId), { activo: false });
      await batch.commit();
      return res.status(200).json({ saved: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    return sendError(res, error);
  }
};
