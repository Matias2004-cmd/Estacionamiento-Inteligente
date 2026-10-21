const { randomUUID } = require("node:crypto");
const { getDatabase, listMemberships, verifyUser, sendError } = require("../lib/api-auth");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    res.setHeader("Cache-Control", "private, no-store");
    const user = await verifyUser(req);
    const name = typeof req.body?.nombre === "string"
      ? req.body.nombre.trim()
      : "";
    if (!name || name.length > 100) {
      return res.status(400).json({ error: "A valid organization name is required" });
    }
    const db = getDatabase();
    const memberships = await listMemberships(db, user.uid);
    if (!memberships.some((membership) => membership.role === "admin")) {
      return res.status(403).json({ error: "An organization administrator role is required" });
    }

    const organizationId = randomUUID();
    const organization = db.doc(`organizaciones/${organizationId}`);
    const member = organization.collection("miembros").doc(user.uid);
    await db.runTransaction(async (transaction) => {
      transaction.create(organization, {
        nombre: name,
        creadaEn: new Date(),
      });
      transaction.create(member, {
        uid: user.uid,
        email: user.email || null,
        role: "admin",
        creadaEn: new Date(),
      });
    });
    return res.status(201).json({ organizationId, nombre: name, role: "admin" });
  } catch (error) {
    return sendError(res, error);
  }
};
