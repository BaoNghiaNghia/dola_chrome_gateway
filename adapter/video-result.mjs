import { createWriteStream, promises as fs } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;

  let current = value.trim();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!current) return null;
    try {
      const parsed = JSON.parse(current);
      if (typeof parsed === "string") {
        current = parsed.trim();
        continue;
      }
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function decodeVideoMainUrl(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;

  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8").trim();
    return /^https?:\/\//i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function resolutionFromObject(value) {
  if (!value || typeof value !== "object") {
    return { width: null, height: null };
  }

  const meta =
    value.meta ||
    value.video_meta ||
    value.videoMeta ||
    value.video_info ||
    value.videoInfo ||
    {};

  const width = numberOrNull(
    value.width ??
      value.video_width ??
      value.videoWidth ??
      value.vwidth ??
      meta.width ??
      meta.video_width ??
      meta.videoWidth,
  );
  const height = numberOrNull(
    value.height ??
      value.video_height ??
      value.videoHeight ??
      value.vheight ??
      meta.height ??
      meta.video_height ??
      meta.videoHeight,
  );

  return {
    width: width ? Math.round(width) : null,
    height: height ? Math.round(height) : null,
  };
}

function resolutionHint(value) {
  const label = String(
    value?.definition ??
      value?.quality ??
      value?.gear_name ??
      value?.gearName ??
      value?.name ??
      "",
  );
  const match = label.match(/(?:^|\D)(2160|1440|1080|720|540|480|360)p?(?:\D|$)/i);
  return match ? Number(match[1]) : 0;
}

function candidateScore(candidate) {
  const area =
    candidate.width && candidate.height
      ? candidate.width * candidate.height
      : 0;
  const hintedHeight = candidate.resolutionHint || 0;

  return [
    candidate.noWatermark ? 1 : 0,
    area > 0 ? 1 : 0,
    area,
    hintedHeight,
    candidate.bitrate || 0,
  ];
}

function compareCandidates(a, b) {
  const aa = candidateScore(a);
  const bb = candidateScore(b);
  for (let index = 0; index < aa.length; index += 1) {
    if (aa[index] !== bb[index]) return bb[index] - aa[index];
  }
  return 0;
}

function videoListEntries(videoModel) {
  const parsed = parseMaybeJson(videoModel);
  if (!parsed) return [];

  const list =
    parsed.video_list ||
    parsed.videoList ||
    parsed.video?.video_list ||
    parsed.video?.videoList ||
    null;

  if (Array.isArray(list)) return list;
  if (list && typeof list === "object") return Object.values(list);
  return [];
}

export function extractOriginalVideoCandidates(videoModels = []) {
  const candidates = [];
  const seen = new Set();

  for (const videoModel of videoModels || []) {
    for (const entry of videoListEntries(videoModel)) {
      if (!entry || typeof entry !== "object") continue;
      const url = decodeVideoMainUrl(
        entry.main_url ??
          entry.mainUrl ??
          entry.play_url ??
          entry.playUrl ??
          entry.url,
      );
      if (!url || seen.has(url)) continue;
      seen.add(url);

      const { width, height } = resolutionFromObject(entry);
      const bitrate =
        numberOrNull(
          entry.bitrate ??
            entry.real_bitrate ??
            entry.realBitrate ??
            entry.bit_rate ??
            entry.bitRate,
        ) || 0;

      candidates.push({
        url,
        sourceKind: "video_model",
        noWatermark: true,
        width,
        height,
        bitrate: Math.round(bitrate),
        resolutionHint: resolutionHint(entry),
      });
    }
  }

  return candidates.sort(compareCandidates);
}

export function selectBestVideoResult(videoModels = [], fallbackUrls = []) {
  const originals = extractOriginalVideoCandidates(videoModels);
  const fallbackUrl = (fallbackUrls || []).find(
    (url) => typeof url === "string" && /^https?:\/\//i.test(url),
  );

  if (originals.length > 0) {
    const selected = originals[0];
    return {
      ...selected,
      fallbackUrl: fallbackUrl && fallbackUrl !== selected.url ? fallbackUrl : null,
      candidateCount: originals.length,
    };
  }

  if (fallbackUrl) {
    return {
      url: fallbackUrl,
      fallbackUrl: null,
      sourceKind: "download_url",
      noWatermark: false,
      width: null,
      height: null,
      bitrate: 0,
      resolutionHint: 0,
      candidateCount: 0,
    };
  }

  return null;
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1"
  ) {
    return true;
  }

  const family = isIP(host);
  if (family === 4) {
    const parts = host.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (family === 6) {
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  }

  return false;
}

export function validateVideoDownloadUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Video result URL is invalid.");
  }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("Video result URL must use HTTP(S).");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Video result URL must not contain embedded credentials.");
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error("Video result URL points to a blocked local/private address.");
  }

  return parsed.toString();
}

