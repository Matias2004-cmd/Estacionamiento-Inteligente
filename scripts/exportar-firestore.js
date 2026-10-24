// Exporta mediciones de un rango de fechas a CSV y JSON en ./exportaciones (ignorado por git).
// Cada documento exportado consume 1 lectura de Firestore: usa rangos acotados.
//
//   node scripts/exportar-firestore.js --credencial C:\ruta\fuera-del-repo.json \
//     --organizacion <id> --desde 2026-10-15T18:35:00-03:00 --hasta 2026-10-22T18:35:00-03:00
//
// Sin --organizacion exporta la colección pública de demostración `mediciones`.
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { FieldPath, Timestamp } = require("firebase-admin/firestore");
const { argumento, coleccionMediciones, obtenerFirestore } = require("./_firebase");

const COLUMNAS = [
  "id",
  "sensorId",
  "periodoInicio",
  "estado",
  "distanciaCm",
  "distanciaMinCm",
  "distanciaMaxCm",
  "muestras",
  "deteccionesIr",
  "ingresosConfirmados",
  "timestamp",
];

function aTexto(valor) {
  if (valor && typeof valor.toDate === "function") return valor.toDate().toISOString();
  return valor ?? "";
}

async function main() {
  const desde = argumento("desde");
  const hasta = argumento("hasta");
  const maximo = Number.parseInt(argumento("max") || "20000", 10);
  if (!desde || !hasta || !Number.isFinite(Date.parse(desde)) || !Number.isFinite(Date.parse(hasta))) {
    throw new Error("Indica --desde y --hasta en formato ISO-8601.");
  }

  const db = obtenerFirestore();
  const coleccion = coleccionMediciones(db, argumento("organizacion"));
  const filas = [];
  let ultimo = null;
  while (filas.length < maximo) {
    let consulta = coleccion
      .where("periodoInicio", ">=", Timestamp.fromDate(new Date(desde)))
      .where("periodoInicio", "<=", Timestamp.fromDate(new Date(hasta)))
      .orderBy("periodoInicio")
      .orderBy(FieldPath.documentId())
      .limit(Math.min(500, maximo - filas.length));
    if (ultimo) consulta = consulta.startAfter(ultimo.get("periodoInicio"), ultimo.id);
    const pagina = await consulta.get();
    if (pagina.empty) break;
    for (const documento of pagina.docs) {
      const datos = documento.data();
      filas.push(Object.fromEntries(COLUMNAS.map((columna) => [
        columna,
        columna === "id" ? documento.id : aTexto(datos[columna]),
      ])));
    }
    ultimo = pagina.docs.at(-1);
    console.log(`Leídos: ${filas.length}`);
  }

  const carpeta = path.join(__dirname, "..", "exportaciones");
  mkdirSync(carpeta, { recursive: true });
  const base = path.join(carpeta, `mediciones-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const csv = [COLUMNAS.join(",")]
    .concat(filas.map((fila) => COLUMNAS.map((columna) => JSON.stringify(String(fila[columna]))).join(",")))
    .join("\n");
  writeFileSync(`${base}.csv`, csv);
  writeFileSync(`${base}.json`, JSON.stringify(filas, null, 2));
  console.log(`Exportados ${filas.length} documentos (${filas.length} lecturas) en ${base}.csv/.json`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
