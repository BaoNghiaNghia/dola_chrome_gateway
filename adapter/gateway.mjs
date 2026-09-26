export class GatewayClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }

    if (!response.ok) {
      const message =
        body?.error?.message || body?.message || body?.raw || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return body;
  }

  claim(workerId, leaseSeconds = 120) {
    return this.request("/v1/adapter/claim", {
      method: "POST",
      body: JSON.stringify({ workerId, leaseSeconds }),
    }).then((body) => body?.claim || null);
  }

  heartbeat(jobId, leaseToken, leaseSeconds = 120) {
    return this.request(`/v1/adapter/jobs/${jobId}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ leaseToken, leaseSeconds }),
    });
  }

  start(jobId, leaseToken, externalTaskId = null, deadlineAt = null) {
    return this.request(`/v1/adapter/jobs/${jobId}/start`, {
      method: "POST",
      body: JSON.stringify({ leaseToken, externalTaskId, deadlineAt }),
    });
  }

  progress(jobId, leaseToken, progressPercent, externalTaskId = null) {
    return this.request(`/v1/adapter/jobs/${jobId}/progress`, {
      method: "POST",
      body: JSON.stringify({ leaseToken, progressPercent, externalTaskId }),
    });
  }

  complete(jobId, leaseToken, result) {
    return this.request(`/v1/adapter/jobs/${jobId}/complete`, {
      method: "POST",
      body: JSON.stringify({
        leaseToken,
        resultUrl: result.url,
        localPath: result.localPath ?? null,
        width: result.width ?? null,
        height: result.height ?? null,
        bitrate: result.bitrate ?? null,
        fileSize: result.fileSize ?? null,
        noWatermark: result.noWatermark ?? null,
        sourceKind: result.sourceKind ?? null,
      }),
    });
  }

  fail(
    jobId,
    leaseToken,
    {
      failureCode,
      errorMessage,
      retryable = false,
      retryAfterSeconds = 30,
    },
  ) {
    return this.request(`/v1/adapter/jobs/${jobId}/fail`, {
      method: "POST",
      body: JSON.stringify({
        leaseToken,
        failureCode,
        errorMessage,
        retryable,
        retryAfterSeconds,
      }),
    });
  }

  profileState(jobId, leaseToken, patch = {}) {
    return this.request(`/v1/adapter/jobs/${jobId}/profile-state`, {
      method: "POST",
      body: JSON.stringify({
        leaseToken,
        schedulingEnabled: patch.schedulingEnabled ?? null,
        sessionStatus: patch.sessionStatus ?? null,
        loginCheckedAt: patch.loginCheckedAt ?? null,
        cooldownUntil: patch.cooldownUntil ?? null,
        rateLimitedUntil: patch.rateLimitedUntil ?? null,
        quotaBlockedUntil: patch.quotaBlockedUntil ?? null,
        creditBalance: patch.creditBalance ?? null,
        usedToday: patch.usedToday ?? null,
        remaining: patch.remaining ?? null,
      }),
    });
  }

  openBrowser(jobId, leaseToken, startUrl = "https://www.dola.com/chat") {
    return this.request(`/v1/adapter/jobs/${jobId}/browser/open`, {
      method: "POST",
      body: JSON.stringify({ leaseToken, startUrl }),
    });
  }

  closeBrowser(jobId, leaseToken) {
    return this.request(`/v1/adapter/jobs/${jobId}/browser/close`, {
      method: "POST",
      body: JSON.stringify({ leaseToken }),
    });
  }
}
