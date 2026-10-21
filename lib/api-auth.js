const { createHash } = require("node:crypto");
const { getApps, initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

function getApp() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
  }

  if (getApps().length === 0) {
    initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
  }
  return getApps()[0];
}

function getDatabase() {
  getApp();
  return getFirestore();
}

function getBearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  return match ? match[1].trim() : null;
}

async function verifyUser(req) {
  const token = getBearerToken(req);
  if (!token) {
    const error = new Error("Authentication required");
    error.status = 401;
    throw error;
  }
  const auth = getAuth(getApp());
  let user;
  try {
    user = await auth.verifyIdToken(token);
  } catch {
    const error = new Error("Invalid or expired authentication token");
    error.status = 401;
    throw error;
  }
  if (!user.email_verified) {
    const error = new Error("Email verification required");
    error.status = 403;
    throw error;
  }
  return user;
}

async function getMembership(db, uid, organizationId) {
  const snapshot = await db
    .doc(`organizaciones/${organizationId}/miembros/${uid}`)
    .get();
  return snapshot.exists ? snapshot.data() : null;
}

async function listMemberships(db, uid) {
  const snapshot = await db
    .collectionGroup("miembros")
    .where("uid", "==", uid)
    .get();
  return Promise.all(snapshot.docs.map(async (document) => {
    const organization = await document.ref.parent.parent.get();
    return {
      id: document.ref.parent.parent.id,
      nombre: organization.data()?.nombre || document.ref.parent.parent.id,
      ...document.data(),
    };
  }));
}

async function requireOrganization(req, db, requestedOrganizationId) {
  const user = await verifyUser(req);
  if (
    typeof requestedOrganizationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(requestedOrganizationId)
  ) {
    const error = new Error("Invalid organization");
    error.status = 400;
    throw error;
  }
  const membership = await getMembership(db, user.uid, requestedOrganizationId);
  if (!membership || !["admin", "operator"].includes(membership.role)) {
    const error = new Error("Organization access denied");
    error.status = 403;
    throw error;
  }
  return { user, membership, organizationId: requestedOrganizationId };
}

async function requireOrganizationAdmin(req, db, requestedOrganizationId) {
  const context = await requireOrganization(req, db, requestedOrganizationId);
  if (context.membership.role !== "admin") {
    const error = new Error("Organization administrator role required");
    error.status = 403;
    throw error;
  }
  return context;
}

function hashDeviceToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function authenticateDevice(req, db) {
  const token = getBearerToken(req);
  if (!token || token.length < 32 || token.length > 512) {
    const error = new Error("Device authentication required");
    error.status = 401;
    throw error;
  }
  const credential = await db
    .doc(`credencialesDispositivo/${hashDeviceToken(token)}`)
    .get();
  if (!credential.exists || credential.data().revoked === true) {
    const error = new Error("Invalid device credential");
    error.status = 401;
    throw error;
  }
  return { token, ...credential.data() };
}

function sendError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) {
    console.error("API request failed:", error.message);
  }
  return res.status(status).json({
    error: status >= 500 ? "Internal server error" : error.message,
  });
}

module.exports = {
  authenticateDevice,
  getApp,
  getBearerToken,
  getDatabase,
  getMembership,
  hashDeviceToken,
  listMemberships,
  requireOrganization,
  requireOrganizationAdmin,
  sendError,
  verifyUser,
};
