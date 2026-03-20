import { app, BrowserWindow, globalShortcut } from "electron";
import { autoUpdater } from "electron-updater";
import log from "electron-log";
import { createWindow } from "./window";
import { setupAutoUpdater } from "./updater";
import { setupIpcHandlers } from "./ipc";
import { setupMenu, setupGlobalShortcuts } from "./menu";
import { registerStreamScheme, setupStreamHandler } from "./stream";

// Enable hot reload in development
if (process.env.NODE_ENV === "development") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("electron-reloader")(module);
  } catch {
    // electron-reloader is only available in dev, ignore errors in production
  }
}

log.transports.file.level = "info";
autoUpdater.logger = log;

// Register the stream:// protocol before app is ready
registerStreamScheme();

app.whenReady().then(() => {
  setupMenu();
  setupGlobalShortcuts();
  setupIpcHandlers();
  setupStreamHandler();
  createWindow();
  setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  globalShortcut.unregisterAll();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
