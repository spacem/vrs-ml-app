export type TranscodingMode = "local" | "compatibility";

export interface TranscodingConfig {
  enabled: boolean;
  mode: TranscodingMode;
  encoderPath: string;
  gpuAcceleration: boolean;
  maxVideoHeight: number | null;
  outputDirectory: string;
}

export type TranscodeJobStatus =
  | "queued"
  | "processing"
  | "done"
  | "failed"
  | "cancelled";

export interface TranscodeJob {
  id: string;
  fileId: string;
  inputPath: string;
  outputPath: string;
  status: TranscodeJobStatus;
  createdAt: number;
  completedAt: number | null;
  error: string | null;
}

export interface TranscodeProgress {
  fileId: string;
  percent: number;
  stage: string;
}

export interface TranscodeResult {
  success: boolean;
  outputPath: string | null;
  error: string | null;
}

export interface FileAnalysisResult {
  needsTranscoding: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  containerFormat: string | null;
  error: string | null;
}
