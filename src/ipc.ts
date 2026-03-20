import { app, ipcMain, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import log from "electron-log";
import * as path from "path";
import * as fs from "fs";
import { getMainWindow } from "./window";
import { pathToFileURL, fileURLToPath } from "url";

export function setupIpcHandlers(): void {
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
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("select-files", async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return Promise.all(
      result.filePaths.map(async (filePath) => {
        const stats = await fs.promises.stat(filePath);
        return {
          name: path.basename(filePath),
          path: filePath,
          size: stats.size,
          isDirectory: false,
          mtime: stats.mtimeMs,
        };
      }),
    );
  });

  ipcMain.handle("select-files-or-folder", async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ["openFile", "multiSelections", "openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const selectedPath = result.filePaths[0];
    const stats = await fs.promises.stat(selectedPath);
    const isDirectory = stats.isDirectory();

    if (isDirectory) {
      return {
        path: selectedPath,
        isDirectory: true,
        files: [],
      };
    }

    const files = await Promise.all(
      result.filePaths.map(async (filePath) => {
        const fileStats = await fs.promises.stat(filePath);
        return {
          name: path.basename(filePath),
          path: filePath,
          size: fileStats.size,
          isDirectory: false,
          mtime: fileStats.mtimeMs,
        };
      }),
    );

    return {
      path: selectedPath,
      isDirectory: false,
      files,
    };
  });

  ipcMain.handle("read-dir", async (_event, dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, {
        withFileTypes: true,
      });
      return Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(dirPath, entry.name);
          const stats = await fs.promises.stat(fullPath);
          return {
            name: entry.name,
            path: fullPath,
            size: stats.size,
            isDirectory: entry.isDirectory(),
            mtime: stats.mtimeMs,
          };
        }),
      );
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
      const data = await fs.promises.readFile(filePath);
      return data;
    } catch (err) {
      log.error("Error reading file:", err);
      throw err;
    }
  });
  ipcMain.handle("read-metadata", async (_event, urlOrPath: string) => {
    try {
      let filePath = urlOrPath;
      if (typeof urlOrPath === "string" && urlOrPath.startsWith("stream:///")) {
        const fileUrl = urlOrPath.replace("stream:///", "file:///");
        filePath = fileURLToPath(fileUrl);
      }

      // Dynamically import music-metadata to avoid CJS/exports resolution errors

      const { parseFile } = await import("music-metadata");
      const meta = await parseFile(filePath, { skipCovers: true });
      const { artist, album, title, year, genre } = meta.common;
      return {
        artist: artist || undefined,
        album: album || undefined,
        title: title || undefined,
        year: year != null ? String(year) : undefined,
        genre: genre?.[0] || undefined,
      };
    } catch (err) {
      log.error("read-metadata failed", err);
      throw err;
    }
  });

  ipcMain.handle("file-exists", async (_event, filePath: string) => {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("get-url", async (_event, filePath: string) => {
    return pathToFileURL(filePath).href.replace("file:///", "stream:///");
  });
}
