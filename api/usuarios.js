const { randomBytes } = require("node:crypto");
const { getAuth } = require("firebase-admin/auth");
const { getApp, getDatabase, requireOrganizationAdmin, sendError } = require("../lib/api-auth");

const validRole = (role) => role === "admin" || role === "operator";

module.exports = async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "private, no-store");
    const db = getDatabase();
    const organizationId = req.method === "GET"
      ? req.query?.organizacion
      : req.body?.organizacion;
    const context = await requireOrganizationAdmin(req, db, organizationId);
    const members = db
      .collection("organizaciones")
      .doc(context.organizationId)
      .collection("miembros");

    if (req.method === "GET") {
      const snapshot = await members.orderBy("email").get();
      return res.status(200).json({
        users: snapshot.docs.map((document) => ({
          uid: document.id,
          ...document.data(),
        })),
      });
    }

    if (req.method === "POST") {
      const email = typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
      const role = req.body?.role;
      if (
        typeof email !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !validRole(role)
      ) {
        return res.status(400).json({ error: "Valid email and role are required" });
      }

      const auth = getAuth(getApp());
      let account;
      let created = false;
      try {
        account = await auth.getUserByEmail(email);
      } catch (error) {
        if (error.code !== "auth/user-not-found") throw error;
        account = await auth.createUser({
          email,
          password: randomBytes(32).toString("base64url"),
          emailVerified: false,
        });
        created = true;
      }
      const memberRef = members.doc(account.uid);
      if ((await memberRef.get()).exists) {
        return res.status(409).json({ error: "User is already a member" });
      }
      let passwordResetLink = null;
      if (created) {
        try {
          passwordResetLink = await auth.generatePasswordResetLink(email);
        } catch (error) {
          await auth.deleteUser(account.uid);
          throw error;
        }
      }
      try {
        await memberRef.create({
          uid: account.uid,
          email: account.email,
          role,
          creadoEn: new Date(),
        });
      } catch (error) {
        if (created) await auth.deleteUser(account.uid);
        throw error;
      }
      return res.status(201).json({
        user: { uid: account.uid, email: account.email, role },
        passwordResetLink,
      });
    }

    if (req.method === "PATCH") {
      const { uid, role } = req.body || {};
      if (typeof uid !== "string" || uid === context.user.uid || !validRole(role)) {
        return res.status(400).json({ error: "A different member UID and valid role are required" });
      }
      const memberRef = members.doc(uid);
      await db.runTransaction(async (transaction) => {
        const [target, allMembers] = await Promise.all([
          transaction.get(memberRef),
          transaction.get(members),
        ]);
        if (!target.exists) {
          const error = new Error("Member not found");
          error.status = 404;
          throw error;
        }
        const adminCount = allMembers.docs.filter(
          (document) => document.data().role === "admin",
        ).length;
        if (target.data().role === "admin" && role !== "admin" && adminCount <= 1) {
          const error = new Error("The last organization admin cannot be demoted");
          error.status = 409;
          throw error;
        }
        transaction.update(memberRef, { role, actualizadoEn: new Date() });
      });
      return res.status(200).json({ saved: true });
    }

    if (req.method === "DELETE") {
      const uid = req.body?.uid;
      if (typeof uid !== "string" || uid === context.user.uid) {
        return res.status(400).json({ error: "A different member UID is required" });
      }
      const memberRef = members.doc(uid);
      await db.runTransaction(async (transaction) => {
        const [target, allMembers] = await Promise.all([
          transaction.get(memberRef),
          transaction.get(members),
        ]);
        if (!target.exists) {
          const error = new Error("Member not found");
          error.status = 404;
          throw error;
        }
        const adminCount = allMembers.docs.filter(
          (document) => document.data().role === "admin",
        ).length;
        if (target.data().role === "admin" && adminCount <= 1) {
          const error = new Error("The last organization admin cannot be removed");
          error.status = 409;
          throw error;
        }
        transaction.delete(memberRef);
      });
      return res.status(200).json({ removed: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    return sendError(res, error);
  }
};
