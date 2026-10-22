import type { LandingContent } from "./types";

const ts = `import { Nova } from "@nova/sdk"

const nova = new Nova({ key: process.env.NOVA_KEY })

const ctx = await nova.context.search({
  query: "pricing que vi la semana pasada",
  project: "plan-2027",
  include: ["perceived", "meant", "wanted_done"]
})`;

const py = `import os
from nova import Nova

nova = Nova(key=os.environ["NOVA_KEY"])

ctx = nova.context.search(
    query="pricing que vi la semana pasada",
    project="plan-2027",
    include=["perceived", "meant", "wanted_done"],
)`;

const curl = `curl https://api.example.invalid/v1/context/search \\
  -H "Authorization: Bearer $NOVA_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "query": "pricing que vi la semana pasada",
    "project": "plan-2027",
    "include": ["perceived", "meant", "wanted_done"]
  }'`;

const response = `{
  "id": "cap_7Qe2",
  "perceived": "Tabla de precios, 3 planes",
  "meant": "Referencia para Plan 2027",
  "wanted_done": "Citar en propuesta",
  "connects_to": ["proj_plan2027", "cap_7Pz1"],
  "owner": "tú"
}`;

export const es: LandingContent = {
  meta: {
    locale: "es",
    title: "Nova Context — Una memoria de tu vida digital",
    description:
      "Infraestructura de contexto humano. Cifrado en tránsito y en reposo. Durante el enriquecimiento, el texto en claro se lee solo en memoria. Exportación y borrado completos.",
  },
  skip: "Saltar al contenido",
  brand: "nova context",
  homeAria: "Nova Context, inicio",
  language: { label: "Idioma", en: "English", es: "Español" },
  navLabel: "Principal",
  nav: {
    product: "Producto",
    sdk: "SDK",
    manifesto: "Manifiesto",
    privacy: "Privacidad",
    pricing: "Precios",
  },
  menu: { open: "Abrir menú", close: "Cerrar menú", label: "Menú" },
  actions: {
    signIn: "Entrar",
    start: "Empezar",
    readManifesto: "Leer el manifiesto",
    docs: "Documentación",
    createAccount: "Crear cuenta",
    copy: "Copiar",
    copied: "Copiado",
  },
  hero: {
    eyebrow: "Infraestructura de contexto humano",
    lines: ["Una memoria de tu vida digital.", "Que es tuya."],
    lede: "Una plataforma API/SDK a la que cualquier asistente se conecta.",
    promise: "Exportable por completo. Borrable, y las copias desaparecen en 35 días.",
    tags: ["percibido", "significado", "conecta con", "por hacer"],
  },
  how: {
    index: "01",
    eyebrow: "Cómo funciona",
    lines: ["El momento en que lo notas,", "preservado."],
    lede: "De la pantalla a cualquier asistente, en cuatro pasos.",
    steps: [
      {
        title: "Captura",
        body: "Un atajo explícito guarda lo que ves: pantalla, vídeo, chat.",
      },
      {
        title: "Comprende",
        body: "Qué percibiste, qué significaba, por qué importaba.",
      },
      {
        title: "Conecta",
        body: "Lo une a proyectos, personas y capturas anteriores.",
      },
      {
        title: "Entrega",
        body: "Cualquier asistente lo consulta vía API, con tu permiso.",
      },
    ],
    pipeline: "captura → comprende → conecta → entrega",
    metric: "p50 · 120 ms",
    metricNote: "Placeholder de ejemplo",
  },
  features: {
    index: "02",
    eyebrow: "Funciones",
    lines: ["No es un chatbot.", "Es la capa de debajo."],
    lede: "Memoria que cualquier asistente consulta, con un permiso que puedes revocar.",
    items: [
      {
        title: "Tuya por diseño",
        body: "Exportación y borrado completos. Sin anuncios, sin venta de tu contexto y sin entrenar modelos salvo que lo permitas.",
      },
      {
        title: "Captura explícita",
        body: "Se guarda solo cuando lo invocas, y se indica. La memoria temporal del dispositivo no se sube entera.",
      },
      {
        title: "Grafo de contexto",
        body: "Cada captura se enlaza con lo que ya sabes.",
      },
      {
        title: "API y SDK",
        body: "TypeScript y Python. Un endpoint, cualquier asistente.",
      },
      {
        title: "Línea del tiempo",
        body: "Vuelve al minuto exacto en que lo viste.",
      },
      {
        title: "Cifrado en tránsito y en reposo",
        body: "TLS 1.3 en tránsito y cifrado en reposo. El enriquecimiento lee el texto en claro en memoria, en nuestro servidor y en un proveedor de modelos cuando se usa uno.",
      },
    ],
  },
  sdk: {
    index: "03",
    eyebrow: "SDK",
    title: "Un endpoint. Cualquier asistente.",
    lede: "Pregunta por significado, no por palabras clave.",
    tabsLabel: "Ejemplo de código",
    tabs: [
      { id: "ts", label: "TypeScript", code: ts },
      { id: "py", label: "Python", code: py },
      { id: "curl", label: "cURL", code: curl },
    ],
    responseLabel: "Respuesta · 200 · 118 ms",
    example: "Placeholder de ejemplo",
    response,
  },
  privacy: {
    index: "04",
    eyebrow: "Privacidad",
    title: "Es / no es.",
    lede: "Los compromisos están escritos en la arquitectura y en los términos.",
    rows: [
      { label: "Nova es", value: "Infraestructura de contexto humano" },
      { label: "Nova no es", value: "Un chatbot, ni una app de notas, ni otro asistente" },
      { label: "Tu memoria", value: "Exportación y borrado completos. Las copias caducan en 35 días." },
      { label: "La captura", value: "Al invocarla e indicada, nunca en segundo plano" },
      {
        label: "El contexto",
        value: "Nunca se vende, nunca se usa para anuncios y no entrena modelos salvo que lo permitas",
      },
      {
        label: "Cifrado",
        value:
          "TLS 1.3 en tránsito y cifrado en reposo. Durante el enriquecimiento, el texto en claro solo está en memoria, también en un proveedor de modelos cuando se usa uno.",
      },
    ],
  },
  pricing: {
    eyebrow: "Precios · ilustrativos",
    badge: "Placeholder de ejemplo",
    lines: ["Paga por memoria,", "no por tus datos."],
    note: "Placeholder de ejemplo. Estos precios y límites no son una oferta.",
    plans: [
      {
        name: "Personal",
        price: "$0",
        period: "Para uso individual",
        cta: "Empezar",
        variant: "secondary",
        items: ["1.000 capturas/mes", "Exportación completa", "SDK con 1 asistente", "Cifrado en tránsito y en reposo"],
      },
      {
        name: "Pro",
        price: "$12",
        period: "/mes",
        cta: "Probar Pro",
        variant: "primary",
        recommended: "Recomendado",
        items: [
          "Capturas ilimitadas",
          "Asistentes ilimitados",
          "Búsqueda por significado",
          "Cifrado en tránsito y en reposo",
        ],
      },
      {
        name: "Equipos",
        price: "$24",
        period: "/usuario/mes",
        cta: "Empezar",
        variant: "secondary",
        items: [
          "Proyectos compartidos",
          "Permisos por persona",
          "Registro de auditoría",
          "Cifrado en tránsito y en reposo",
        ],
      },
    ],
  },
  faq: {
    index: "05",
    eyebrow: "Preguntas",
    title: "Preguntas frecuentes.",
    lede: "Lo que conviene saber antes de empezar.",
    items: [
      {
        q: "¿Nova graba mi pantalla todo el tiempo?",
        a: "No. Solo guarda lo que capturas con un gesto explícito, y siempre se indica.",
        open: true,
      },
      {
        q: "¿Qué asistentes son compatibles?",
        a: "Cualquier asistente que hable la API. Un endpoint, y solo con el permiso que tú das. Los demás se conectan con el SDK de TypeScript o de Python.",
      },
      {
        q: "¿Puedo exportar mi memoria?",
        a: "Sí. Puedes exportar momentos, memoria y el registro de auditoría. El borrado elimina el contenido, los embeddings y los enlaces, y las copias caducan en 35 días.",
      },
      {
        q: "¿Dónde se guardan mis datos?",
        a: "La memoria temporal del dispositivo no se sube entera. Lo que decides conservar va cifrado en tránsito y en reposo. Durante el enriquecimiento el servidor procesa el texto en claro en memoria y no lo conserva después. La misma ventana aplica en un proveedor de modelos cuando se usa uno. Un proyecto puede quedarse en el dispositivo y no llegar nunca a la nube.",
      },
      {
        q: "¿Funciona sin conexión?",
        a: "Nova no graba en segundo plano. Una captura que no se puede entregar falla a la vista, y la repites. La memoria fijada al dispositivo se queda ahí. Lo que solo vive en la nube necesita conexión para consultarse.",
      },
    ],
  },
  cta: {
    title: "Empieza a recordar.",
    lede: "Gratis para uso personal. Tu memoria, exportable desde el primer día.",
  },
  footer: {
    tagline: "Infraestructura de contexto humano. Tu memoria es tuya.",
    product: "Producto",
    resources: "Recursos",
    privacy: "Privacidad",
    links: {
      capture: "Captura",
      sdk: "SDK",
      pricing: "Precios",
      manifesto: "Manifiesto",
      docs: "Documentación",
      status: "Estado",
      export: "Exportar",
      erase: "Borrar",
      policy: "Política",
    },
  },
};
