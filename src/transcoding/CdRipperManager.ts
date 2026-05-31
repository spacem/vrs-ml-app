import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs/promises";
import log from "electron-log";
import { TranscodingConfig } from "./types";
import { getMainWindow } from "../window";

const logger = {
  info: (msg: string, ctx?: Record<string, unknown>) =>
    log.info(`[CdRipperManager] ${msg}`, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) =>
    log.error(`[CdRipperManager] ${msg}`, ctx),
};

export class CdRipperManager {
  private config: TranscodingConfig;
  private currentProcess: ChildProcess | null = null;
  private currentJobOutputFolder: string | null = null;

  constructor(config: TranscodingConfig) {
    this.config = config;
  }

  updateConfig(config: TranscodingConfig): void {
    this.config = config;
  }

  private async resolveRipperPath(
    ripperPath: string | undefined = this.config.ripperPath,
  ): Promise<string> {
    const configuredPath = ripperPath?.trim();
    if (!configuredPath) {
      throw new Error("Ripper path not configured");
    }
    try {
      const stats = await fs.stat(configuredPath);
      if (stats?.isDirectory()) {
        // Search for cyanrip-*.exe in the directory
        const files = await fs.readdir(configuredPath);
        const cyanripFile = files.find(
          (f) =>
            f.toLowerCase().startsWith("cyanrip") &&
            (process.platform !== "win32" || f.toLowerCase().endsWith(".exe")),
        );

        if (!cyanripFile) {
          throw new Error("No cyanrip executable found");
        }

        return path.join(configuredPath, cyanripFile);
      } else {
        return configuredPath;
      }
    } catch {
      throw new Error(`Invalid ripper path: ${configuredPath}`);
    }
  }

