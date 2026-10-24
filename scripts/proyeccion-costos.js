// Calcula consumo y costo mensual para 1, 10, 100 y 1.000 dispositivos.
// Edita PRECIOS y MODELO si cambian las tarifas o las mediciones reales, y vuelve a ejecutar:
//   npm run proyeccion
// Fuentes (consultadas el 23-10-2026):
//   Firestore Standard, Santiago (southamerica-west1): https://cloud.google.com/firestore/pricing
//   Cuota gratuita Firestore: https://firebase.google.com/docs/firestore/pricing
//   Vercel Hobby/Pro: https://vercel.com/docs/limits/fair-use-guidelines y https://vercel.com/pricing

const PRECIOS = {
  firestore: {
    lecturaPor100k: 0.043,
    escrituraPor100k: 0.129,
    gibMes: 0.215,
    gratisLecturasDia: 50000,
    gratisEscriturasDia: 20000,
    gratisGib: 1,
  },
  vercel: {
    proBaseMes: 20, // incluye US$20 de crédito de uso
    proCreditoMes: 20,
    invocacionPorMillon: 0.6,
    cpuHora: 0.128,
    memoriaGbHora: 0.0106,
    hobbyInvocacionesMes: 1000000,
    hobbyCpuHorasMes: 4,
    hobbyMemoriaGbHoraMes: 360,
  },
};

// Consumo diario de UN dispositivo con el diseño actual (ver docs/evaluacion-uso.md).
const MODELO = {
  escriturasDia: 1440 + 288 + 288, // agregados por minuto + estado por lote + último contacto (máximo)
  lecturasDia: 2 * 288 + 2 * 1440, // autenticación en cada lote + sondeo de configuración cada 60 s
  invocacionesDia: 288 + 1440, // POST /api/mediciones por lote + GET de configuración
  bytesPorDocumento: 1100, // documento + 4 entradas de índice (periodoInicio y sensorId)
  // Dashboard: 3 usuarios × 4 sesiones × ~240 lecturas por cada organización de 10 dispositivos
  lecturasDashboardDiaPorOrg: 2900,
  invocacionesDashboardDiaPorOrg: 60,
  dispositivosPorOrg: 10,
  // Supuestos de ejecución de cada función (medir en Vercel > Observability)
  cpuSegundosPorInvocacion: 0.02,
  duracionSegundosPorInvocacion: 0.3,
  memoriaGb: 2,
};

const DIAS_MES = 30;
const usd = (valor) => `US$ ${valor.toFixed(2)}`;
const miles = (valor) => Math.round(valor).toLocaleString("es-CL");

function proyectar(dispositivos) {
  const organizaciones = Math.ceil(dispositivos / MODELO.dispositivosPorOrg);
  const escriturasDia = dispositivos * MODELO.escriturasDia;
  const lecturasDia = dispositivos * MODELO.lecturasDia + organizaciones * MODELO.lecturasDashboardDiaPorOrg;
  const invocacionesMes = DIAS_MES * (dispositivos * MODELO.invocacionesDia + organizaciones * MODELO.invocacionesDashboardDiaPorOrg);
  const gibAnio = (dispositivos * 1440 * 365 * MODELO.bytesPorDocumento) / 1024 ** 3;

  const f = PRECIOS.firestore;
  const costoEscrituras = (Math.max(0, escriturasDia - f.gratisEscriturasDia) * DIAS_MES * f.escrituraPor100k) / 1e5;
  const costoLecturas = (Math.max(0, lecturasDia - f.gratisLecturasDia) * DIAS_MES * f.lecturaPor100k) / 1e5;
  const costoAlmacenamiento = Math.max(0, gibAnio - f.gratisGib) * f.gibMes;

  const v = PRECIOS.vercel;
  const cpuHoras = (invocacionesMes * MODELO.cpuSegundosPorInvocacion) / 3600;
  const memoriaGbHora = (invocacionesMes * MODELO.duracionSegundosPorInvocacion * MODELO.memoriaGb) / 3600;
  const usoVercel = (invocacionesMes / 1e6) * v.invocacionPorMillon + cpuHoras * v.cpuHora + memoriaGbHora * v.memoriaGbHora;
  const cabeEnHobby = invocacionesMes <= v.hobbyInvocacionesMes && cpuHoras <= v.hobbyCpuHorasMes && memoriaGbHora <= v.hobbyMemoriaGbHoraMes;
  const costoVercelPro = v.proBaseMes + Math.max(0, usoVercel - v.proCreditoMes);

  return {
    dispositivos,
    escriturasDia,
    lecturasDia,
    pctEscrituras: (100 * escriturasDia) / f.gratisEscriturasDia,
    pctLecturas: (100 * lecturasDia) / f.gratisLecturasDia,
    invocacionesMes,
    cpuHoras,
    memoriaGbHora,
    gibAnio,
    costoFirestore: costoEscrituras + costoLecturas + costoAlmacenamiento,
    costoEscrituras,
    costoLecturas,
    costoAlmacenamiento,
    cabeEnHobby,
    costoVercelPro,
  };
}

console.log("| Dispositivos | Escrituras/día (% cuota) | Lecturas/día (% cuota) | Invocaciones/mes | GiB al año | Firestore Blaze/mes | Vercel |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | --- |");
for (const n of [1, 10, 100, 1000]) {
  const p = proyectar(n);
  const vercel = p.cabeEnHobby ? "Hobby (US$ 0)" : `Pro ${usd(p.costoVercelPro)}`;
  console.log(`| ${miles(n)} | ${miles(p.escriturasDia)} (${p.pctEscrituras.toFixed(0)} %) | ${miles(p.lecturasDia)} (${p.pctLecturas.toFixed(0)} %) | ${miles(p.invocacionesMes)} | ${p.gibAnio.toFixed(2)} | ${usd(p.costoFirestore)} | ${vercel} |`);
}

const limiteEscrituras = PRECIOS.firestore.gratisEscriturasDia / MODELO.escriturasDia;
const limiteLecturas = PRECIOS.firestore.gratisLecturasDia / (MODELO.lecturasDia + MODELO.lecturasDashboardDiaPorOrg / MODELO.dispositivosPorOrg);
const limiteInvocaciones = PRECIOS.vercel.hobbyInvocacionesMes / DIAS_MES / (MODELO.invocacionesDia + MODELO.invocacionesDashboardDiaPorOrg / MODELO.dispositivosPorOrg);
const diasAlmacenamiento = (PRECIOS.firestore.gratisGib * 1024 ** 3) / (1440 * MODELO.bytesPorDocumento);
console.log("\nDispositivos que caben en la capa gratuita:");
console.log(`  escrituras Firestore: ${limiteEscrituras.toFixed(1)}`);
console.log(`  lecturas Firestore:   ${limiteLecturas.toFixed(1)}`);
console.log(`  invocaciones Vercel:  ${limiteInvocaciones.toFixed(1)}`);
console.log(`Almacenamiento de 1 dispositivo hasta 1 GiB: ${miles(diasAlmacenamiento)} días (${(diasAlmacenamiento / 365).toFixed(1)} años)`);
