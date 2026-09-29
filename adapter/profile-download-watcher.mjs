import { spawnSync } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { CdpClient, delay } from "./cdp.mjs";
import {
  createSessionDestinationRouter,
  resolveDroppedFilePath,
} from "./source-path-resolver.mjs";
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
const destinationRouter = createSessionDestinationRouter(outputDir);

function log(message) {
  console.log(
    `[${new Date().toISOString()}] [profile-watcher:${profileId}] ${message}`,
  );
}

const DROP_STATE_KEY = "__dolaGatewayDropStateV1";
const DROP_HANDLER_KEY = "__dolaGatewayDropHandlerV1";
const DROP_STORAGE_KEY = "__dolaGatewayFirstDropV1";
const DROP_OBSERVER_SOURCE = `(() => {
  const stateKey = ${JSON.stringify(DROP_STATE_KEY)};
  const handlerKey = ${JSON.stringify(DROP_HANDLER_KEY)};
  const storageKey = ${JSON.stringify(DROP_STORAGE_KEY)};
  const readStored = () => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  if (!globalThis[stateKey]) {
    globalThis[stateKey] = { first: readStored() };
  } else if (!globalThis[stateKey].first) {
    globalThis[stateKey].first = readStored();
  }
  if (globalThis[handlerKey]) {
    return true;
  }
  const handler = (event) => {
    try {
      const state = globalThis[stateKey] || (globalThis[stateKey] = { first: readStored() });
      if (state.first) return;
      const file = event?.dataTransfer?.files?.[0];
      if (!file) return;
      const first = {
        name: String(file.name || ""),
        size: Number(file.size || 0),
        lastModified: Number(file.lastModified || 0),
        type: String(file.type || ""),
        capturedAt: Date.now(),
      };
      state.first = first;
      try { sessionStorage.setItem(storageKey, JSON.stringify(first)); } catch {}
    } catch {}
  };
  globalThis[handlerKey] = handler;
  globalThis.addEventListener("drop", handler, true);
  return true;
})()`;

async function installDropObserver(cdp, sessionId, driver) {
  await cdp.send(
    "Page.addScriptToEvaluateOnNewDocument",
    { source: DROP_OBSERVER_SOURCE },
    sessionId,
  );

  await driver.evaluate(
    `(() => {
      const handlerKey = ${JSON.stringify(DROP_HANDLER_KEY)};
      const storageKey = ${JSON.stringify(DROP_STORAGE_KEY)};
      if (globalThis[handlerKey]) {
        try { globalThis.removeEventListener("drop", globalThis[handlerKey], true); } catch {}
      }
      globalThis[${JSON.stringify(DROP_HANDLER_KEY)}] = null;
      globalThis[${JSON.stringify(DROP_STATE_KEY)}] = { first: null };
      try { sessionStorage.removeItem(storageKey); } catch {}
    })()`,
  );
  await driver.evaluate(DROP_OBSERVER_SOURCE);
}

async function readFirstDroppedFile(driver) {
  return driver.evaluate(
    `(() => {
      const current = globalThis[${JSON.stringify(DROP_STATE_KEY)}]?.first;
      if (current) return current;
      try {
        const raw = sessionStorage.getItem(${JSON.stringify(DROP_STORAGE_KEY)});
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    })()`,
  );
}

async function lockSessionDestinationFromFirstDrop(driver) {
  if (destinationRouter.locked) return;

  const dropped = await readFirstDroppedFile(driver).catch(() => null);
  if (!dropped?.name) return;

  const resolved = await resolveDroppedFilePath(dropped);
  if (!resolved.path) {
    destinationRouter.lock(null);
    log(
      `first drop detected (${dropped.name}), but source path was not uniquely resolved; session locked to fallback Downloads folder`,
    );
    return;
  }

  const candidateDir = path.win32.dirname(resolved.path);
  try {
    await fs.access(candidateDir, fsConstants.W_OK);
  } catch {
    destinationRouter.lock(null);
    log(
      `resolved first source ${resolved.path}, but its folder is not writable; session locked to fallback Downloads folder`,
    );
    return;
  }

  destinationRouter.lock(resolved.path);
  log(
    `first source locked for this profile session: ${destinationRouter.primarySourcePath}; output folder=${destinationRouter.outputDir}`,
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

  await installDropObserver(cdp, sessionId, driver);
  log(
    "started; new profile session initialized, waiting for the first dropped file and completed original video streams",
  );

  while (true) {
    try {
      await lockSessionDestinationFromFirstDrop(driver);

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

      // Check once more immediately before download so a first drop that
      // happened during generation still controls the destination.
      await lockSessionDestinationFromFirstDrop(driver);

      const finalized = await driver.finalizeVideoCandidate(selected);
      log(
        `video ready; downloading highest-quality clean stream ${finalized.width || "?"}x${finalized.height || "?"} bitrate=${finalized.bitrate || 0} to ${destinationRouter.outputDir || outputDir}`,
      );

      const downloaded = await downloadVideoResult(
        finalized,
        `${profileId}-${activeConversationId}`,
        { outputDir: destinationRouter.outputDir || outputDir },
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
