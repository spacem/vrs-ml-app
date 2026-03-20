import { dialog } from "electron";
import { autoUpdater } from "electron-updater";
import log from "electron-log";
import { getMainWindow } from "./window";

const isDev = process.env.NODE_ENV === "development";

export function setupAutoUpdater(): void {
  // Set to false so we can prompt user before downloading
  autoUpdater.autoDownload = false;
  // Install update when app quits if one is ready
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    log.info("Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    log.info("Update available:", info.version);
    getMainWindow()?.webContents.send("update-available", info);

    dialog
      .showMessageBox(getMainWindow()!, {
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
    getMainWindow()?.webContents.send("update-error", err.message);
  });

  autoUpdater.on("download-progress", (progressObj) => {
    log.info(`Download progress: ${progressObj.percent}%`);
    getMainWindow()?.webContents.send("download-progress", progressObj);
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info("Update downloaded:", info.version);
    getMainWindow()?.webContents.send("update-downloaded", info);

    dialog
      .showMessageBox(getMainWindow()!, {
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
