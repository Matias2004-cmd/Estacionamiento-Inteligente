module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  const appId = process.env.FIREBASE_WEB_APP_ID;
  if (!projectId || !apiKey || !appId) {
    return res.status(503).json({ error: "Firebase web configuration is missing" });
  }

  return res.status(200).json({
    apiKey,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
    projectId,
    appId,
  });
};
