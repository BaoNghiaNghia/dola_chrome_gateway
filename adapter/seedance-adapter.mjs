import { CdpClient, delay } from "./cdp.mjs";
import { GatewayClient } from "./gateway.mjs";
import { AdapterError, SeedanceDriver } from "./seedance-driver.mjs";
import { downloadVideoResult } from "./video-result.mjs";

const baseUrl = process.env.DOLA_GATEWAY_URL || "http://127.0.0.1:8787";
const apiKey = process.env.DOLA_GATEWAY_KEY || "";
const concurrency = Math.max(
  1,
  Math.min(4, Number(process.env.DOLA_ADAPTER_CONCURRENCY || 1)),
);
const idleMs = Math.max(500, Number(process.env.DOLA_ADAPTER_IDLE_MS || 2_000));
const leaseSeconds = Math.max(
  30,
  Math.min(900, Number(process.env.DOLA_ADAPTER_LEASE_SECONDS || 120)),
);
const heartbeatMs = Math.max(
  5_000,
  Math.min(
    leaseSeconds * 500,
    Number(process.env.DOLA_ADAPTER_HEARTBEAT_MS || 30_000),
  ),
);
const timeoutSeconds = Math.max(
  120,
  Number(process.env.DOLA_ADAPTER_TIMEOUT_SECONDS || 1_200),
);
const manualVerificationSeconds = Math.max(
  30,
  Number(process.env.DOLA_ADAPTER_MANUAL_VERIFICATION_SECONDS || 180),
);

if (!apiKey) {
  console.error(
    "DOLA_GATEWAY_KEY is required. Reveal the Local API key in the Queue tab and set it in the environment before starting the adapter.",
  );
  process.exit(2);
}

const gateway = new GatewayClient(baseUrl, apiKey);
let shuttingDown = false;

process.on("SIGINT", () => {
  shuttingDown = true;
  console.log("\n[adapter] SIGINT received; no new jobs will be claimed.");
});
process.on("SIGTERM", () => {
  shuttingDown = true;
  console.log("\n[adapter] SIGTERM received; no new jobs will be claimed.");
});

