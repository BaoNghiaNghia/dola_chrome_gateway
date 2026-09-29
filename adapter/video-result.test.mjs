import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeVideoMainUrl,
  extractOriginalVideoCandidates,
  expectedVideoBytes,
  isSuspiciouslySmallVideo,
  selectBestVideoResult,
  VideoQualityUnavailableError,
  validateVideoDownloadUrl,
} from "./video-result.mjs";

function encoded(url) {
  return Buffer.from(url, "utf8").toString("base64");
}

test("decodes Dola video_model main_url from base64", () => {
  const url = "https://cdn.example.test/original.mp4";
  assert.equal(decodeVideoMainUrl(encoded(url)), url);
  assert.equal(decodeVideoMainUrl(url), url);
  assert.equal(decodeVideoMainUrl("not-valid-video-url"), null);
});

test("prefers the highest-bitrate original stream like dola-render-gateway", () => {
  const model = JSON.stringify({
    video_list: {
      highBitrate: {
        main_url: encoded("https://cdn.example.test/720-high.mp4"),
        width: 1280,
        height: 720,
        bitrate: 12_000_000,
      },
      lowerBitrate1080: {
        main_url: encoded("https://cdn.example.test/1080-low.mp4"),
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
      },
    },
  });

  const result = selectBestVideoResult(
    [model],
    ["https://cdn.example.test/fallback.mp4"],
  );

  assert.equal(result.url, "https://cdn.example.test/720-high.mp4");
  assert.equal(result.bitrate, 12_000_000);
  assert.equal(result.noWatermark, true);
  assert.equal(result.sourceKind, "video_model");
  assert.equal(result.alternates.length, 1);
  assert.equal(result.alternates[0].url, "https://cdn.example.test/1080-low.mp4");
});

test("uses highest bitrate original stream when resolution metadata is absent", () => {
  const model = JSON.stringify({
    video_list: [
      {
        main_url: encoded("https://cdn.example.test/a.mp4"),
        bitrate: 4_000_000,
      },
      {
        main_url: encoded("https://cdn.example.test/b.mp4"),
        real_bitrate: 9_000_000,
      },
    ],
  });

  const candidates = extractOriginalVideoCandidates([model]);
  assert.equal(candidates[0].url, "https://cdn.example.test/b.mp4");
  assert.equal(candidates[0].bitrate, 9_000_000);
});

test("reads bitrate from nested Dola metadata when top-level bitrate is absent", () => {
  const model = JSON.stringify({
    video_list: {
      low: {
        main_url: encoded("https://cdn.example.test/low.mp4"),
        bitrate: 2_000_000,
      },
      original: {
        main_url: encoded("https://cdn.example.test/original.mp4"),
        video_meta: { real_bitrate: 10_000_000 },
      },
    },
  });

  const result = selectBestVideoResult([model], []);
  assert.equal(result.url, "https://cdn.example.test/original.mp4");
  assert.equal(result.bitrate, 10_000_000);
});

test("quality guard detects a ~1MB rendition when bitrate predicts ~10MB", () => {
  const candidate = { bitrate: 8_000_000, duration: 10 };
  assert.equal(expectedVideoBytes(candidate), 10_000_000);
  assert.equal(isSuspiciouslySmallVideo(candidate, 1_000_000), true);
  assert.equal(isSuspiciouslySmallVideo(candidate, 9_000_000), false);
});

test("quality-unavailable errors are explicitly retriable by the profile watcher", () => {
  const error = new VideoQualityUnavailableError("original not ready", {
    bitrate: 8_000_000,
  });
  assert.equal(error.code, "quality_unavailable");
  assert.equal(error.name, "VideoQualityUnavailableError");
  assert.equal(error.details.bitrate, 8_000_000);
});

test("does not accept Dola download_url when no clean original stream exists", () => {
  const result = selectBestVideoResult(
    ["{}"],
    ["https://cdn.example.test/download.mp4"],
  );

  assert.equal(result, null);
});

test("selects the highest available clean quality even above 1080p", () => {
  const model = JSON.stringify({
    video_list: [
      {
        main_url: encoded("https://cdn.example.test/1080.mp4"),
        width: 1920,
        height: 1080,
        bitrate: 10_000_000,
      },
      {
        main_url: encoded("https://cdn.example.test/2160.mp4"),
        width: 3840,
        height: 2160,
        bitrate: 18_000_000,
      },
      {
        main_url: encoded("https://cdn.example.test/720.mp4"),
        width: 1280,
        height: 720,
        bitrate: 12_000_000,
      },
    ],
  });

  const result = selectBestVideoResult([model], []);
  assert.equal(result.url, "https://cdn.example.test/2160.mp4");
  assert.equal(result.width, 3840);
  assert.equal(result.height, 2160);
  assert.equal(result.noWatermark, true);
  assert.deepEqual(
    result.alternates.map((candidate) => candidate.url),
    [
      "https://cdn.example.test/720.mp4",
      "https://cdn.example.test/1080.mp4",
    ],
  );
});

test("blocks local and private download targets", () => {
  assert.throws(
    () => validateVideoDownloadUrl("http://127.0.0.1/video.mp4"),
    /blocked/i,
  );
  assert.throws(
    () => validateVideoDownloadUrl("http://192.168.1.20/video.mp4"),
    /blocked/i,
  );
  assert.equal(
    validateVideoDownloadUrl("https://cdn.example.test/video.mp4"),
    "https://cdn.example.test/video.mp4",
  );
});