function extensionFromResponse(response, url) {
  const type = String(response.headers.get("content-type") || "").toLowerCase();
  if (type.includes("webm")) return ".webm";
  if (type.includes("quicktime")) return ".mov";

  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".webm")) return ".webm";
    if (pathname.endsWith(".mov")) return ".mov";
  } catch {
    // Default to MP4 below.
  }
  return ".mp4";
}

function safeJobId(jobId) {
  return String(jobId || "generation").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

async function fetchValidatedVideoUrl(rawUrl, maxRedirects = 5) {
  let current = validateVideoDownloadUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        Accept: "video/*,application/octet-stream;q=0.9,*/*;q=0.5",
        Referer: "https://www.dola.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      },
      signal: AbortSignal.timeout(5 * 60_000),
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current };
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Video CDN returned HTTP ${response.status} without a redirect location.`);
    }
    if (redirectCount >= maxRedirects) {
      throw new Error("Video download exceeded the maximum redirect count.");
    }

    current = validateVideoDownloadUrl(new URL(location, current).toString());
  }

  throw new Error("Video download redirect handling failed.");
}

async function downloadOnce(url, jobId, outputDir) {
  const safeUrl = validateVideoDownloadUrl(url);
  const { response, finalUrl } = await fetchValidatedVideoUrl(safeUrl);

  if (!response.ok || !response.body) {
    throw new Error(
      `Video download failed with HTTP ${response.status} ${response.statusText}`,
    );
  }

  await fs.mkdir(outputDir, { recursive: true });
  const extension = extensionFromResponse(response, finalUrl);
  const finalPath = path.resolve(outputDir, `${safeJobId(jobId)}${extension}`);
  const tempPath = `${finalPath}.part`;

  await fs.rm(tempPath, { force: true });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(tempPath, { flags: "w" }),
    );
    const stat = await fs.stat(tempPath);
    if (stat.size <= 0) {
      throw new Error("Downloaded video file is empty.");
    }
    await fs.rm(finalPath, { force: true });
    await fs.rename(tempPath, finalPath);
    return {
      localPath: finalPath,
      fileSize: stat.size,
      usedUrl: finalUrl,
    };
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function downloadVideoResult(result, jobId, options = {}) {
  if (!result?.url) throw new Error("No video result URL is available.");

  const outputDir = path.resolve(
    options.outputDir ||
      process.env.DOLA_DOWNLOAD_DIR ||
      path.join(process.cwd(), "downloads"),
  );

  try {
    const downloaded = await downloadOnce(result.url, jobId, outputDir);
    return {
      ...result,
      url: downloaded.usedUrl,
      localPath: downloaded.localPath,
      fileSize: downloaded.fileSize,
    };
  } catch (primaryError) {
    if (!result.fallbackUrl || result.fallbackUrl === result.url) {
      throw primaryError;
    }

    const downloaded = await downloadOnce(result.fallbackUrl, jobId, outputDir);
    return {
      ...result,
      url: downloaded.usedUrl,
      localPath: downloaded.localPath,
      fileSize: downloaded.fileSize,
      sourceKind: "download_url",
      noWatermark: false,
      width: null,
      height: null,
      bitrate: 0,
      fallbackUsed: true,
      primaryDownloadError:
        primaryError instanceof Error ? primaryError.message : String(primaryError),
    };
  }
}
