import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Nova Context",
    description:
      "Capture what you're looking at, say why it matters, and Nova keeps the context.",
    // Minimal permission set per docs/BUILD_PLAN.md §8: host access comes
    // per-invocation through activeTab — deliberately NOT <all_urls>.
    permissions: ["activeTab", "scripting", "storage", "sidePanel"],
    action: {
      default_title: "Open Nova Context",
    },
  },
});
