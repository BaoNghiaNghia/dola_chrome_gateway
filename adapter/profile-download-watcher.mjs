import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { CdpClient, delay } from "./cdp.mjs";
import {
  extractConversationId,
  SeedanceDriver,
} from "./seedance-driver.mjs";
import {
  downloadVideoResult,
  selectBestVideoResult,
} from "./video-result.mjs";

const browserWebsocketUrl = process.argv[2] || "";
const profileId = process.argv[3] || "profile";
const browserPid = Number(process.argv[4] || 0);
const outputDir = process.env.DOLA_DOWNLOAD_DIR || "";
const statusFile = process.env.DOLA_PROFILE_STATUS_FILE || "";
const pollMs = Math.max(3_000, Number(process.env.DOLA_PROFILE_WATCHER_POLL_MS || 5_000));
const conversationRefreshMs = Math.max(
  15_000,
  Number(process.env.DOLA_PROFILE_CONVERSATION_REFRESH_MS || 30_000),
);

if (!browserWebsocketUrl) {
  console.error("[profile-watcher] Missing browser websocket URL.");
  process.exit(2);
}

const cdp = new CdpClient(browserWebsocketUrl);
const downloadedUrls = new Set();
let consecutiveCdpFailures = 0;
let activeConversationId = null;
let lastConversationRefreshAt = 0;

function log(message) {
  console.log(
    `[${new Date().toISOString()}] [profile-watcher:${profileId}] ${message}`,
  );
}

async function persistDownloadStatus(downloaded) {
  if (!statusFile) return;

  const tempFile = `${statusFile}.tmp`;
  await fs.writeFile(
    tempFile,
    JSON.stringify({
      localPath: downloaded.localPath,
      downloadedAt: new Date().toISOString(),
    }),
    "utf8",
  );
  await fs.rename(tempFile, statusFile);
}

function browserProcessIsAlive() {
  if (!Number.isInteger(browserPid) || browserPid <= 0) return false;
  try {
    process.kill(browserPid, 0);
    return true;
  } catch {
    return false;
  }
}

async function closeProfileBrowser() {
  log("download complete; closing Chrome profile");

  try {
    await cdp.send("Browser.close", {}, undefined, 5_000);
  } catch (error) {
    // Chrome may close the DevTools websocket before Browser.close returns.
    log(
      `browser close connection ended: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await delay(1_200);
  if (!browserProcessIsAlive()) {
    log("Chrome profile closed");
    return;
  }

  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill",
      ["/PID", String(browserPid), "/T", "/F"],
      { windowsHide: true, encoding: "utf8" },
    );
    if (result.status !== 0 && browserProcessIsAlive()) {
      throw new Error(
        `Chrome profile PID ${browserPid} did not close: ${String(
          result.stderr || result.stdout || "taskkill failed",
        ).trim()}`,
      );
    }
  } else {
    try {
      process.kill(browserPid, "SIGTERM");
    } catch {}
  }

  log("Chrome profile closed after download");
}

try {
  await cdp.connect();
  const { sessionId } = await cdp.attachToPage("https://www.dola.com");
  const driver = new SeedanceDriver(cdp, sessionId, {
    timeoutSeconds: 1200,
    manualVerificationSeconds: 180,
    log,
  });

  log("started; watching Dola conversations for completed original video streams");

  while (true) {
    try {
      const now = Date.now();
      if (
        !activeConversationId ||
        now - lastConversationRefreshAt >= conversationRefreshMs
      ) {
        const state = await driver.snapshot();
        const nextConversationId = extractConversationId(state?.url);
        lastConversationRefreshAt = now;

        if (nextConversationId && nextConversationId !== activeConversationId) {
          activeConversationId = nextConversationId;
          log(`watching conversation ${activeConversationId}`);
        }

        if (!activeConversationId) {
          await delay(pollMs);
          continue;
        }
      }
      consecutiveCdpFailures = 0;

      const poll = await driver
        .pollConversationApi(activeConversationId)
        .catch(() => null);
      if (!poll?.ok) {
        await delay(pollMs);
        continue;
      }

      const selected = selectBestVideoResult(
        poll.videoModels || [],
        poll.videos || [],
      );
      if (!selected?.url || downloadedUrls.has(selected.url)) {
        await delay(pollMs);
        continue;
      }

      const finalized = await driver.finalizeVideoCandidate(selected);
      log(
        `video ready; downloading highest-quality clean stream ${finalized.width || "?"}x${finalized.height || "?"} bitrate=${finalized.bitrate || 0}`,
      );

      const downloaded = await downloadVideoResult(
        finalized,
        `${profileId}-${activeConversationId}`,
        { outputDir },
      );

      downloadedUrls.add(selected.url);
      downloadedUrls.add(downloaded.url);
      log(
        `downloaded ${downloaded.localPath} (${downloaded.fileSize || 0} bytes, noWatermark=${downloaded.noWatermark})`,
      );
      await persistDownloadStatus(downloaded);

      await closeProfileBrowser();
      break;
    } catch (error) {
      consecutiveCdpFailures += 1;
      if (consecutiveCdpFailures >= 5) {
        throw error;
      }
      log(
        `watch warning: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await delay(pollMs);
  }
} catch (error) {
  log(`stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  cdp.close();
}
