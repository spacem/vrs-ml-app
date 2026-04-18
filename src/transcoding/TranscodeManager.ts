import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs/promises";
import log from "electron-log";
import {
  TranscodingConfig,
  TranscodeResult,
  FileAnalysisResult,
} from "./types";
import {
  classifyFile,
  needsTranscodingForMode,
  selectVideoCodecArg,
  selectAudioCodecArg,
} from "./transcodingPolicy";

const logger = {
  info: (msg: string, ctx?: Record<string, unknown>) =>
    log.info(`[TranscodeManager] ${msg}`, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) =>
    log.error(`[TranscodeManager] ${msg}`, ctx),
};

export class TranscodeManager {
  private config: TranscodingConfig;
  private processes: Map<string, ChildProcess> = new Map();

  constructor(config: TranscodingConfig) {
    this.config = config;
  }

  updateConfig(config: TranscodingConfig): void {
    this.config = config;
  }

  private async resolveFfmpegPath(): Promise<string> {
    const encoderPath = this.config.encoderPath?.trim();
    if (!encoderPath) return "ffmpeg";

    try {
      // If it's a directory, append ffmpeg.exe
      const stats = await fs.stat(encoderPath);
      if (stats?.isDirectory()) {
        return path.join(
          encoderPath,
          process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
        );
      }
    } catch (e) {
      // Missing path should not break transcoding setup; fall back to raw path/PATH resolution.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.error("Error resolving ffmpeg path", {
          encoderPath,
          error: (e as Error).message,
        });
      }
    }

    // If it's a file path, use as-is
    return encoderPath;
  }

  private async resolveFfprobePath(): Promise<string> {
    const encoderPath = this.config.encoderPath?.trim();
    if (!encoderPath) return "ffprobe";

    try {
      // If it's a directory, append ffprobe.exe
      const stats = await fs.stat(encoderPath);
      if (stats?.isDirectory()) {
        const ffprobePath = path.join(
          encoderPath,
          process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
        );
        logger.info("Resolved ffprobe from directory", {
          encoderPath,
          ffprobePath,
        });
        return ffprobePath;
      }

      // Derive ffprobe from ffmpeg filename
      const dir = path.dirname(encoderPath);
      const base = path.basename(encoderPath, path.extname(encoderPath));
      const candidate = path.join(
        dir,
        base.replace(/ffmpeg/i, "ffprobe") +
          (process.platform === "win32" ? ".exe" : ""),
      );

      if (
        await fs
          .access(candidate)
          .then(() => true)
          .catch(() => false)
      ) {
        logger.info("Resolved ffprobe from ffmpeg path", { candidate });
        return candidate;
      }
    } catch (e) {
      logger.error("Error resolving ffprobe path", {
        encoderPath,
        error: (e as Error).message,
      });
    }

    logger.info("Falling back to ffprobe in PATH", { encoderPath });
    return "ffprobe";
  }

  private async analyzeFile(filePath: string): Promise<FileAnalysisResult> {
    const ffprobePath = await this.resolveFfprobePath();
    const args = [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      filePath,
    ];

    logger.info("Running ffprobe", { ffprobePath, args: args.join(" ") });

    return new Promise((resolve) => {
      const proc = spawn(ffprobePath, args);

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          logger.error("ffprobe failed", {
            filePath,
            code,
            stderr,
            stdout: stdout.slice(0, 500),
          });
          resolve({
            needsTranscoding: false,
            videoCodec: null,
            audioCodec: null,
            containerFormat: null,
            error: stderr || `ffprobe exited with code ${code}`,
          });
          return;
        }

        logger.info("ffprobe raw output", {
          filePath,
          stdoutPreview: stdout.slice(0, 1000),
        });

        try {
          const result = JSON.parse(stdout);
          const streams = result.streams || [];

          const videoStream = streams.find(
            (s: { codec_type?: string }) => s.codec_type === "video",
          );
          const audioStream = streams.find(
            (s: { codec_type?: string }) => s.codec_type === "audio",
          );

          const videoCodec = videoStream?.codec_name?.toLowerCase() || null;
          const audioCodec = audioStream?.codec_name?.toLowerCase() || null;

          const formatName = result.format?.format_name || "";
          const detectedContainer =
            formatName.includes("mp4") || formatName.includes("mov")
              ? "mp4"
              : formatName;

          // Fallback to file extension if ffprobe format detection is empty
          let containerFormat = detectedContainer;
          if (!containerFormat) {
            const ext = path.extname(filePath).toLowerCase().replace(".", "");
            if (["mp4", "m4v", "mov", "m4a", "3gp", "3g2"].includes(ext)) {
              containerFormat = "mp4";
            } else {
              containerFormat = ext || null;
            }
          }

          resolve({
            needsTranscoding: true,
            videoCodec,
            audioCodec,
            containerFormat,
            error: null,
          });
        } catch (e) {
          logger.error("Failed to parse ffprobe output", {
            filePath,
            error: e,
          });
          resolve({
            needsTranscoding: false,
            videoCodec: null,
            audioCodec: null,
            containerFormat: null,
            error: "Failed to parse ffprobe output",
          });
        }
      });

      proc.on("error", (err) => {
        logger.error("ffprobe spawn error", { filePath, error: err.message });
        resolve({
          needsTranscoding: false,
          videoCodec: null,
          audioCodec: null,
          containerFormat: null,
          error: err.message,
        });
      });
    });
  }

  private async resolveGpuEncoder(): Promise<string | null> {
    if (!this.config.gpuAcceleration) {
      return null;
    }

    const encoders = ["h264_nvenc", "h264_amf", "h264_qsv"];

    for (const encoder of encoders) {
      const isSupported = await this.testGpuEncoder(encoder);
      if (isSupported.supported) {
        return encoder;
      }
    }

    return null;
  }

  async testGpuEncoder(encoderName: string): Promise<{ supported: boolean }> {
    const ffmpegPath = await this.resolveFfmpegPath();

    return new Promise((resolve) => {
      const proc = spawn(ffmpegPath, [
        "-f",
        "lavfi",
        "-i",
        "nullsrc",
        "-t",
        "1",
        "-c:v",
        encoderName,
        "-f",
        "null",
        "-",
      ]);

      proc.on("close", (code) => {
        resolve({ supported: code === 0 });
      });

      proc.on("error", () => {
        resolve({ supported: false });
      });
    });
  }

  async testFfmpegPath(
    encoderPath: string,
  ): Promise<{ success: boolean; version: string | null }> {
    // Handle directory path - append ffmpeg binary name
    const configuredPath = encoderPath?.trim();
    let ffmpegPath = configuredPath || "ffmpeg";

    if (configuredPath) {
      try {
        const stats = await fs.stat(configuredPath);
        if (stats?.isDirectory()) {
          ffmpegPath = path.join(
            configuredPath,
            process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
          );
        }
      } catch {
        // Keep configured path and let spawn() surface runtime validation result.
        return { success: false, version: null };
      }
    }

    return new Promise((resolve) => {
      const proc = spawn(ffmpegPath, ["-version"]);

      let stdout = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.on("close", (code) => {
        const firstLine = stdout.split("\n")[0]?.trim() || null;
        resolve({ success: code === 0, version: firstLine });
      });

      proc.on("error", () => {
        resolve({ success: false, version: null });
      });
    });
  }

  async needsTranscoding(
    storageId: string,
    inputPath: string,
    analysisOverride?: FileAnalysisResult,
  ): Promise<boolean> {
    const classification = classifyFile(inputPath);
    if (classification === "skip") {
      logger.info("File in skip list, skipping transcode", { storageId });
      return false;
    }

    const analysis = analysisOverride || (await this.analyzeFile(inputPath));
    if (analysis.error) {
      logger.error("Analysis failed, treating as skip", {
        storageId,
        error: analysis.error,
      });
      return false;
    }

    const needsTranscoding = needsTranscodingForMode(
      analysis.videoCodec,
      analysis.audioCodec,
      analysis.containerFormat,
      this.config.mode,
    );
    logger.info("Analysis result", {
      storageId,
      videoCodec: analysis.videoCodec,
      audioCodec: analysis.audioCodec,
      containerFormat: analysis.containerFormat,
      mode: this.config.mode,
      needsTranscoding,
    });
    return needsTranscoding;
  }

  async transcodeFile(
    storageId: string,
    inputPath: string,
  ): Promise<TranscodeResult> {
    console.log(
      `[TranscodeManager] transcodeFile called: storageId=${storageId}, inputPath=${inputPath}, config=`,
      this.config,
    );

    // see if existing exists and is compatible before starting a new transcode
    try {
      const existingFiles = await fs.readdir(this.config.outputDirectory);
      const existingFile = existingFiles.filter((f) =>
        f.startsWith(`${storageId}_transcoded_`),
      );
      for (const file of existingFile) {
        const existingPath = path.join(this.config.outputDirectory, file);
        if (!(await this.needsTranscoding(storageId, existingPath))) {
          logger.info("Found existing compatible transcoded file, reusing", {
            storageId,
            outputPath: existingPath,
          });
          return { success: true, outputPath: existingPath, error: null };
        }
      }
    } catch (e) {
      logger.error("Error checking existing transcoded files", {
        storageId,
        error: (e as Error).message,
      });
    }

    const outputPath = path.join(
      this.config.outputDirectory,
      `${storageId}_transcoded_${Date.now()}.mp4`,
    );
    const analysis = await this.analyzeFile(inputPath);
    const needsTranscoding = await this.needsTranscoding(
      storageId,
      inputPath,
      analysis,
    );

    if (!needsTranscoding) {
      logger.info("File already compatible, no transcoding needed", {
        storageId,
      });
      return { success: true, outputPath: null, error: null };
    }

    logger.info("Starting transcode", { storageId, inputPath, outputPath });
    const gpuEncoder = await this.resolveGpuEncoder();
    const videoArg = selectVideoCodecArg(analysis.videoCodec, gpuEncoder);
    const audioArg = selectAudioCodecArg(analysis.audioCodec);

    const ffmpegPath = await this.resolveFfmpegPath();

    const initialHwArg =
      gpuEncoder && videoArg != "copy" ? ["-hwaccel", "cuda"] : [];

    const args: string[] = [
      ...initialHwArg,
      "-i",
      inputPath,
      "-c:v",
      videoArg,
      "-c:a",
      audioArg,
      "-movflags",
      "+faststart",
    ];

    if (this.config.maxVideoHeight && videoArg !== "copy") {
      // 'ih' is FFmpeg's internal variable for input height.
      // min(ih, max) ensures we scale down if it's too big,
      // but leave it alone if it's already smaller.
      args.push("-vf", `scale=-2:'min(ih,${this.config.maxVideoHeight})'`);
    }

    args.push(outputPath);

    // Ensure output directory exists
    try {
      const outputDir = path.dirname(outputPath);
      try {
        await fs.access(outputDir);
      } catch {
        await fs.mkdir(outputDir, { recursive: true });
        logger.info("Created output directory", { outputDir });
      }
    } catch (e) {
      logger.error("Failed to create output directory", {
        outputPath,
        error: (e as Error).message,
      });
      return {
        success: false,
        outputPath: null,
        error: `Failed to create output directory: ${(e as Error).message}`,
      };
    }

    return new Promise((resolve) => {
      const proc = spawn(ffmpegPath, args);
      console.log(`Launching with: ${ffmpegPath} ${args.join(" ")}`);
      this.processes.set(storageId, proc);

      let stderr = "";

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        this.processes.delete(storageId);

        if (code === 0) {
          logger.info("Transcode completed", { storageId, outputPath });
          resolve({ success: true, outputPath, error: null });
        } else {
          const lastLines = stderr.split("\n").slice(-5).join("\n");
          logger.error("Transcode failed", {
            storageId,
            exitCode: code,
            lastLines,
          });
          resolve({ success: false, outputPath: null, error: lastLines });
        }
      });

      proc.on("error", (err) => {
        this.processes.delete(storageId);
        logger.error("Transcode spawn error", {
          storageId,
          error: err.message,
        });
        resolve({ success: false, outputPath: null, error: err.message });
      });
    });
  }

  async cancelTranscoding(storageId: string): Promise<{ cancelled: boolean }> {
    const proc = this.processes.get(storageId);
    if (!proc) {
      return { cancelled: false };
    }

    proc.kill("SIGTERM");

    // Force kill after 5 seconds if still running
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
    }, 5000);

    this.processes.delete(storageId);
    logger.info("Cancelled transcoding", { storageId });
    return { cancelled: true };
  }
}
