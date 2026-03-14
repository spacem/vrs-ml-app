import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  dialog,
  Menu,
  globalShortcut,
} from "electron";
import { autoUpdater } from "electron-updater";
import log from "electron-log";
import * as path from "path";
import * as fs from "fs";

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

let mainWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV === "development";
const PRODUCTION_URL = "https://vrs-ml.netlify.app";

function createWindow() {
  const iconPath = isDev
    ? path.join(__dirname, "../../public/web-app-manifest-512x512.png")
    : path.join(process.resourcesPath, "icon.png");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      autoplayPolicy: "no-user-gesture-required",
    },
    show: false,
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL(PRODUCTION_URL);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function setupIpcHandlers() {
  ipcMain.handle("get-versions", () => {
    return {
      electron: app.getVersion(),
      node: process.versions.node,
      chrome: process.versions.chrome,
    };
  });

  ipcMain.handle("check-for-updates", async () => {
    try {
      return await autoUpdater.checkForUpdates();
    } catch (err) {
      log.error("check-for-updates failed", err);
      throw err;
    }
  });

  ipcMain.handle("download-update", async () => {
    try {
      await autoUpdater.downloadUpdate();
      return true;
    } catch (err) {
      log.error("download-update failed", err);
      throw err;
    }
  });

  ipcMain.handle("install-update", async () => {
    try {
      autoUpdater.quitAndInstall();
      return true;
    } catch (err) {
      log.error("install-update failed", err);
      throw err;
    }
  });

  ipcMain.handle("select-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("select-files", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths.map((filePath) => {
      const stats = fs.statSync(filePath);
      return {
        name: path.basename(filePath),
        path: filePath,
        size: stats.size,
        isDirectory: false,
        mtime: stats.mtimeMs,
      };
    });
  });

  ipcMain.handle("select-files-or-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile", "multiSelections", "openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const selectedPath = result.filePaths[0];
    const stats = fs.statSync(selectedPath);
    const isDirectory = stats.isDirectory();

    if (isDirectory) {
      return {
        path: selectedPath,
        isDirectory: true,
        files: [],
      };
    }

    const files = result.filePaths.map((filePath) => {
      const fileStats = fs.statSync(filePath);
      return {
        name: path.basename(filePath),
        path: filePath,
        size: fileStats.size,
        isDirectory: false,
        mtime: fileStats.mtimeMs,
      };
    });

    return {
      path: selectedPath,
      isDirectory: false,
      files,
    };
  });

  ipcMain.handle("read-dir", async (_event, dirPath: string) => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries.map((entry) => {
        const fullPath = path.join(dirPath, entry.name);
        const stats = fs.statSync(fullPath);
        return {
          name: entry.name,
          path: fullPath,
          size: stats.size,
          isDirectory: entry.isDirectory(),
          mtime: stats.mtimeMs,
        };
      });
    } catch (err) {
      log.error("Error reading directory:", err);
      return [];
    }
  });

  ipcMain.handle("get-file-stream", async () => {
    // Electron can't transfer Node streams via IPC easily, so return null to fall back to URL fetch
    return null;
  });

  ipcMain.handle("read-file", async (_event, filePath: string) => {
    try {
      const data = fs.readFileSync(filePath);
      return data;
    } catch (err) {
      log.error("Error reading file:", err);
      throw err;
    }
  });

  ipcMain.handle("file-exists", async (_event, filePath: string) => {
    return fs.existsSync(filePath);
  });
}

function setupAutoUpdater() {
  // Set to false so we can prompt user before downloading
  autoUpdater.autoDownload = false;
  // Install update when app quits if one is ready
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    log.info("Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    log.info("Update available:", info.version);
    mainWindow?.webContents.send("update-available", info);

    dialog
      .showMessageBox(mainWindow!, {
        type: "info",
        title: "Update Available",
        message: `A new version (${info.version}) is available. Would you like to download and install it now?`,
        buttons: ["Download & Install", "Later"],
      })
      .then((result) => {
        if (result.response === 0) {
          log.info("User chose to download update");
          autoUpdater.downloadUpdate();
        }
      });
  });

  autoUpdater.on("update-not-available", () => {
    log.info("No updates available");
  });

  autoUpdater.on("error", (err) => {
    log.error("Auto-updater error:", err);
    mainWindow?.webContents.send("update-error", err.message);
  });

  autoUpdater.on("download-progress", (progressObj) => {
    log.info(`Download progress: ${progressObj.percent}%`);
    mainWindow?.webContents.send("download-progress", progressObj);
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info("Update downloaded:", info.version);
    mainWindow?.webContents.send("update-downloaded", info);

    dialog
      .showMessageBox(mainWindow!, {
        type: "info",
        title: "Update Ready",
        message:
          "The update has been downloaded. Restart now to apply the update?",
        buttons: ["Restart Now", "Later"],
      })
      .then((result) => {
        if (result.response === 0) {
          log.info("Installing update and restarting...");
          autoUpdater.quitAndInstall();
        }
      });
  });

  if (!isDev) {
    log.info("Setting up auto-updater for production");
    // Check for updates when app starts
    autoUpdater.checkForUpdates().catch((err) => {
      log.error("Failed to check for updates:", err);
    });

    // Check every hour
    setInterval(
      () => {
        log.info("Checking for updates (periodic)");
        autoUpdater.checkForUpdates().catch((err) => {
          log.error("Failed to check for updates:", err);
        });
      },
      60 * 60 * 1000,
    );
  }
}

function setupMenu() {
  if (isDev) {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  } else {
    Menu.setApplicationMenu(null);
  }
}

function setupGlobalShortcuts() {
  if (isDev) {
    globalShortcut.register("CommandOrControl+Shift+I", () => {
      mainWindow?.webContents.toggleDevTools();
    });
    globalShortcut.register("CommandOrControl+Shift+R", () => {
      mainWindow?.webContents.reload();
    });
    globalShortcut.register("F5", () => {
      mainWindow?.webContents.reload();
    });
    globalShortcut.register("F12", () => {
      mainWindow?.webContents.toggleDevTools();
    });
  }
}

app.whenReady().then(() => {
  setupMenu();
  setupGlobalShortcuts();
  setupIpcHandlers();
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
