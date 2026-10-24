// Verificación rápida sin credenciales: carga cada endpoint, valida los JSON de
// configuración y prueba respuestas que no dependen de Firestore.
const { readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const raiz = path.join(__dirname, "..");

function respuestaFalsa() {
  return {
    headers: {},
    setHeader(nombre, valor) { this.headers[nombre] = valor; },
    status(codigo) { this.codigo = codigo; return this; },
    json(cuerpo) { this.cuerpo = cuerpo; return this; },
  };
}

async function main() {
  for (const archivo of ["firebase.json", "firestore.indexes.json", "package.json", "vercel.json"]) {
    try {
      JSON.parse(readFileSync(path.join(raiz, archivo), "utf8"));
      console.log(`✓ ${archivo} es JSON válido`);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error(`${archivo}: ${error.message}`);
    }
  }

  const endpoints = readdirSync(path.join(raiz, "api")).filter((nombre) => nombre.endsWith(".js"));
  for (const nombre of endpoints) {
    const handler = require(path.join(raiz, "api", nombre));
    assert.equal(typeof handler, "function", `${nombre} debe exportar un handler`);
  }
  console.log(`✓ ${endpoints.length} endpoints cargan correctamente`);

  const publica = require(path.join(raiz, "api", "configuracion-publica.js"));
  const sinConfig = respuestaFalsa();
  const respaldo = { ...process.env };
  delete process.env.FIREBASE_PROJECT_ID;
  publica({ method: "GET" }, sinConfig);
  assert.equal(sinConfig.codigo, 503);
  Object.assign(process.env, { FIREBASE_PROJECT_ID: "p", FIREBASE_WEB_API_KEY: "k", FIREBASE_WEB_APP_ID: "a" });
  const conConfig = respuestaFalsa();
  publica({ method: "GET" }, conConfig);
  assert.equal(conConfig.codigo, 200);
  assert.equal(conConfig.cuerpo.authDomain, "p.firebaseapp.com");
  process.env = respaldo;
  console.log("✓ /api/configuracion-publica responde según las variables de entorno");

  const sesion = require(path.join(raiz, "api", "sesion.js"));
  const metodo = respuestaFalsa();
  await sesion({ method: "POST", headers: {} }, metodo);
  assert.equal(metodo.codigo, 405);
  console.log("✓ los endpoints rechazan métodos no permitidos");

  const { hashDeviceToken } = require(path.join(raiz, "lib", "api-auth.js"));
  assert.match(hashDeviceToken("x".repeat(43)), /^[0-9a-f]{64}$/);
  console.log("✓ los tokens de dispositivo se guardan como hash SHA-256");
  console.log("\nVerificación completada.");
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
});
