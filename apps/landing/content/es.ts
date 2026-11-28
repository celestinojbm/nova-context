import {
  MESSAGE_ERROR,
  MESSAGE_INVALID,
  MESSAGE_OK,
  MESSAGE_TOO_LONG,
  MESSAGE_UNCONFIGURED,
  MESSAGE_UNREADABLE,
} from "@/lib/sheets-contact";
import type { LandingCopy } from "./types";

const same = (message: string) => message;

export const es: LandingCopy = {
  lang: "es",
  meta: {
    title: "Nova Context",
    description:
      "La capa bajo los asistentes. Capturas lo que ves, dices qué significa y confirmas antes de que nada se guarde o salga.",
  },
  language: { href: "/en", label: "EN", hrefLang: "en" },
  nav: { how: "Cómo funciona", modes: "Modos", approval: "Aprobación", what: "Qué es" },
  hero: {
    eyebrow: "Infraestructura de contexto humano",
    title: "Lo que ves, dicho con tus palabras,",
    titleMuted: "queda donde pertenece.",
    lede: "Nova Context no es un chat ni un cuaderno. Es la capa debajo de los asistentes: capturas lo que estás viendo, dices qué significa para ti y qué quieres hacer con ello, y eso queda como un momento tuyo. Lo ves antes de que se guarde, y nada sale hacia fuera si tú no lo confirmas.",
    tags: ["percibes", "significa", "conecta con", "quieres hacer"],
  },
  demo: {
    kicker: "Demostración",
    note: "Nada de lo que escribas aquí se guarda. Es el gesto: dices qué quieres hacer con lo que ves y, debajo, aparece el rastro antes de confirmar.",
    hint: "Escribe, o abre fuentes con @ y acciones con /.",
    placeholder: "Di qué significa y qué quieres hacer…",
    idle: "Envía la frase para ver el rastro.",
    thinking: "Ordenando el momento",
    done: "Listo para que confirmes",
    steps: ["Lo que hay en pantalla", "Tu frase, sin reescribirla", "Aún fuera de cualquier proyecto"],
    sources: [
      { key: "page", name: "Esta página", description: "Lo que está a la vista" },
      { key: "project", name: "Un proyecto", description: "El vínculo lo propones tú" },
    ],
    commands: [
      { key: "capture", name: "/capturar", description: "Dejar el gesto listo, si confirmas" },
      { key: "link", name: "/vincular", description: "Proponer un proyecto" },
      { key: "discard", name: "/descartar", description: "Borrar el gesto por completo" },
    ],
    prompt: {
      inputLabel: "Qué quieres hacer",
      listening: "Escuchando…",
      sources: "Fuentes",
      commands: "Acciones",
      models: "Modelos",
      effort: "Esfuerzo",
      effortHint: "Más esfuerzo tarda más antes de responder",
      faster: "Más rápido",
      smarter: "Con más cuidado",
      noMatches: "Nada coincide con “{query}”",
      remove: "Quitar {file}",
      add: "Añadir fuentes",
      chooseModel: "Elegir modelo",
      chooseEffort: "Elegir esfuerzo",
      dictate: "Dictar",
      stopDictation: "Dejar de dictar",
      send: "Enviar",
      stop: "Detener",
    },
  },
  how: {
    title: "Un gesto, y el momento todavía no está guardado",
    body: "Nova permanece invisible hasta que lo invocas. Te enseña lo que ve antes de almacenar nada. Tú hablas, y tus palabras se conservan tal cual: la interpretación se puede corregir, lo que dijiste no se reescribe. Nada entra en un proyecto hasta que confirmas. Si descartas, el gesto se borra por completo.",
    steps: [
      { title: "Ver", body: "El cristal del banco. Lo que hay en pantalla, a la vista, antes de que exista un recuerdo." },
      { title: "Decir", body: "El émbolo. La intención la dices tú. Nova puede proponerte un vínculo; no supone para qué lo quieres." },
      { title: "Confirmar", body: "El perno y el sello. Sin ese gesto la ficha no entra en la bandeja del proyecto." },
    ],
  },
  modes: {
    title: "Dos modos, y ninguno a escondidas",
    paragraphs: [
      "En la captura instantánea invocas, miras lo que Nova ha tomado, dices la frase y confirmas. Sigues en lo que estabas haciendo.",
      "En el contexto en vivo empiezas una sesión, el indicador permanece a la vista y la terminas tú. Puedes preguntar sobre lo que está pasando y guardar solo los tramos que pides.",
      "No hay un tercer modo encubierto ni grabación continua. El margen breve que permite alcanzar lo que acaba de ocurrir es opcional, local y señalado: en la figura es el vial, que no viaja por el cable.",
    ],
  },
  approval: {
    title: "Nada sale sin tu llave",
    body: "Dentro de Nova, ordenar un momento o preparar algo reversible puede seguir su curso. En cuanto algo va a salir — una página, un mensaje, un encargo hacia otra herramienta — ves el contenido y decides. La caja es esa regla: el cajón enseña el momento; la salida permanece cerrada hasta que metes la llave.",
  },
  what: {
    title: "Infraestructura, no otro asistente",
    paragraphs: [
      "Nova es el sustrato que captura, recuerda y propone acciones, y que un asistente puede usar con tu permiso. La aplicación es un cliente de referencia. La memoria es tuya: puedes exportarla y puedes borrarla. Tu contexto no es el negocio.",
      "No compite por ser el modelo que conversa contigo, no toma notas en silencio y no observa la pantalla si no lo has invocado. La persona sigue siendo la autoridad sobre lo que se guarda y sobre lo que sale.",
    ],
  },
  contact: {
    title: "Escríbenos",
    body: "Si quieres hablar del producto, deja tu correo. Es el único gesto que pedimos desde aquí.",
  },
  email: {
    label: "Correo",
    placeholder: "tu@correo",
    help: "Escríbenos. No abre una cuenta y no pasa por un pago.",
    submit: "Enviar correo",
    honeypot: "Empresa",
    messages: {
      [MESSAGE_INVALID]: same(MESSAGE_INVALID),
      [MESSAGE_TOO_LONG]: same(MESSAGE_TOO_LONG),
      [MESSAGE_UNCONFIGURED]: same(MESSAGE_UNCONFIGURED),
      [MESSAGE_ERROR]: same(MESSAGE_ERROR),
      [MESSAGE_OK]: same(MESSAGE_OK),
      [MESSAGE_UNREADABLE]: same(MESSAGE_UNREADABLE),
    },
  },
};
