export interface EmailCopy {
  label: string;
  placeholder: string;
  help: string;
  submit: string;
  honeypot: string;
  /** Server replies are Spanish. This map is what the form shows. */
  messages: Record<string, string>;
}

export interface DemoSource {
  key: string;
  name: string;
  description: string;
}

export interface DemoCommand {
  key: string;
  name: string;
  description: string;
}

export interface LandingCopy {
  lang: "es" | "en";
  meta: { title: string; description: string };
  language: { href: string; label: string; hrefLang: "es" | "en" };
  nav: { how: string; modes: string; approval: string; what: string };
  hero: {
    eyebrow: string;
    title: string;
    titleMuted: string;
    lede: string;
    tags: readonly [string, string, string, string];
  };
  demo: {
    kicker: string;
    note: string;
    hint: string;
    placeholder: string;
    idle: string;
    thinking: string;
    done: string;
    steps: readonly [string, string, string];
    sources: readonly DemoSource[];
    commands: readonly DemoCommand[];
    prompt: {
      inputLabel: string;
      listening: string;
      sources: string;
      commands: string;
      models: string;
      effort: string;
      effortHint: string;
      faster: string;
      smarter: string;
      noMatches: string;
      remove: string;
      add: string;
      chooseModel: string;
      chooseEffort: string;
      dictate: string;
      stopDictation: string;
      send: string;
      stop: string;
    };
  };
  how: {
    title: string;
    body: string;
    steps: readonly { title: string; body: string }[];
  };
  modes: { title: string; paragraphs: readonly string[] };
  approval: { title: string; body: string };
  what: { title: string; paragraphs: readonly string[] };
  contact: { title: string; body: string };
  email: EmailCopy;
}
