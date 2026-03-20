import { protocol } from "electron";
import log from "electron-log";
import { createReadStream, Stats, statSync } from "fs";
import path from "path";
import { lookup as lookupMime } from "mime-types";

/**
 * Register the 'stream://' scheme as privileged to allow fetch and streaming,
 * with support for Range requests (important for video/audio scrubbing).
 * Must be called before the app is ready.
 */
export function registerStreamScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "stream",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true, // Important for video/audio Range requests
        bypassCSP: true, // Allow media from stream:// to bypass Content Security Policy
      },
    },
  ]);
}

/**
 * Handle 'stream://' protocol requests by converting them to 'file://' URLs
 * and using net.fetch for proper Range request support.
 * Must be called after the app is ready.
 */
export function setupStreamHandler(): void {
  protocol.registerStreamProtocol("stream", (request, callback) => {
    try {
      const url = new URL(request.url);
      const encodedPath = url.pathname;

      let finalPath: string;
      if (process.platform === "win32") {
        const driveLetter = url.host;
        finalPath = `${driveLetter}:${decodeURIComponent(encodedPath)}`;
      } else {
        finalPath = decodeURIComponent(encodedPath);
      }

      // Normalize path to avoid any accidental url parts
      finalPath = path.normalize(finalPath);

      // minimal logging here; keep errors only to avoid noisy output

      // Stat file to get size
      let stat: Stats;
      try {
        stat = statSync(finalPath);
      } catch (err) {
        log.error("Stream stat error", { error: err, path: finalPath });
        return callback({ statusCode: 404 });
      }

      const total = stat.size;
      const rangeHeader =
        (request.headers && request.headers["range"]) ||
        (request.headers && request.headers.Range) ||
        null;

      if (rangeHeader) {
        // Parse Range: bytes=start-end
        const matches = /bytes=(\d*)-(\d*)/.exec(String(rangeHeader));
        if (!matches) {
          // Malformed Range
          return callback({ statusCode: 416 });
        }
        const start = matches[1] ? parseInt(matches[1], 10) : 0;
        const end = matches[2] ? parseInt(matches[2], 10) : total - 1;
        const chunkEnd = Math.min(end, total - 1);
        const chunkStart = Math.min(start, chunkEnd);

        const stream = createReadStream(finalPath, {
          start: chunkStart,
          end: chunkEnd,
        });
        const mime = lookupMime(finalPath) || "application/octet-stream";
        const headers = {
          "Content-Type": mime,
          "Content-Range": `bytes ${chunkStart}-${chunkEnd}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunkEnd - chunkStart + 1),
        };
        return callback({ statusCode: 206, headers, data: stream });
      }

      // No Range header — return full file as stream
      const stream = createReadStream(finalPath);
      const mime = lookupMime(finalPath) || "application/octet-stream";
      const headers = {
        "Content-Type": mime,
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
      };
      return callback({ statusCode: 200, headers, data: stream });
    } catch (err) {
      log.error("Stream handler error:", err);
      return callback({ statusCode: 500 });
    }
  });
}
