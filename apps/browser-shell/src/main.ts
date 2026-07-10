import { BrowserWindow, WebContentsView, app, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SessionExpiredError,
  claimPairingCode,
  postMoment,
  revokeSession,
  type ShellSettings,
} from "./api-client.js";
import {
  EXTRACT_PAGE_SCRIPT,
  sanitizePageContext,
  toCreateMomentRequest,
} from "./capture.js";
import { loadSettingsFile, saveSettingsFile } from "./settings.js";

/**
 * M12 spike — minimal Nova browser shell (Electron main process).
 *
 * One window, two views: a sandboxed page view (the "browser") and the Nova
 * side panel (our trusted UI). Security posture, in order of importance:
 *
 * - The visited page gets ZERO privileges: sandboxed, context-isolated, no
 *   Node, no preload, window.open denied, all permission requests denied.
 *   It is strictly less privileged than a page in Chrome (which can at
 *   least request camera/notifications).
 * - NO silent background capture. The ONLY capture path is the
 *   nova:capture IPC handler, reachable only from the side panel's Capture
 *   button. There are no timers, no navigation hooks, no auto-capture.
 * - Whatever the page returns from the extract script is UNTRUSTED data:
 *   it is sanitized, and the URL recorded on the moment is the shell's own
 *   navigation record (webContents.getURL()), not what the page claims.
 *   Page content is data for the payload, never instruction — it cannot
 *   change the intent, project, destination, or any control field.
 * - The shell stores nothing captured. Screenshots and text exist in memory
 *   only until the API accepts them; redaction and encryption happen
 *   server-side exactly as for extension captures.
 * - Nothing captured is ever logged. Log lines carry event names + counts.
 */

const PANEL_WIDTH = 400;
const dir = fileURLToPath(new URL(".", import.meta.url));

let win: BrowserWindow;
let pageView: WebContentsView;
let panelView: WebContentsView;
let settings: ShellSettings;
let settingsFile: string;

function layout() {
  const [w, h] = win.getContentSize();
  pageView.setBounds({ x: 0, y: 0, width: Math.max(0, w - PANEL_WIDTH), height: h });
  panelView.setBounds({ x: Math.max(0, w - PANEL_WIDTH), y: 0, width: PANEL_WIDTH, height: h });
}

function saveSettings() {
  saveSettingsFile(settingsFile, settings);
}

app.whenReady().then(async () => {
  settingsFile = join(app.getPath("userData"), "nova-shell-settings.json");
  settings = loadSettingsFile(settingsFile);

  win = new BrowserWindow({ width: 1360, height: 860, title: "Nova Shell (spike)" });

  // The visited page: fully sandboxed, no privileges whatsoever.
  pageView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  pageView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  pageView.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) =>
    cb(false),
  );

  // The Nova side panel: our UI, talks to main only through the preload bridge.
  panelView = new WebContentsView({
    webPreferences: {
      preload: join(dir, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.contentView.addChildView(pageView);
  win.contentView.addChildView(panelView);
  win.on("resize", layout);
  layout();

  await panelView.webContents.loadFile(join(dir, "..", "panel", "index.html"));
  await pageView.webContents.loadURL("https://example.com");
});

app.on("window-all-closed", () => app.quit());

ipcMain.handle("nova:status", () => ({
  connected: Boolean(settings.deviceToken),
  email: settings.accountEmail,
  apiUrl: settings.apiUrl,
  captureMode: settings.captureMode,
  strictRedaction: settings.strictRedaction,
  currentUrl: pageView?.webContents.getURL() ?? "",
}));

ipcMain.handle("nova:navigate", async (_e, rawUrl: unknown) => {
  if (typeof rawUrl !== "string") return { ok: false, error: "Bad URL." };
  let url: URL;
  try {
    url = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
  } catch {
    return { ok: false, error: "Bad URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Only http(s) URLs." };
  }
  try {
    await pageView.webContents.loadURL(url.toString());
  } catch {
    // Navigation errors (DNS, aborts) still land on an error page; the URL
    // bar reflects wherever the view actually ended up.
  }
  return { ok: true, url: pageView.webContents.getURL() };
});

ipcMain.handle("nova:pair", async (_e, args: unknown) => {
  const { apiUrl, code } = (args ?? {}) as { apiUrl?: unknown; code?: unknown };
  if (typeof apiUrl !== "string" || typeof code !== "string") {
    return { ok: false, error: "API URL and pairing code are required." };
  }
  try {
    const { token, email } = await claimPairingCode(apiUrl.replace(/\/+$/, ""), code);
    settings = { ...settings, apiUrl: apiUrl.replace(/\/+$/, ""), deviceToken: token, accountEmail: email };
    saveSettings();
    return { ok: true, email };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Pairing failed." };
  }
});

ipcMain.handle("nova:disconnect", async () => {
  await revokeSession(settings);
  settings = { ...settings, deviceToken: "", accountEmail: "" };
  saveSettings();
  return { ok: true };
});

ipcMain.handle("nova:set-options", (_e, args: unknown) => {
  const { captureMode, strictRedaction } = (args ?? {}) as {
    captureMode?: unknown;
    strictRedaction?: unknown;
  };
  if (captureMode === "full" || captureMode === "text_only") {
    settings = { ...settings, captureMode };
  }
  if (typeof strictRedaction === "boolean") {
    settings = { ...settings, strictRedaction };
  }
  saveSettings();
  return { ok: true };
});

/** THE capture path — explicit user action only (side panel button). */
ipcMain.handle("nova:capture", async (_e, args: unknown) => {
  const { intentText, projectId } = (args ?? {}) as {
    intentText?: unknown;
    projectId?: unknown;
  };

  const raw = await pageView.webContents
    .executeJavaScript(EXTRACT_PAGE_SCRIPT, true)
    .catch(() => null);
  const page = sanitizePageContext(raw);
  if (!page) {
    return { ok: false, error: "Could not read this page." };
  }
  // Trust the shell's own navigation record over anything the page claims.
  page.url = pageView.webContents.getURL().slice(0, 4096);

  let screenshotDataUrl: string | null = null;
  if (settings.captureMode !== "text_only") {
    try {
      const image = await pageView.webContents.capturePage();
      const { width } = image.getSize();
      const resized = width > 800 ? image.resize({ width: 800 }) : image;
      screenshotDataUrl = `data:image/jpeg;base64,${resized
        .toJPEG(75)
        .toString("base64")}`;
    } catch {
      // Screenshot failure never blocks capture — DOM extract alone still
      // makes a useful moment (same policy as the extension).
      screenshotDataUrl = null;
    }
  }

  const body = toCreateMomentRequest(
    { page, screenshotDataUrl },
    typeof intentText === "string" ? intentText : "",
    typeof projectId === "string" && projectId ? projectId : null,
  );

  try {
    const created = await postMoment(settings, body);
    console.log(
      `[nova-shell] capture submitted moment=${created.id} media=${created.media?.length ?? 0} redaction=${created.image_redaction?.state ?? "n/a"}`,
    );
    return {
      ok: true,
      momentId: created.id,
      redaction: created.image_redaction?.state ?? null,
      mediaCount: created.media?.length ?? 0,
      enrichment: created.enrichment.status,
    };
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      settings = { ...settings, deviceToken: "", accountEmail: "" };
      saveSettings();
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Capture failed.",
    };
  }
});