function log(workerId, message) {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] [${workerId}] ${message}`);
}

function profilePatchForFailure(failure) {
  const now = Date.now();

  switch (failure.failureCode) {
    case "needs_login":
      return {
        sessionStatus: "needs_login",
        loginCheckedAt: new Date(now).toISOString(),
      };
    case "daily_limit":
      return {
        quotaBlockedUntil: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        remaining: 0,
      };
    case "insufficient_credit":
      return {
        schedulingEnabled: false,
        remaining: 0,
      };
    case "verification_required":
      return {
        cooldownUntil: new Date(now + 5 * 60 * 1000).toISOString(),
      };
    case "generation_timeout":
    case "conversation_id_timeout":
    case "adapter_error":
      return {
        cooldownUntil: new Date(now + 60 * 1000).toISOString(),
      };
    default:
      return null;
  }
}

function normalizedFailure(error) {
  if (error instanceof AdapterError) {
    return {
      failureCode: error.code,
      errorMessage: error.message,
      retryable: Boolean(error.retryable),
      retryAfterSeconds: Number(error.retryAfterSeconds || 30),
    };
  }

  return {
    failureCode: "adapter_error",
    errorMessage: error instanceof Error ? error.message : String(error),
    retryable: true,
    retryAfterSeconds: 60,
  };
}

async function executeClaim(workerId, claim) {
  const job = claim.job;
  const leaseToken = claim.leaseToken;
  let browserOpened = false;
  let cdp = null;
  let heartbeatTimer = null;

  const heartbeat = async () => {
    try {
      await gateway.heartbeat(job.id, leaseToken, leaseSeconds);
    } catch (error) {
      log(workerId, `heartbeat failed for ${job.id}: ${error.message}`);
    }
  };

  heartbeatTimer = setInterval(heartbeat, heartbeatMs);
  heartbeatTimer.unref?.();

  try {
    log(
      workerId,
      `claimed job ${job.id} for profile ${claim.profile?.name || job.profileId}`,
    );

    const resumeConversationId = job.externalTaskId || null;
    const startUrl = resumeConversationId
      ? `https://www.dola.com/chat/${resumeConversationId}`
      : "https://www.dola.com/chat";

    const browser = await gateway.openBrowser(job.id, leaseToken, startUrl);
    browserOpened = true;

    cdp = new CdpClient(browser.browserWebsocketUrl);
    await cdp.connect();
    const { sessionId } = await cdp.attachToPage("https://www.dola.com");

    const driver = new SeedanceDriver(cdp, sessionId, {
      timeoutSeconds,
      manualVerificationSeconds,
      log: (message) => log(workerId, message),
      onProgress: async (progressPercent, externalTaskId) => {
        await gateway.progress(
          job.id,
          leaseToken,
          progressPercent,
          externalTaskId || resumeConversationId,
        );
      },
    });

    let conversationId = resumeConversationId;
    if (!conversationId) {
      conversationId = await driver.submit(job);
      const deadlineSeconds =
        Number(job.durationSeconds) === 30
          ? Math.max(timeoutSeconds, 1_800)
          : timeoutSeconds;
      const deadlineAt = new Date(
        Date.now() + deadlineSeconds * 1000,
      ).toISOString();

      await gateway.start(job.id, leaseToken, conversationId, deadlineAt);
      await gateway
        .profileState(job.id, leaseToken, {
          sessionStatus: "healthy",
          loginCheckedAt: new Date().toISOString(),
        })
        .catch((stateError) => {
          log(workerId, `profile health update warning: ${stateError.message}`);
        });
      log(workerId, `job ${job.id} submitted; conversation ${conversationId}`);
    } else {
      await driver.ensureLoggedIn();
      await gateway.start(job.id, leaseToken, conversationId, job.deadlineAt);
      await gateway
        .profileState(job.id, leaseToken, {
          sessionStatus: "healthy",
          loginCheckedAt: new Date().toISOString(),
        })
        .catch((stateError) => {
          log(workerId, `profile health update warning: ${stateError.message}`);
        });
      log(workerId, `resuming job ${job.id}; conversation ${conversationId}`);
    }

    const jobTimeoutMs =
      Number(job.durationSeconds) === 30
        ? Math.max(timeoutSeconds, 1_800) * 1000
        : timeoutSeconds * 1000;
    const selectedResult = await driver.pollResult(conversationId, jobTimeoutMs);
    log(
      workerId,
      `video ready: source=${selectedResult.sourceKind} noWatermark=${selectedResult.noWatermark} resolution=${selectedResult.width || "?"}x${selectedResult.height || "?"} bitrate=${selectedResult.bitrate || 0}`,
    );

    await gateway.progress(job.id, leaseToken, 97, conversationId);

    let downloadedResult;
    try {
      downloadedResult = await downloadVideoResult(selectedResult, job.id);
    } catch (downloadError) {
      throw new AdapterError(
        "download_failed",
        `Video generated but local download failed: ${
          downloadError instanceof Error ? downloadError.message : String(downloadError)
        }`,
        { retryable: true, retryAfterSeconds: 60 },
      );
    }

    if (downloadedResult.fallbackUsed) {
      downloadedResult = await driver.finalizeVideoCandidate(downloadedResult);
      log(
        workerId,
        `original stream download failed; used download_url fallback: ${downloadedResult.primaryDownloadError || "unknown original-stream error"}`,
      );
    }

    await gateway.progress(job.id, leaseToken, 99, conversationId);

    if (browserOpened) {
      await gateway.closeBrowser(job.id, leaseToken).catch((error) => {
        log(workerId, `browser close warning: ${error.message}`);
      });
      browserOpened = false;
    }

    await gateway.complete(job.id, leaseToken, downloadedResult);
    log(
      workerId,
      `completed job ${job.id}: ${downloadedResult.localPath} (${downloadedResult.fileSize || 0} bytes, ${downloadedResult.width || "?"}x${downloadedResult.height || "?"}, noWatermark=${downloadedResult.noWatermark})`,
    );
  } catch (error) {
    const failure = normalizedFailure(error);
    log(
      workerId,
      `job ${job.id} failed [${failure.failureCode}]: ${failure.errorMessage}`,
    );

    const profilePatch = profilePatchForFailure(failure);
    if (profilePatch) {
      await gateway.profileState(job.id, leaseToken, profilePatch).catch((stateError) => {
        log(workerId, `profile health update warning: ${stateError.message}`);
      });
    }

    if (browserOpened) {
      await gateway.closeBrowser(job.id, leaseToken).catch((closeError) => {
        log(workerId, `browser close warning: ${closeError.message}`);
      });
      browserOpened = false;
    }

    await gateway.fail(job.id, leaseToken, failure).catch((reportError) => {
      log(workerId, `failed to report job failure: ${reportError.message}`);
    });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    cdp?.close();
  }
}

async function workerLoop(index) {
  const workerId = `seedance-adapter-${process.pid}-${index + 1}`;
  log(workerId, `started; gateway=${baseUrl}`);

  while (!shuttingDown) {
    try {
      const claim = await gateway.claim(workerId, leaseSeconds);
      if (!claim) {
        await delay(idleMs);
        continue;
      }
      await executeClaim(workerId, claim);
    } catch (error) {
      log(workerId, `claim loop error: ${error.message}`);
      await delay(Math.max(idleMs, 3_000));
    }
  }

  log(workerId, "stopped.");
}

console.log(
  `[adapter] Seedance adapter starting with concurrency=${concurrency}, lease=${leaseSeconds}s, verification-window=${manualVerificationSeconds}s`,
);

await Promise.all(
  Array.from({ length: concurrency }, (_, index) => workerLoop(index)),
);
