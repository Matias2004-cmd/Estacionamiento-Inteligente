const {
  getDatabase,
  listMemberships,
  sendError,
  verifyUser,
} = require("../lib/api-auth");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    res.setHeader("Cache-Control", "private, no-store");
    const user = await verifyUser(req);
    const memberships = await listMemberships(getDatabase(), user.uid);
    return res.status(200).json({
      user: { uid: user.uid, email: user.email || null },
      organizations: memberships,
    });
  } catch (error) {
    return sendError(res, error);
  }
};
