import { BrowserWindow, shell } from "electron";
import * as path from "path";

const isDev = process.env.NODE_ENV === "development";
const PRODUCTION_URL = "https://vrs-ml.netlify.app";

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function createWindow(): void {
  const iconPath = isDev
    ? path.join(__dirname, "../../public/web-app-manifest-512x512.png")
    : path.join(process.resourcesPath, "icon.png");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    show: true, // Always show for tests
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      autoplayPolicy: "no-user-gesture-required",
    },
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
