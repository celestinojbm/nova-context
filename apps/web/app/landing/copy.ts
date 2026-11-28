export type LandingLang = "en" | "es";

export interface LandingSection {
  title: string;
  body: string;
}

export interface LandingCopy {
  h1Lead: string;
  h1Rest: string;
  lede: string;
  signIn: string;
  demoLabel: string;
  demoNote: string;
  placeholder: string;
  traceLabel: string;
  traceDone: string;
  traceSteps: string[];
  sentLabel: string;
  sentDone: string;
  sentSteps: (excerpt: string) => string[];
  sourcePage: string;
  sourcePageHint: string;
  sourceProject: string;
  sourceProjectHint: string;
  sourceMemory: string;
  sourceMemoryHint: string;
  commandSave: string;
  commandLink: string;
  commandTask: string;
  commandRecall: string;
  modelDevice: string;
  modelCloud: string;
  efforts: string[];
  sections: LandingSection[];
  license: string;
}

export const landingCopy: Record<LandingLang, LandingCopy> = {
  en: {
    h1Lead: "Keep the moment",
    h1Rest: "you noticed.",
    lede: "Nova Context sits under the assistants you already use. You invoke it, it shows you what it sees, and you say what that moment means. Private alpha — the context stays on your account.",
    signIn: "Sign in",
    demoLabel: "Preview the loop",
    demoNote: "This preview stays in the browser. It does not capture, store, or send anything.",
    placeholder: "Say what this moment means",
    traceLabel: "Tracing the moment",
    traceDone: "Trace ready",
    traceSteps: [
      "Read the frame you invoked",
      "Keep your words verbatim",
      "Suggest a project and a task",
      "Wait until you confirm",
    ],
    sentLabel: "Tracing this instruction",
    sentDone: "Trace ready",
    sentSteps: (excerpt) => [
      `Heard “${excerpt}”`,
      "Look for a project this belongs to",
      "Draft a task you can confirm",
      "Leave your words unchanged",
    ],
    sourcePage: "This page",
    sourcePageHint: "What is on screen now",
    sourceProject: "This project",
    sourceProjectHint: "Where the moment should land",
    sourceMemory: "Your memory",
    sourceMemoryHint: "What you already kept",
    commandSave: "File this moment",
    commandLink: "Attach it to a project",
    commandTask: "Draft a task to confirm",
    commandRecall: "Search what you already kept",
    modelDevice: "On this device",
    modelCloud: "Cloud, if you opt in",
    efforts: ["Low", "Medium", "High", "Extra", "Max"],
    sections: [
      {
        title: "Capture only when you ask.",
        body: "Nova stays quiet until you invoke it. There is no always-on recording. A short local buffer, if you turn it on, stays on your device and is not uploaded wholesale.",
      },
      {
        title: "Memory you can take with you.",
        body: "Search what you kept. Export the account. Delete it. Context is not a feed, and it is not sold.",
      },
      {
        title: "Action waits for you.",
        body: "Saving, linking, and anything that leaves your account stops for a confirmation. You see the words you said before anything is written.",
      },
    ],
    license:
      "ScrollReveal, PromptBar, and ThoughtLine are from React Bits by David Haz, MIT with the Commons Clause. Fine to use here. Not redistributed as a kit, and not React Bits Pro.",
  },
  es: {
    h1Lead: "Conserva el momento",
    h1Rest: "que notaste.",
    lede: "Nova Context está debajo de los asistentes que ya usas. Lo invocas, te muestra lo que ve, y dices qué significa ese momento. Alfa privada: el contexto se queda en tu cuenta.",
    signIn: "Entrar",
    demoLabel: "Vista previa del ciclo",
    demoNote: "Esta vista previa se queda en el navegador. No captura, no guarda y no envía nada.",
    placeholder: "Di qué significa este momento",
    traceLabel: "Trazando el momento",
    traceDone: "Traza lista",
    traceSteps: [
      "Leer el encuadre que invocaste",
      "Conservar tus palabras tal cual",
      "Sugerir un proyecto y una tarea",
      "Esperar hasta que confirmes",
    ],
    sentLabel: "Trazando esta instrucción",
    sentDone: "Traza lista",
    sentSteps: (excerpt) => [
      `Escuché “${excerpt}”`,
      "Buscar un proyecto al que pertenezca",
      "Redactar una tarea para que confirmes",
      "Dejar tus palabras intactas",
    ],
    sourcePage: "Esta página",
    sourcePageHint: "Lo que hay en pantalla ahora",
    sourceProject: "Este proyecto",
    sourceProjectHint: "Dónde debe quedar el momento",
    sourceMemory: "Tu memoria",
    sourceMemoryHint: "Lo que ya guardaste",
    commandSave: "Archivar este momento",
    commandLink: "Vincularlo a un proyecto",
    commandTask: "Redactar una tarea para confirmar",
    commandRecall: "Buscar lo que ya guardaste",
    modelDevice: "En este dispositivo",
    modelCloud: "Nube, si lo activas",
    efforts: ["Bajo", "Medio", "Alto", "Extra", "Máximo"],
    sections: [
      {
        title: "Captura solo cuando lo pides.",
        body: "Nova permanece en silencio hasta que lo invocas. No hay grabación continua. Un búfer local breve, si lo activas, se queda en tu dispositivo y no se sube entero.",
      },
      {
        title: "Memoria que puedes llevarte.",
        body: "Busca lo que guardaste. Exporta la cuenta. Bórrala. El contexto no es un feed y no se vende.",
      },
      {
        title: "La acción espera tu confirmación.",
        body: "Guardar, vincular y cualquier cosa que salga de tu cuenta se detiene para que confirmes. Ves tus palabras antes de que se escriba nada.",
      },
    ],
    license:
      "ScrollReveal, PromptBar y ThoughtLine son de React Bits, de David Haz, MIT con Commons Clause. Se pueden usar aquí. No se redistribuyen como un kit, y no son React Bits Pro.",
  },
};
