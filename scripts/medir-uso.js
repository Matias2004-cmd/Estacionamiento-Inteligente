// Cuenta las mediciones guardadas por día y estima el almacenamiento, para el informe de uso.
// Usa consultas count(): cuestan 1 lectura por cada 1.000 entradas de índice, no una por documento.
//
//   node scripts/medir-uso.js --credencial C:\ruta\fuera-del-repo.json --organizacion <id> --dias 8
//
// Sin --organizacion mide la colección pública `mediciones`.
const { Timestamp } = require("firebase-admin/firestore");
const { argumento, coleccionMediciones, obtenerFirestore } = require("./_firebase");

// Tamaño de documento según https://firebase.google.com/docs/firestore/storage-size
function tamanoValor(valor) {
  if (valor === null || typeof valor === "boolean") return 1;
  if (typeof valor === "number") return 8;
  if (typeof valor === "string") return Buffer.byteLength(valor) + 1;
  if (valor && typeof valor.toDate === "function") return 8;
  if (Array.isArray(valor)) return valor.reduce((total, item) => total + tamanoValor(item), 0);
  if (typeof valor === "object") {
    return Object.entries(valor).reduce(
      (total, [campo, item]) => total + Buffer.byteLength(campo) + 1 + tamanoValor(item),
      0,
    );
  }
  return 0;
}

function tamanoDocumento(documento) {
  const nombre = documento.ref.path
    .split("/")
    .reduce((total, segmento) => total + Buffer.byteLength(segmento) + 1, 16);
  return nombre + tamanoValor(documento.data()) + 32;
}

async function main() {
  const dias = Number.parseInt(argumento("dias") || "8", 10);
  const db = obtenerFirestore();
  const coleccion = coleccionMediciones(db, argumento("organizacion"));
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  console.log("Día (hora local)  Documentos");
  let total = 0;
  for (let i = dias - 1; i >= 0; i--) {
    const inicio = new Date(hoy.getTime() - i * 86400000);
    const fin = new Date(inicio.getTime() + 86400000);
    const conteo = await coleccion
      .where("periodoInicio", ">=", Timestamp.fromDate(inicio))
      .where("periodoInicio", "<", Timestamp.fromDate(fin))
      .count()
      .get();
    const cantidad = conteo.data().count;
    total += cantidad;
    console.log(`${inicio.toLocaleDateString("es-CL").padEnd(17)} ${String(cantidad).padStart(10)}  (${((cantidad / 1440) * 100).toFixed(1)}% de 1.440 minutos)`);
  }

  const muestra = await coleccion.orderBy("periodoInicio", "desc").limit(1).get();
  if (muestra.empty) {
    console.log("No hay documentos para estimar el tamaño.");
    return;
  }
  const bytes = tamanoDocumento(muestra.docs[0]);
  console.log(`\nTotal en ${dias} días: ${total} documentos`);
  console.log(`Tamaño de un documento (sin índices): ${bytes} bytes`);
  console.log(`Almacenamiento estimado de esos documentos: ${((total * bytes) / 1024 / 1024).toFixed(2)} MiB (más índices automáticos)`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
