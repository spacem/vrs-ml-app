import { Menu, globalShortcut } from "electron";
import { getMainWindow } from "./window";

const isDev = process.env.NODE_ENV === "development";

export function setupMenu(): void {
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

export function setupGlobalShortcuts(): void {
  if (isDev) {
    globalShortcut.register("CommandOrControl+Shift+I", () => {
      getMainWindow()?.webContents.toggleDevTools();
    });
    globalShortcut.register("CommandOrControl+Shift+R", () => {
      getMainWindow()?.webContents.reload();
    });
    globalShortcut.register("F5", () => {
      getMainWindow()?.webContents.reload();
    });
    globalShortcut.register("F12", () => {
      getMainWindow()?.webContents.toggleDevTools();
    });
  }
}
