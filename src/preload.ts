import { contextBridge, ipcRenderer } from "electron";
import path from "path";
import { TranscodingConfig } from "./transcoding/types";

const api = {
  platform: process.platform,
  isElectron: true,

  getVersions: () => ipcRenderer.invoke("get-versions"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),

  selectFolder: () => ipcRenderer.invoke("select-folder"),
  selectFiles: () => ipcRenderer.invoke("select-files"),
  selectFilesOrFolder: () => ipcRenderer.invoke("select-files-or-folder"),
  readDir: (path: string) => ipcRenderer.invoke("read-dir", path),
  getStorageId: (path: string) => ipcRenderer.invoke("get-storage-id", path),
  fileExists: (path: string) => ipcRenderer.invoke("file-exists", path),
  readFile: (path: string) => ipcRenderer.invoke("read-file", path),
  readMetadata: (url: string) => ipcRenderer.invoke("read-metadata", url),
  getUrl: (path: string) => ipcRenderer.invoke("get-url", path),

  onFileChange: (callback: (event: { type: string; path: string }) => void) => {
    ipcRenderer.on("file-change", (_event, data) => callback(data));
  },

  onUpdateAvailable: (callback: (info: unknown) => void) => {
    ipcRenderer.on("update-available", (_event, info) => callback(info));
  },

  onDownloadProgress: (callback: (progress: unknown) => void) => {
    ipcRenderer.on("download-progress", (_event, progress) =>
      callback(progress),
    );
  },

  onUpdateDownloaded: (callback: (info: unknown) => void) => {
    ipcRenderer.on("update-downloaded", (_event, info) => callback(info));
  },

  onPowerResume: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("power-resume", handler);
    return () => ipcRenderer.removeListener("power-resume", handler);
  },

  onPowerSuspend: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("power-suspend", handler);
    return () => ipcRenderer.removeListener("power-suspend", handler);
  },

  // Transcoding API
  transcodeFile: (
    storageId: string,
    inputPath: string,
    config: TranscodingConfig,
  ) => ipcRenderer.invoke("transcode-file", { storageId, inputPath, config }),
  cancelTranscoding: (storageId: string) =>
    ipcRenderer.invoke("cancel-transcoding", { storageId }),
  testGpuEncoder: (encoderName: string, config: TranscodingConfig) =>
    ipcRenderer.invoke("test-gpu-encoder", { encoderName, config }),
  testFfmpegPath: (encoderPath: string, config: TranscodingConfig) =>
    ipcRenderer.invoke("test-ffmpeg-path", { encoderPath, config }),
  testCyanRipPath: (ripperPath: string, config: TranscodingConfig) =>
    ipcRenderer.invoke("test-cyanrip-path", { ripperPath, config }),
  deleteFile: (filePath: string) =>
    ipcRenderer.invoke("delete-file", { filePath }),

  // CD Ripping API
  cdRipDryRun: (config: TranscodingConfig, releaseChoice?: number) =>
    ipcRenderer.invoke("cd-rip-dry-run", { config, releaseChoice }),
  startCdRip: (config: TranscodingConfig, releaseChoice?: number) =>
    ipcRenderer.invoke("start-cd-rip", { config, releaseChoice }),
  cancelCdRip: () => ipcRenderer.invoke("cancel-cd-rip"),
  onCdRipProgress: (
    callback: (progress: {
      percent: number;
      stage: string;
      fileId: string;
      output?: string;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: { percent: number; stage: string; fileId: string; output?: string },
    ) => callback(data);
    ipcRenderer.on("cd-rip-progress", handler);
    return () => ipcRenderer.removeListener("cd-rip-progress", handler);
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);

declare global {
  interface Window {
    electronAPI: typeof api;
  }
}
