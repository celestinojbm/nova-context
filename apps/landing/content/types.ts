export type Locale = "en" | "es";

export type Step = { title: string; body: string };
export type Feature = { title: string; body: string };
export type FaqItem = { q: string; a: string; open?: boolean };
export type SdkTab = { id: "ts" | "py" | "curl"; label: string; code: string };
export type Plan = {
  name: string;
  price: string;
  period: string;
  cta: string;
  variant: "primary" | "secondary";
  recommended?: string;
  items: string[];
};

/** Every user-facing string on the landing. Add a locale by filling this shape. */
export type LandingContent = {
  meta: { locale: Locale; title: string; description: string };
  skip: string;
  brand: string;
  homeAria: string;
  language: { label: string; en: string; es: string };
  navLabel: string;
  nav: {
    product: string;
    sdk: string;
    manifesto: string;
    privacy: string;
    pricing: string;
  };
  menu: { open: string; close: string; label: string };
  actions: {
    signIn: string;
    start: string;
    readManifesto: string;
    docs: string;
    createAccount: string;
    copy: string;
    copied: string;
  };
  hero: {
    eyebrow: string;
    lines: [string, string];
    lede: string;
    promise: string;
    tags: [string, string, string, string];
  };
  how: {
    index: string;
    eyebrow: string;
    lines: [string, string];
    lede: string;
    steps: [Step, Step, Step, Step];
    pipeline: string;
    metric: string;
    metricNote: string;
  };
  features: {
    index: string;
    eyebrow: string;
    lines: [string, string];
    lede: string;
    items: [Feature, Feature, Feature, Feature, Feature, Feature];
  };
  sdk: {
    index: string;
    eyebrow: string;
    title: string;
    lede: string;
    tabsLabel: string;
    tabs: [SdkTab, SdkTab, SdkTab];
    responseLabel: string;
    example: string;
    response: string;
  };
  privacy: {
    index: string;
    eyebrow: string;
    title: string;
    lede: string;
    rows: { label: string; value: string }[];
  };
  pricing: {
    eyebrow: string;
    badge: string;
    lines: [string, string];
    note: string;
    plans: [Plan, Plan, Plan];
  };
  faq: {
    index: string;
    eyebrow: string;
    title: string;
    lede: string;
    items: FaqItem[];
  };
  cta: { title: string; lede: string };
  footer: {
    tagline: string;
    product: string;
    resources: string;
    privacy: string;
    links: {
      capture: string;
      sdk: string;
      pricing: string;
      manifesto: string;
      docs: string;
      status: string;
      export: string;
      erase: string;
      policy: string;
    };
  };
};
