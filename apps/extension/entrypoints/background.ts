export default defineBackground(() => {
  // Clicking the toolbar action opens the side panel — the single M0
  // invocation method. Keyboard shortcut and other invocations come later.
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("sidePanel behavior failed", err));
});
