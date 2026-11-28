import {
  MESSAGE_ERROR,
  MESSAGE_INVALID,
  MESSAGE_OK,
  MESSAGE_TOO_LONG,
  MESSAGE_UNCONFIGURED,
  MESSAGE_UNREADABLE,
} from "@/lib/sheets-contact";
import type { LandingCopy } from "./types";

export const en: LandingCopy = {
  lang: "en",
  meta: {
    title: "Nova Context",
    description:
      "The layer under assistants. You capture what you see, say what it means, and confirm before anything is saved or leaves.",
  },
  language: { href: "/", label: "ES", hrefLang: "es" },
  nav: { how: "How it works", modes: "Modes", approval: "Approval", what: "What it is" },
  hero: {
    eyebrow: "Human context infrastructure",
    title: "What you see, in your own words,",
    titleMuted: "stays where it belongs.",
    lede: "Nova Context is not a chat and not a notebook. It is the layer under assistants: you capture what you are looking at, you say what it means to you and what you want done with it, and that stays as a moment of yours. You see it before it is saved, and nothing leaves unless you confirm.",
    tags: ["you perceive", "it means", "connects to", "you want done"],
  },
  demo: {
    kicker: "Demonstration",
    note: "Nothing you type here is saved. It is the gesture: you say what you want done with what you see, and the trace appears below, before you confirm.",
    hint: "Type, or open sources with @ and actions with /.",
    placeholder: "Say what it means and what you want done…",
    idle: "Send the phrase to see the trace.",
    thinking: "Ordering the moment",
    done: "Ready for you to confirm",
    steps: ["What is on screen", "Your words, unrewritten", "Still outside any project"],
    sources: [
      { key: "page", name: "This page", description: "What is in view" },
      { key: "project", name: "A project", description: "You propose the link" },
    ],
    commands: [
      { key: "capture", name: "/capture", description: "Leave the gesture ready, if you confirm" },
      { key: "link", name: "/link", description: "Propose a project" },
      { key: "discard", name: "/discard", description: "Erase the gesture completely" },
    ],
    prompt: {
      inputLabel: "What you want done",
      listening: "Listening…",
      sources: "Sources",
      commands: "Actions",
      models: "Models",
      effort: "Effort",
      effortHint: "More effort takes longer before answering",
      faster: "Faster",
      smarter: "More careful",
      noMatches: "Nothing matches “{query}”",
      remove: "Remove {file}",
      add: "Add sources",
      chooseModel: "Choose model",
      chooseEffort: "Choose effort",
      dictate: "Dictate",
      stopDictation: "Stop dictation",
      send: "Send",
      stop: "Stop",
    },
  },
  how: {
    title: "One gesture, and the moment is not saved yet",
    body: "Nova stays invisible until you invoke it. It shows you what it sees before storing anything. You speak, and your words are kept as you said them: the interpretation can be corrected, what you said is not rewritten. Nothing enters a project until you confirm. If you discard, the gesture is erased completely.",
    steps: [
      { title: "See", body: "The glass of the bench. What is on screen, in view, before a memory exists." },
      { title: "Say", body: "The plunger. You say the intent. Nova may propose a link; it does not assume what you want it for." },
      { title: "Confirm", body: "The bolt and the seal. Without that gesture the card does not enter the project tray." },
    ],
  },
  modes: {
    title: "Two modes, and neither in secret",
    paragraphs: [
      "In instant capture you invoke, look at what Nova has taken, say the phrase, and confirm. You stay in what you were doing.",
      "In live context you start a session, the indicator stays in view, and you end it. You can ask about what is happening and save only the stretches you ask for.",
      "There is no third, covert mode and no continuous recording. The short margin that can reach what just happened is optional, local, and marked: in the figure it is the vial, and it does not travel down the cable.",
    ],
  },
  approval: {
    title: "Nothing leaves without your key",
    body: "Inside Nova, ordering a moment or preparing something reversible can proceed. The moment something is about to leave — a page, a message, an errand toward another tool — you see the content and you decide. The box is that rule: the drawer shows the moment; the way out stays shut until you put in the key.",
  },
  what: {
    title: "Infrastructure, not another assistant",
    paragraphs: [
      "Nova is the substrate that captures, remembers, and proposes actions, and that an assistant can use with your permission. The application is a reference client. The memory is yours: you can export it and you can delete it. Your context is not the business.",
      "It does not compete to be the model that talks with you, it does not take notes in silence, and it does not watch the screen unless you have invoked it. The person remains the authority over what is saved and what leaves.",
    ],
  },
  contact: {
    title: "Write to us",
    body: "If you want to talk about the product, leave your email. It is the only gesture we ask for from here.",
  },
  email: {
    label: "Email",
    placeholder: "you@email",
    help: "Write to us. It does not open an account and it does not go through a payment.",
    submit: "Send email",
    honeypot: "Company",
    messages: {
      [MESSAGE_INVALID]: "Write an email we can read.",
      [MESSAGE_TOO_LONG]: "That submission is too long.",
      [MESSAGE_UNCONFIGURED]: "Sending is not configured. We have not saved your email.",
      [MESSAGE_ERROR]: "We could not save your email. Try again.",
      [MESSAGE_OK]: "Done. We saved your email.",
      [MESSAGE_UNREADABLE]: "We could not read the form.",
    },
  },
};
