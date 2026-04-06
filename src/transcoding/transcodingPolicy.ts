import { TranscodingMode } from "./types";

/**
 * File extensions that should be skipped entirely (no analysis, no transcoding).
 * These are audio files that don't need video transcoding.
 */
export const SKIP_EXTENSIONS: Set<string> = new Set([
  "mp3",
  "flac",
  "m4a",
  "wav",
  "opus",
]);

/**
 * Video codecs that can be passed through without re-encoding.
 * These are widely supported and don't require transcoding.
 */
export const PASSTHROUGH_VIDEO_CODECS: Set<string> = new Set([
  "h264",
  "hevc",
  "av1",
]);

/**
 * Audio codecs that can be passed through without re-encoding.
 * These are widely supported and don't require transcoding.
 */
export const PASSTHROUGH_AUDIO_CODECS: Set<string> = new Set([
  "aac",
  "mp3",
  "opus",
  "vorbis",
  "flac",
]);

export function classifyFile(filename: string): "skip" | "evaluate" {
  const ext = filename.toLowerCase().split(".").pop() || "";
  if (SKIP_EXTENSIONS.has(ext)) {
    return "skip";
  }
  return "evaluate";
}

export function needsTranscodingForMode(
  videoCodec: string | null,
  audioCodec: string | null,
  containerFormat: string | null,
  mode: TranscodingMode,
): boolean {
  if (mode === "local") {
    const videoOk = videoCodec
      ? PASSTHROUGH_VIDEO_CODECS.has(videoCodec)
      : true;
    const audioOk = audioCodec
      ? PASSTHROUGH_AUDIO_CODECS.has(audioCodec)
      : true;
    return !(videoOk && audioOk);
  }

  if (mode === "compatibility") {
    const isMp4Container =
      containerFormat === "mp4" || containerFormat === "mov";
    const videoOk = videoCodec
      ? PASSTHROUGH_VIDEO_CODECS.has(videoCodec)
      : true;
    const audioOk = audioCodec
      ? PASSTHROUGH_AUDIO_CODECS.has(audioCodec)
      : true;
    return !(isMp4Container && videoOk && audioOk);
  }

  return true;
}

export function selectVideoCodecArg(
  detectedCodec: string | null,
  gpuEncoder: string | null,
): string {
  if (detectedCodec && PASSTHROUGH_VIDEO_CODECS.has(detectedCodec)) {
    return "copy";
  }
  return gpuEncoder ?? "libx264";
}

export function selectAudioCodecArg(detectedCodec: string | null): string {
  if (detectedCodec && PASSTHROUGH_AUDIO_CODECS.has(detectedCodec)) {
    return "copy";
  }
  // were were transcoding to apples lossless ALAC but that doesn't work with electron
  // so decided on flac for now
  return "flac";
}
