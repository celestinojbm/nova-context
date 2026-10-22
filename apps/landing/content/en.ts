import type { LandingContent } from "./types";

const ts = `import { Nova } from "@nova/sdk"

const nova = new Nova({ key: process.env.NOVA_KEY })

const ctx = await nova.context.search({
  query: "pricing I saw last week",
  project: "plan-2027",
  include: ["perceived", "meant", "wanted_done"]
})`;

const py = `import os
from nova import Nova

nova = Nova(key=os.environ["NOVA_KEY"])

ctx = nova.context.search(
    query="pricing I saw last week",
    project="plan-2027",
    include=["perceived", "meant", "wanted_done"],
)`;

const curl = `curl https://api.example.invalid/v1/context/search \\
  -H "Authorization: Bearer $NOVA_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "query": "pricing I saw last week",
    "project": "plan-2027",
    "include": ["perceived", "meant", "wanted_done"]
  }'`;

const response = `{
  "id": "cap_7Qe2",
  "perceived": "Pricing table, 3 plans",
  "meant": "Reference for Plan 2027",
  "wanted_done": "Cite in the proposal",
  "connects_to": ["proj_plan2027", "cap_7Pz1"],
  "owner": "you"
}`;

export const en: LandingContent = {
  meta: {
    locale: "en",
    title: "Nova Context — A memory of your digital life",
    description:
      "Human context infrastructure. An API and SDK any assistant can connect to. Fully exportable, fully deletable.",
  },
  skip: "Skip to content",
  brand: "nova context",
  homeAria: "Nova Context, home",
  language: { label: "Language", en: "English", es: "Español" },
  navLabel: "Primary",
  nav: {
    product: "Product",
    sdk: "SDK",
    manifesto: "Manifesto",
    privacy: "Privacy",
    pricing: "Pricing",
  },
  menu: { open: "Open menu", close: "Close menu", label: "Menu" },
  actions: {
    signIn: "Sign in",
    start: "Get started",
    readManifesto: "Read the manifesto",
    docs: "Documentation",
    createAccount: "Create account",
    copy: "Copy",
    copied: "Copied",
  },
  hero: {
    eyebrow: "Human context infrastructure",
    lines: ["A memory of your digital life.", "That is yours."],
    lede: "An API/SDK platform any assistant connects to.",
    promise: "Fully exportable, fully deletable.",
    tags: ["perceived", "meant", "connects to", "to do"],
  },
  how: {
    index: "01",
    eyebrow: "How it works",
    lines: ["The moment you notice it,", "preserved."],
    lede: "From the screen to any assistant, in four steps.",
    steps: [
      {
        title: "Capture",
        body: "An explicit shortcut saves what you see: screen, video, chat.",
      },
      {
        title: "Understand",
        body: "What you perceived, what it meant, why it mattered.",
      },
      {
        title: "Connect",
        body: "It links the moment to projects, people, and earlier captures.",
      },
      {
        title: "Deliver",
        body: "Any assistant can query it through the API, with your permission.",
      },
    ],
    pipeline: "capture → understand → connect → deliver",
    metric: "p50 · 120 ms",
    metricNote: "Example placeholder",
  },
  features: {
    index: "02",
    eyebrow: "Features",
    lines: ["Not a chatbot.", "The layer underneath."],
    lede: "Memory any assistant can use, and that only you control.",
    items: [
      {
        title: "Yours by design",
        body: "Export or delete everything. Context is never monetized.",
      },
      {
        title: "Explicit capture",
        body: "Nothing is stored without your gesture. No surveillance.",
      },
      {
        title: "Context graph",
        body: "Each capture links to what you already know.",
      },
      {
        title: "API and SDK",
        body: "TypeScript and Python. One endpoint, any assistant.",
      },
      {
        title: "Timeline",
        body: "Return to the exact minute you saw it.",
      },
      {
        title: "End-to-end encryption",
        body: "Local keys; the server cannot read your memory.",
      },
    ],
  },
  sdk: {
    index: "03",
    eyebrow: "SDK",
    title: "One endpoint. Any assistant.",
    lede: "Ask by meaning, not by keywords.",
    tabsLabel: "Code sample",
    tabs: [
      { id: "ts", label: "TypeScript", code: ts },
      { id: "py", label: "Python", code: py },
      { id: "curl", label: "cURL", code: curl },
    ],
    responseLabel: "Response · 200 · 118 ms",
    example: "Example placeholder",
    response,
  },
  privacy: {
    index: "04",
    eyebrow: "Privacy",
    title: "Is / is not.",
    lede: "The rules are not a policy: they are in the code.",
    rows: [
      { label: "Nova is", value: "Human context infrastructure" },
      { label: "Nova is not", value: "A chatbot, a notes app, or another assistant" },
      { label: "Your memory", value: "Fully exportable · fully deletable" },
      { label: "Capture", value: "Explicit and indicated, never in the background" },
      { label: "Context", value: "Never sold and never used for ads" },
    ],
  },
  pricing: {
    eyebrow: "Pricing · illustrative",
    badge: "Example placeholder",
    lines: ["Pay for memory,", "not for your data."],
    note: "Example placeholder. These prices and limits are not an offer.",
    plans: [
      {
        name: "Personal",
        price: "$0",
        period: "For individual use",
        cta: "Get started",
        variant: "secondary",
        items: ["1,000 captures/month", "Full export", "SDK with 1 assistant"],
      },
      {
        name: "Pro",
        price: "$12",
        period: "/month",
        cta: "Try Pro",
        variant: "primary",
        recommended: "Recommended",
        items: [
          "Unlimited captures",
          "Unlimited assistants",
          "Search by meaning",
          "Encrypted with your keys",
        ],
      },
      {
        name: "Teams",
        price: "$24",
        period: "/user/month",
        cta: "Get started",
        variant: "secondary",
        items: ["Shared projects", "Permissions per person", "Audit log"],
      },
    ],
  },
  faq: {
    index: "05",
    eyebrow: "Questions",
    title: "Frequently asked questions.",
    lede: "What is worth knowing before you start.",
    items: [
      {
        q: "Does Nova record my screen all the time?",
        a: "No. It only stores what you capture with an explicit gesture, and that capture is always indicated.",
        open: true,
      },
      {
        q: "Which assistants are compatible?",
        a: "Any assistant that speaks the API. One endpoint, and only with the permission you grant. Others connect through the TypeScript or Python SDK.",
      },
      {
        q: "Can I export my memory?",
        a: "Yes. Full export from the first day, and full deletion. The archive is yours.",
      },
      {
        q: "Where is my data stored?",
        a: "On your device until you capture. What you choose to sync is stored encrypted, and a project can stay local-only. You can export or delete all of it.",
      },
      {
        q: "Does it work offline?",
        a: "Nova does not record in the background. A capture that cannot be delivered fails in the open, and you retry. Memory pinned to the device stays there. Anything that lives only in the cloud needs a connection to review.",
      },
    ],
  },
  cta: {
    title: "Start remembering.",
    lede: "Free for personal use. Your memory, exportable from day one.",
  },
  footer: {
    tagline: "Human context infrastructure. Your memory is yours.",
    product: "Product",
    resources: "Resources",
    privacy: "Privacy",
    links: {
      capture: "Capture",
      sdk: "SDK",
      pricing: "Pricing",
      manifesto: "Manifesto",
      docs: "Documentation",
      status: "Status",
      export: "Export",
      erase: "Delete",
      policy: "Policy",
    },
  },
};
