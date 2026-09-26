import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeVideoMainUrl,
  extractOriginalVideoCandidates,
  selectBestVideoResult,
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

test("prefers higher resolution original stream before bitrate", () => {
  const model = JSON.stringify({
    video_list: {
      low: {
        main_url: encoded("https://cdn.example.test/720.mp4"),
        width: 1280,
        height: 720,
        bitrate: 12_000_000,
      },
      full: {
        main_url: encoded("https://cdn.example.test/1080.mp4"),
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

  assert.equal(result.url, "https://cdn.example.test/1080.mp4");
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
  assert.equal(result.noWatermark, true);
  assert.equal(result.sourceKind, "video_model");
  assert.equal(result.fallbackUrl, "https://cdn.example.test/fallback.mp4");
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

test("falls back to Dola download_url when no original stream exists", () => {
  const result = selectBestVideoResult(
    ["{}"],
    ["https://cdn.example.test/download.mp4"],
  );

  assert.equal(result.url, "https://cdn.example.test/download.mp4");
  assert.equal(result.sourceKind, "download_url");
  assert.equal(result.noWatermark, false);
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
