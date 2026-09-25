import { delay } from "./cdp.mjs";

export class AdapterError extends Error {
  constructor(code, message, { retryable = false, retryAfterSeconds = 30 } = {}) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function normalizeModel(model) {
  const value = String(model || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/^seedance-v/, "seedance-");

  if (["seedance-2.5", "seedance-25", "seedance-v2.5"].includes(value)) {
    return "seedance-2.5";
  }
  if (["seedance-2.0", "seedance-20", "seedance-v2.0"].includes(value)) {
    return "seedance-2.0";
  }
  throw new AdapterError(
    "unsupported_model",
    `Unsupported Seedance model: ${model}. Supported: seedance-2.5, seedance-2.0.`,
  );
}

export function validateDuration(duration) {
  const value = Number(duration);
  if (![10, 15, 30].includes(value)) {
    throw new AdapterError(
      "unsupported_duration",
      `Unsupported Seedance duration: ${duration}s. Supported: 10s, 15s, 30s.`,
    );
  }
  return value;
}

export function extractConversationId(url) {
  const match = String(url || "").match(/\/chat\/(\d+)(?:[/?#]|$)/);
  return match?.[1] || null;
}

export function classifyPageText(text) {
  const source = String(text || "");
  if (
    /daily.*(?:limit|quota)|(?:limit|quota).*per\s*day|每日(?:视频|影片)?生成.*(?:上限|限额|额度)|動画生成の\s*1日あたりの上限/i.test(
      source,
    )
  ) {
    return {
      code: "daily_limit",
      message: "The profile appears to have reached its daily generation limit.",
      retryable: false,
    };
  }

  if (
    /insufficient\s+(?:credit|credits|points|quota)|not\s+enough\s+(?:credit|credits|points)|积分不足|ポイント.*不足/i.test(
      source,
    )
  ) {
    return {
      code: "insufficient_credit",
      message: "The profile appears to have insufficient Seedance credits.",
      retryable: false,
    };
  }

  return null;
}

function domHelpersSource(body) {
  return `(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const text = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    ${body}
  })()`;
}

export class SeedanceDriver {
  constructor(cdp, sessionId, options = {}) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.manualVerificationMs =
      Number(options.manualVerificationSeconds || 180) * 1000;
    this.defaultTimeoutMs = Number(options.timeoutSeconds || 1200) * 1000;
    this.onProgress = options.onProgress || (async () => {});
    this.log = options.log || console.log;
  }

  evaluate(expression, options = {}) {
    return this.cdp.evaluate(this.sessionId, expression, options);
  }

  async navigate(url) {
    await this.cdp.navigate(this.sessionId, url);
    await delay(1_500);
  }

  async snapshot() {
    return this.evaluate(
      domHelpersSource(`
        const composer = [...document.querySelectorAll('textarea,[contenteditable="true"],input[type="text"]')]
          .find(visible);
        const captchaFrame = [...document.querySelectorAll('iframe')].find((frame) => {
          const src = (frame.getAttribute('src') || '').toLowerCase();
          return src.includes('captcha') || src.includes('verifycenter') || src.includes('bdcaptcha');
        });
        const urls = [];
        const pushUrl = (value) => {
          if (typeof value !== 'string') return;
          if (!/^https?:\\/\\//i.test(value)) return;
          if (!urls.includes(value)) urls.push(value);
        };
        document.querySelectorAll('video[src],source[src]').forEach((el) => pushUrl(el.src));
        document.querySelectorAll('a[href]').forEach((el) => {
          const href = el.href || '';
          if (/\\.(mp4|webm)(?:[?#]|$)/i.test(href) || el.hasAttribute('download')) pushUrl(href);
        });
        try {
          performance.getEntriesByType('resource').forEach((entry) => {
            if (/\\.(mp4|webm|m3u8)(?:[?#]|$)/i.test(entry.name)) pushUrl(entry.name);
          });
        } catch {}
        return {
          url: location.href,
          title: document.title,
          composerReady: !!composer,
          captchaPresent: !!captchaFrame,
          bodyText: (document.body?.innerText || '').slice(0, 30000),
          resultUrls: urls.slice(0, 20),
        };
      `),
    );
  }

  async ensureLoggedIn() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = await this.snapshot();
      if (state?.composerReady) return state;
      if (/\/(login|signin|passport)(?:[/?#]|$)/i.test(state?.url || "")) {
        throw new AdapterError(
          "needs_login",
          "This profile is not logged in to Dola. Open the profile and complete login first.",
        );
      }
      await delay(750);
    }

    throw new AdapterError(
      "needs_login",
      "Dola chat composer was not detected. The saved session may need login or manual review.",
    );
  }

  async clickText(texts, { exact = true } = {}) {
    const values = Array.isArray(texts) ? texts : [texts];
    return this.evaluate(
      domHelpersSource(`
        const wanted = ${JSON.stringify(values)}.map((value) => String(value).trim());
        const nodes = [...document.querySelectorAll(
          'button,[role="button"],[role="menuitem"],[role="option"],a,label,div,span'
        )].filter(visible);
        for (const expected of wanted) {
          const found = nodes.find((el) => {
            const current = text(el);
            return ${exact ? "current === expected" : "current.includes(expected)"};
          });
          if (found) {
            found.click();
            return { clicked: true, text: text(found) };
          }
        }
        return { clicked: false };
      `),
    );
  }

  async clickTextRegex(patternSource, flags = "i") {
    return this.evaluate(
      domHelpersSource(`
        const pattern = new RegExp(${JSON.stringify(patternSource)}, ${JSON.stringify(flags)});
        const nodes = [...document.querySelectorAll(
          'button,[role="button"],[role="menuitem"],[role="option"],a,label,div,span'
        )].filter(visible);
        const found = nodes.find((el) => pattern.test(text(el)));
        if (!found) return { clicked: false };
        found.click();
        return { clicked: true, text: text(found) };
      `),
    );
  }

  async openVideoComposer() {
    const result = await this.clickText([
      "動画を作成",
      "Create video",
      "生成视频",
      "创建视频",
    ]);
    if (!result?.clicked) {
      throw new AdapterError(
        "video_button_not_found",
        "Could not find the Dola video generation entry point.",
        { retryable: true, retryAfterSeconds: 60 },
      );
    }
    await delay(1_000);
  }

  async selectModel(model) {
    const normalized = normalizeModel(model);
    let opened = await this.clickText([
      "モデル 2.0高速",
      "モデル 2.5",
      "Model 2.0",
      "Model 2.5",
    ]);

    if (!opened?.clicked) {
      opened = await this.clickTextRegex("^(モデル|Model)\\s");
    }
    if (!opened?.clicked) {
      throw new AdapterError(
        "model_menu_not_found",
        "Could not open the Seedance model menu.",
        { retryable: true, retryAfterSeconds: 60 },
      );
    }

    await delay(400);
    const target =
      normalized === "seedance-2.5"
        ? ["Dreamina Seedance 2.5", "Seedance 2.5"]
        : [
            "Dreamina Seedance 2.0高速",
            "Dreamina Seedance 2.0",
            "Seedance2.0Fast",
            "Seedance 2.0",
          ];

    const selected = await this.clickText(target, { exact: false });
    if (!selected?.clicked) {
      throw new AdapterError(
        "model_option_not_found",
        `Could not select ${normalized} in Dola.`,
        { retryable: true, retryAfterSeconds: 60 },
      );
    }
    await delay(400);
  }

  async selectRatio(ratio) {
    if (!ratio) return;
    const opened = await this.clickText(["比率", "Ratio", "比例"]);
    if (!opened?.clicked) {
      this.log(`[adapter] Ratio menu not found; keeping Dola default (${ratio} requested).`);
      return;
    }
    await delay(350);
    const selected = await this.clickText(String(ratio));
    if (!selected?.clicked) {
      this.log(`[adapter] Ratio ${ratio} option not found; keeping Dola default.`);
    }
    await delay(250);
  }

  async selectDuration(duration) {
    const value = validateDuration(duration);
    const label = `${value}s`;

    let clicked = await this.clickText(label);
    if (clicked?.clicked) {
      await delay(300);
      const second = await this.clickText(label);
      if (second?.clicked) {
        await delay(250);
        return;
      }
    }

    const opened = await this.clickTextRegex("^\\d+s$");
    if (!opened?.clicked) {
      throw new AdapterError(
        "duration_menu_not_found",
        "Could not open the Seedance duration menu.",
        { retryable: true, retryAfterSeconds: 60 },
      );
    }
    await delay(350);

    const selected = await this.clickText(label);
    if (!selected?.clicked) {
      throw new AdapterError(
        "duration_option_not_found",
        `Could not select Seedance duration ${label}.`,
        { retryable: true, retryAfterSeconds: 60 },
      );
    }
    await delay(250);
  }

  async fillPrompt(prompt) {
    const focused = await this.evaluate(
      domHelpersSource(`
        const candidates = [
          ...document.querySelectorAll('textarea'),
          ...document.querySelectorAll('[contenteditable="true"]'),
          ...document.querySelectorAll('input[type="text"]'),
        ].filter(visible);
        const el = candidates[0];
        if (!el) return false;
        el.focus();
        if ('value' in el) {
          el.value = '';
        } else {
          el.textContent = '';
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        return true;
      `),
    );

    if (!focused) {
      throw new AdapterError(
        "composer_not_found",
        "Could not find the Dola prompt composer.",
        { retryable: true, retryAfterSeconds: 60 },
      );
    }

    await this.cdp.insertText(this.sessionId, prompt);
    await delay(300);
    await this.cdp.pressEnter(this.sessionId);
  }

  async waitForManualVerification() {
    this.log(
      `[adapter] Verification detected. Complete it manually in the opened Chrome window within ${Math.round(
        this.manualVerificationMs / 1000,
      )}s.`,
    );

    const deadline = Date.now() + this.manualVerificationMs;
    while (Date.now() < deadline) {
      await delay(1_000);
      const state = await this.snapshot();
      if (!state?.captchaPresent) {
        this.log("[adapter] Verification cleared; continuing.");
        return;
      }
    }

    throw new AdapterError(
      "verification_required",
      "Manual verification was not completed before the adapter timeout.",
      { retryable: true, retryAfterSeconds: 300 },
    );
  }

  async waitForConversationId(timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.snapshot();
      if (state?.captchaPresent) {
        await this.waitForManualVerification();
        continue;
      }

      const issue = classifyPageText(state?.bodyText);
      if (issue) throw new AdapterError(issue.code, issue.message, issue);

      const id = extractConversationId(state?.url);
      if (id) return id;
      await delay(1_000);
    }

    throw new AdapterError(
      "conversation_id_timeout",
      "Dola did not create a conversation ID after prompt submission.",
      { retryable: true, retryAfterSeconds: 90 },
    );
  }

  async submit(job) {
    normalizeModel(job.model);
    validateDuration(job.durationSeconds);

    await this.navigate("https://www.dola.com/chat");
    await this.ensureLoggedIn();
    await this.openVideoComposer();
    await this.selectModel(job.model);
    await this.selectRatio(job.ratio);
    await this.selectDuration(job.durationSeconds);
    await this.fillPrompt(job.prompt);

    return this.waitForConversationId();
  }

  async pollConversationApi(conversationId) {
    return this.evaluate(
      `(async () => {
        try {
          const params = new URLSearchParams({
            version_code: "20800",
            language: "ja",
            device_platform: "web",
            doubao_device_platform: "web",
            aid: "495671",
            real_aid: "495671",
            pkg_type: "release_version",
            region: "JP",
            sys_region: "JP",
            samantha_web: "1",
            web_platform: "browser",
            "use-olympus-account": "1",
            web_tab_id: crypto.randomUUID(),
          });

          const response = await fetch("/im/chain/single?" + params.toString(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json; encoding=utf-8",
              "agw-js-conv": "str",
              Accept: "*/*",
            },
            credentials: "include",
            body: JSON.stringify({
              cmd: 3100,
              uplink_body: {
                pull_singe_chain_uplink_body: {
                  conversation_id: ${JSON.stringify(String(conversationId))},
                  anchor_index: Number.MAX_SAFE_INTEGER,
                  conversation_type: 3,
                  direction: 1,
                  limit: 20,
                  ext: {},
                  filter: { index_list: [] },
                  evaluate_ab_params: "",
                  evaluate_common_params: "",
                },
              },
              sequence_id: crypto.randomUUID(),
              channel: 2,
              version: "1",
            }),
          });

          if (!response.ok) {
            return { ok: false, status: response.status, texts: [], videos: [] };
          }

          const data = await response.json();
          const messages =
            data?.downlink_body?.pull_singe_chain_downlink_body?.messages || [];
          const texts = [];
          const videos = [];

          for (const message of messages) {
            let content = message?.content;
            if (typeof content === "string") {
              try {
                content = JSON.parse(content);
              } catch {
                continue;
              }
            }
            if (!Array.isArray(content)) continue;

            for (const block of content) {
              const messageText = block?.content?.text_block?.text;
              if (messageText) texts.push(String(messageText).slice(0, 500));

              if (block?.block_type !== 2074) continue;
              const creations = block?.content?.creation_block?.creations || [];
              for (const creation of creations) {
                if (creation?.type !== 2) continue;
                const url = creation?.video?.download_url;
                if (typeof url === "string" && /^https?:\\/\\//i.test(url)) {
                  videos.push(url);
                }
              }
            }
          }

          return { ok: true, status: response.status, texts, videos };
        } catch (error) {
          return {
            ok: false,
            status: 0,
            texts: [],
            videos: [],
            error: String(error?.message || error),
          };
        }
      })()`,
      { timeoutMs: 30_000 },
    );
  }

  async pollResult(conversationId, timeoutMs = undefined) {
    const effectiveTimeout =
      timeoutMs || Math.max(this.defaultTimeoutMs, 30 * 60_000);
    const expectedUrl = `https://www.dola.com/chat/${conversationId}`;

    const current = await this.snapshot();
    if (!String(current?.url || "").includes(`/chat/${conversationId}`)) {
      await this.navigate(expectedUrl);
    }

    const startedAt = Date.now();
    let lastReported = 0;

    while (Date.now() - startedAt < effectiveTimeout) {
      const poll = await this.pollConversationApi(conversationId).catch(() => null);

      if (poll?.status === 401 || poll?.status === 403) {
        throw new AdapterError(
          "needs_login",
          "Dola rejected the conversation poll for this profile. The saved session may need login.",
        );
      }

      if (poll?.ok) {
        const pollIssue = classifyPageText((poll.texts || []).join("\n"));
        if (pollIssue) {
          throw new AdapterError(
            pollIssue.code,
            pollIssue.message,
            pollIssue,
          );
        }

        const apiResultUrl = (poll.videos || []).find((url) =>
          /^https?:\/\//i.test(url),
        );
        if (apiResultUrl) return apiResultUrl;
      }

      const state = await this.snapshot();

      if (state?.captchaPresent) {
        await this.waitForManualVerification();
        continue;
      }

      const issue = classifyPageText(state?.bodyText);
      if (issue) throw new AdapterError(issue.code, issue.message, issue);

      const domResultUrl = (state?.resultUrls || []).find((url) =>
        /^https?:\/\//i.test(url),
      );
      if (domResultUrl) return domResultUrl;

      const elapsed = Date.now() - startedAt;
      const progress = Math.min(
        95,
        Math.max(8, Math.floor(8 + (elapsed / effectiveTimeout) * 84)),
      );
      if (progress >= lastReported + 3) {
        lastReported = progress;
        await this.onProgress(progress, conversationId);
      }

      await delay(5_000);
    }

    throw new AdapterError(
      "generation_timeout",
      `Seedance generation did not expose a result within ${Math.round(
        effectiveTimeout / 1000,
      )}s.`,
      { retryable: true, retryAfterSeconds: 120 },
    );
  }
}
