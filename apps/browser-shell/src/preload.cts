import { contextBridge, ipcRenderer } from "electron";

/**
 * Preload bridge for the Nova side panel ONLY (the visited page has no
 * preload and no privileges). Exposes the minimum surface the panel needs;
 * every call round-trips through a validated ipcMain handler in main.ts.
 * Compiled to CommonJS (.cjs) because sandboxed preloads cannot be ESM.
 */
contextBridge.exposeInMainWorld("nova", {
  status: () => ipcRenderer.invoke("nova:status"),
  navigate: (url: string) => ipcRenderer.invoke("nova:navigate", url),
  pair: (apiUrl: string, code: string) =>
    ipcRenderer.invoke("nova:pair", { apiUrl, code }),
  disconnect: () => ipcRenderer.invoke("nova:disconnect"),
  setOptions: (opts: { captureMode?: string; strictRedaction?: boolean }) =>
    ipcRenderer.invoke("nova:set-options", opts),
  capture: (intentText: string, projectId: string | null) =>
    ipcRenderer.invoke("nova:capture", { intentText, projectId }),
});
