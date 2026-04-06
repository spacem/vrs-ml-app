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
  getFileStream: (path: string) => ipcRenderer.invoke("get-file-stream", path),
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

  // Transcoding API
  transcodeFile: (
    fileId: string,
    inputPath: string,
    config: TranscodingConfig,
  ) => ipcRenderer.invoke("transcode-file", { fileId, inputPath, config }),
  cancelTranscoding: (fileId: string) =>
    ipcRenderer.invoke("cancel-transcoding", { fileId }),
  testGpuEncoder: (encoderName: string, config: TranscodingConfig) =>
    ipcRenderer.invoke("test-gpu-encoder", { encoderName, config }),
  testFfmpegPath: (encoderPath: string, config: TranscodingConfig) =>
    ipcRenderer.invoke("test-ffmpeg-path", { encoderPath, config }),
  deleteFile: (filePath: string) =>
    ipcRenderer.invoke("delete-file", { filePath }),
};

contextBridge.exposeInMainWorld("electronAPI", api);

declare global {
  interface Window {
    electronAPI: typeof api;
  }
}
