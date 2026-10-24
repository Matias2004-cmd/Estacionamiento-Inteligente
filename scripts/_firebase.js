// Inicializa Firebase Admin para scripts locales sin guardar credenciales en el repositorio.
// Orden de búsqueda: --credencial <ruta>, FIREBASE_SERVICE_ACCOUNT_JSON (contenido)
// o GOOGLE_APPLICATION_CREDENTIALS (ruta a un archivo fuera del repositorio).
const { readFileSync } = require("node:fs");
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

function argumento(nombre) {
  const index = process.argv.indexOf(`--${nombre}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function leerCuentaDeServicio() {
  const ruta = argumento("credencial") || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (ruta) return JSON.parse(readFileSync(ruta, "utf8"));
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  throw new Error(
    "Indica la cuenta de servicio con --credencial <ruta>, GOOGLE_APPLICATION_CREDENTIALS o FIREBASE_SERVICE_ACCOUNT_JSON.",
  );
}

function obtenerFirestore() {
  if (getApps().length === 0) {
    initializeApp({ credential: cert(leerCuentaDeServicio()) });
  }
  const db = getFirestore();
  db.settings({ preferRest: true });
  return db;
}

function coleccionMediciones(db, organizacion) {
  if (organizacion === undefined) return db.collection("mediciones");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(organizacion)) {
    throw new Error("--organizacion debe ser un ID válido.");
  }
  return db.collection("organizaciones").doc(organizacion).collection("mediciones");
}

module.exports = { argumento, coleccionMediciones, obtenerFirestore };
