const { getAuth } = require("firebase-admin/auth");
const {
  getApp,
  getDatabase,
  sendError,
  verifyUser,
} = require("../lib/api-auth");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    res.setHeader("Cache-Control", "private, no-store");
    const user = await verifyUser(req);
    const configuredEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase();
    const organizationId = process.env.BOOTSTRAP_ORGANIZATION_ID;
    const organizationName = process.env.BOOTSTRAP_ORGANIZATION_NAME;
    const emailVerified = await getAuth(getApp()).getUser(user.uid);
    if (
      !configuredEmail ||
      !organizationId ||
      !organizationName ||
      user.email?.toLowerCase() !== configuredEmail ||
      !emailVerified.emailVerified ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(organizationId)
    ) {
      return res.status(403).json({ error: "Bootstrap is not authorized" });
    }

    const db = getDatabase();
    const organization = db.doc(`organizaciones/${organizationId}`);
    const member = organization.collection("miembros").doc(user.uid);
    await db.runTransaction(async (transaction) => {
      const [organizationSnapshot, memberSnapshot] = await Promise.all([
        transaction.get(organization),
        transaction.get(member),
      ]);
      if (organizationSnapshot.exists || memberSnapshot.exists) {
        const error = new Error("Organization bootstrap has already been used");
        error.status = 409;
        throw error;
      }
      transaction.create(organization, {
        nombre: organizationName,
        creadaEn: new Date(),
      });
      transaction.create(member, {
        uid: user.uid,
        email: user.email,
        role: "admin",
        creadaEn: new Date(),
      });
    });
    return res.status(201).json({ organizationId, role: "admin" });
  } catch (error) {
    return sendError(res, error);
  }
};
