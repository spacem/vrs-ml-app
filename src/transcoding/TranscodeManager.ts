import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
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

  private resolveFfmpegPath(): string {
    const encoderPath = this.config.encoderPath?.trim();
    if (!encoderPath) return "ffmpeg";

    // If it's a directory, append ffmpeg.exe
    const stats = fs.statSync(encoderPath, { throwIfNoEntry: false });
    if (stats?.isDirectory()) {
      return path.join(
        encoderPath,
        process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
      );
    }

    // If it's a file path, use as-is
    return encoderPath;
  }

  private resolveFfprobePath(): string {
    const encoderPath = this.config.encoderPath?.trim();
    if (!encoderPath) return "ffprobe";

    try {
      // If it's a directory, append ffprobe.exe
      const stats = fs.statSync(encoderPath, { throwIfNoEntry: false });
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

      if (fs.existsSync(candidate)) {
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
    const ffprobePath = this.resolveFfprobePath();
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
    const ffmpegPath = this.resolveFfmpegPath();

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
    // Handle directory path - append ffmpeg.exe
    let ffmpegPath = encoderPath || "ffmpeg";
    const stats = fs.statSync(encoderPath, { throwIfNoEntry: false });
    if (stats?.isDirectory()) {
      ffmpegPath = path.join(
        encoderPath,
        process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
      );
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

  async transcodeFile(
    fileId: string,
    inputPath: string,
  ): Promise<TranscodeResult> {
    console.log(
      `[TranscodeManager] transcodeFile called: fileId=${fileId}, inputPath=${inputPath}, config=`,
      this.config,
    );
    const outputPath = `${this.config.outputDirectory}/${fileId}_transcoded_${Date.now()}.mp4`;
    logger.info("Starting transcode", { fileId, inputPath, outputPath });

    const classification = classifyFile(inputPath);
    if (classification === "skip") {
      logger.info("File in skip list, skipping transcode", { fileId });
      return { success: true, outputPath: null, error: null };
    }

    const analysis = await this.analyzeFile(inputPath);
    if (analysis.error) {
      logger.error("Analysis failed, treating as skip", {
        fileId,
        error: analysis.error,
      });
      return { success: true, outputPath: null, error: null };
    }

    const needsTranscoding = needsTranscodingForMode(
      analysis.videoCodec,
      analysis.audioCodec,
      analysis.containerFormat,
      this.config.mode,
    );

    logger.info("Analysis result", {
      fileId,
      videoCodec: analysis.videoCodec,
      audioCodec: analysis.audioCodec,
      containerFormat: analysis.containerFormat,
      mode: this.config.mode,
      needsTranscoding,
    });

    if (!needsTranscoding) {
      logger.info("File already compatible, no transcoding needed", { fileId });
      return { success: true, outputPath: null, error: null };
    }

    const gpuEncoder = await this.resolveGpuEncoder();
    const videoArg = selectVideoCodecArg(analysis.videoCodec, gpuEncoder);
    const audioArg = selectAudioCodecArg(analysis.audioCodec);

    const ffmpegPath = this.resolveFfmpegPath();

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
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
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
      this.processes.set(fileId, proc);

      // Lower process priority
      // disabling this, we want it to be fast and are only doing one at a time
      // if (process.platform === "win32") {
      //   spawn("powershell", [
      //     "-Command",
      //     `Get-Process -Id ${proc.pid} | ForEach-Object { $_.PriorityClass = 'BelowNormal' }`,
      //   ]);
      // } else {
      //   spawn("renice", ["-n", "10", String(proc.pid)]);
      // }

      let stderr = "";

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        this.processes.delete(fileId);

        if (code === 0) {
          logger.info("Transcode completed", { fileId, outputPath });
          resolve({ success: true, outputPath, error: null });
        } else {
          const lastLines = stderr.split("\n").slice(-5).join("\n");
          logger.error("Transcode failed", {
            fileId,
            exitCode: code,
            lastLines,
          });
          resolve({ success: false, outputPath: null, error: lastLines });
        }
      });

      proc.on("error", (err) => {
        this.processes.delete(fileId);
        logger.error("Transcode spawn error", { fileId, error: err.message });
        resolve({ success: false, outputPath: null, error: err.message });
      });
    });
  }

  async cancelTranscoding(fileId: string): Promise<{ cancelled: boolean }> {
    const proc = this.processes.get(fileId);
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

    this.processes.delete(fileId);
    logger.info("Cancelled transcoding", { fileId });
    return { cancelled: true };
  }
}