  async testCyanRipPath(
    ripperPath: string,
  ): Promise<{ success: boolean; version: string | null }> {
    const configuredPath = ripperPath?.trim();

    let cyanripExePath = configuredPath;
    try {
      cyanripExePath = await this.resolveRipperPath(configuredPath);
    } catch {
      console.error("Error accessing CyanRip path:", configuredPath);
      return { success: false, version: null };
    }
    console.log(`Testing CyanRip path: ${cyanripExePath}`);

    return new Promise((resolve) => {
      const proc = spawn(cyanripExePath, ["-V"]);

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        // CyanRip outputs version info to stderr
        const output = stdout || stderr;
        const firstLine = output.split("\n")[0]?.trim() || null;
        console.log(`CyanRip test result: code=${code}, output=${output}`);
        resolve({ success: code === 0, version: firstLine });
      });

      proc.on("error", () => {
        resolve({ success: false, version: null });
      });
    });
  }

  async cdRipDryRun(
    config: TranscodingConfig,
    releaseChoice?: number,
  ): Promise<{
    trackDetails: string;
    estimatedTime: string;
    choices?: { id: number; description: string }[];
    error: string | null;
  }> {
    this.updateConfig(config);
    const ripperPath = await this.resolveRipperPath();

    const args = ["-I"];
    if (releaseChoice !== undefined) {
      args.push("-R", releaseChoice.toString());
    }

    return new Promise((resolve) => {
      const proc = spawn(ripperPath, args);
      let output = "";

      proc.stdout?.on("data", (data) => (output += data.toString()));
      proc.stderr?.on("data", (data) => (output += data.toString()));

      proc.on("close", (code) => {
        console.log(`Dry run output: ${output}`);
        if (
          code !== 0 &&
          !output.includes("Please specify which release to use")
        ) {
          resolve({
            trackDetails: "",
            estimatedTime: "",
            error: `Dry run failed (code ${code}): ${output.slice(-200)}`,
          });
          return;
        }

        // Check for multiple releases
        if (
          output.includes("Multiple releases found in database") ||
          output.includes("Please specify which release to use")
        ) {
          const choices: { id: number; description: string }[] = [];
          const lines = output.split("\n");
          for (const line of lines) {
            const match = line.match(/^\s*(\d+)\s*\(ID:.*?\):\s*(.*)/);
            if (match) {
              choices.push({
                id: parseInt(match[1], 10),
                description: match[2].trim(),
              });
            }
          }
          if (choices.length > 0) {
            resolve({
              trackDetails: "",
              estimatedTime: "",
              choices,
              error: null,
            });
            return;
          }
        }

        // Parse total time
        const timeMatch = output.match(/Total time:\s*([\d:.]+)/i);
        const estimatedTime = timeMatch ? timeMatch[1] : "Unknown";

        // Collect track details simply by taking the text under "Tracks:"
        const tracksIndex = output.indexOf("Tracks:");
        let trackDetails = "";
        if (tracksIndex !== -1) {
          trackDetails = output.substring(tracksIndex).trim();
        }

        resolve({ trackDetails, estimatedTime, error: null });
      });

      proc.on("error", (err) =>
        resolve({ trackDetails: "", estimatedTime: "", error: err.message }),
      );
    });
  }

  async startCdRip(
    config: TranscodingConfig,
    releaseChoice?: number,
  ): Promise<{
    success: boolean;
    outputPath: string | null;
    error: string | null;
  }> {
    this.updateConfig(config);

    const ripperPath = await this.resolveRipperPath();
    const outputDir = this.config.outputDirectory;

    if (!outputDir) {
      return {
        success: false,
        outputPath: null,
        error: "Output directory not configured",
      };
    }

    const timestamp = Date.now();
    const specificOutputDir = path.join(outputDir, `cd_rip_${timestamp}`);
    this.currentJobOutputFolder = specificOutputDir;

    try {
      await fs.mkdir(specificOutputDir, { recursive: true });
    } catch (err) {
      return {
        success: false,
        outputPath: null,
        error: `Failed to create output dir: ${(err as Error).message}`,
      };
    }

    const args = ["-o", "flac"];
    if (releaseChoice !== undefined) {
      args.push("-R", releaseChoice.toString());
    }
    if (
      this.config.driveOffset !== undefined &&
      this.config.driveOffset !== null
    ) {
      args.push("-s", this.config.driveOffset.toString());
    }

    // Attempt to eject when done
    args.push("-Q");

    return new Promise((resolve) => {
      console.log(
        `Starting CD rip with command: ${ripperPath} ${args.join(" ")}`,
      );
      this.currentProcess = spawn(ripperPath, args, { cwd: specificOutputDir });
      let stderr = "";
      let output = "";

      const fileId = "cd-rip-job";

      this.currentProcess.stderr?.on("data", (data) => {
        stderr += data.toString();
        // Just emit a simple progress event (CyanRip output is tricky to parse percent exactly, so we'll just indicate it is ripping)
        // If there's specific output like "Track X/Y" we could parse it, but for now just send stage: "Ripping" and let frontend show indeterminate or basic progress
        const msg = data.toString();
        let percent = 50; // indeterminate
        const trackMatch = msg.match(/Track (\d+)/);
        if (trackMatch) {
          // roughly parse track number
          percent = Math.min(99, parseInt(trackMatch[1], 10) * 5); // very rough estimate
        }

        getMainWindow()?.webContents.send("cd-rip-progress", {
          fileId,
          percent,
          stage: "Ripping",
        });
      });

      this.currentProcess.stdout?.on("data", (data) => {
        output += data.toString();
        const msg = data.toString();
        let percent = 50;
        const trackMatch = msg.match(/Track (\d+)/);
        if (trackMatch) {
          percent = Math.min(99, parseInt(trackMatch[1], 10) * 5);
        }
        getMainWindow()?.webContents.send("cd-rip-progress", {
          fileId,
          percent,
          stage: "Ripping",
        });
      });

      this.currentProcess.on("close", (code) => {
        this.currentProcess = null;
        if (code === 0) {
          getMainWindow()?.webContents.send("cd-rip-progress", {
            fileId,
            percent: 100,
            stage: "Completed",
          });
          resolve({
            success: true,
            outputPath: specificOutputDir,
            error: null,
          });
        } else {
          resolve({
            success: false,
            outputPath: null,
            error: `Failed with code ${code}: ${stderr} ${output}`,
          });
        }
      });

      this.currentProcess.on("error", (err) => {
        this.currentProcess = null;
        resolve({ success: false, outputPath: null, error: err.message });
      });
    });
  }

  async cancelCdRip(): Promise<{ cancelled: boolean; error?: string }> {
    if (!this.currentProcess) {
      return { cancelled: false, error: "No CD rip in progress" };
    }

    this.currentProcess.kill("SIGTERM");

    // Force kill if necessary
    setTimeout(() => {
      if (this.currentProcess && !this.currentProcess.killed) {
        this.currentProcess.kill("SIGKILL");
      }
      this.currentProcess = null;
    }, 5000);

    // Clean up folder
    if (this.currentJobOutputFolder) {
      try {
        await fs.rm(this.currentJobOutputFolder, {
          recursive: true,
          force: true,
        });
        logger.info("Cleaned up cancelled rip folder", {
          folder: this.currentJobOutputFolder,
        });
      } catch (err) {
        logger.error("Failed to clean up folder", { error: err });
      }
      this.currentJobOutputFolder = null;
    }

    getMainWindow()?.webContents.send("cd-rip-progress", {
      fileId: "cd-rip-job",
      percent: 0,
      stage: "failed",
    });

    return { cancelled: true };
  }
}
