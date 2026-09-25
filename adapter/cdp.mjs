export class CdpClient {
  constructor(websocketUrl) {
    this.websocketUrl = websocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect(timeoutMs = 10_000) {
    if (this.socket?.readyState === WebSocket.OPEN) return;

    const socket = new WebSocket(this.websocketUrl);
    this.socket = socket;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`CDP websocket connection timed out after ${timeoutMs}ms`));
        try {
          socket.close();
        } catch {
          // Ignore close failures after timeout.
        }
      }, timeoutMs);

      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP websocket connection failed."));
        },
        { once: true },
      );
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(
          new Error(
            `CDP ${pending.method} failed: ${message.error.message || "unknown error"}`,
          ),
        );
      } else {
        pending.resolve(message.result || {});
      }
    });

    socket.addEventListener("close", () => {
      const error = new Error("CDP websocket closed.");
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 15_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP websocket is not connected."));
    }

    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify(message));
    });
  }

  async attachToPage(preferredUrlPrefix = "https://www.dola.com") {
    const targets = await this.send("Target.getTargets");
    let target = (targets.targetInfos || []).find(
      (item) =>
        item.type === "page" &&
        typeof item.url === "string" &&
        item.url.startsWith(preferredUrlPrefix),
    );

    if (!target) {
      target = (targets.targetInfos || []).find(
        (item) =>
          item.type === "page" &&
          !String(item.url || "").startsWith("chrome-extension://"),
      );
    }

    let targetId = target?.targetId;
    if (!targetId) {
      const created = await this.send("Target.createTarget", { url: "about:blank" });
      targetId = created.targetId;
    }

    const attached = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    if (!sessionId) throw new Error("CDP did not return a page session.");

    await Promise.all([
      this.send("Page.enable", {}, sessionId),
      this.send("Runtime.enable", {}, sessionId),
    ]);
    return { targetId, sessionId };
  }

  async evaluate(sessionId, expression, options = {}) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: options.awaitPromise ?? true,
        returnByValue: options.returnByValue ?? true,
        userGesture: options.userGesture ?? true,
      },
      sessionId,
      options.timeoutMs ?? 15_000,
    );

    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Runtime.evaluate failed";
      throw new Error(text);
    }

    return result.result?.value;
  }

  async navigate(sessionId, url) {
    await this.send("Page.navigate", { url }, sessionId, 30_000);
    await this.waitFor(
      sessionId,
      "() => document.readyState === 'complete' || document.readyState === 'interactive'",
      60_000,
      250,
    );
  }

  async waitFor(sessionId, predicateSource, timeoutMs, intervalMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.evaluate(
        sessionId,
        `(${predicateSource})()`,
      ).catch(() => false);
      if (value) return value;
      await delay(intervalMs);
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for browser condition.`);
  }

  async insertText(sessionId, text) {
    await this.send("Input.insertText", { text }, sessionId);
  }

  async pressEnter(sessionId) {
    await this.send(
      "Input.dispatchKeyEvent",
      { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
      sessionId,
    );
    await this.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
      sessionId,
    );
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      // Best-effort close.
    }
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
