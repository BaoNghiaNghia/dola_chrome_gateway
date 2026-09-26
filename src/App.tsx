import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  cancelGenerationJob,
  clearProfileOperationalBlocks,
  closeProfile,
  createGenerationJob,
  createProfile,
  createProxyPoolItem,
  createWorkspace,
  deleteProfile,
  deleteProxyPoolItem,
  deleteWorkspace,
  getAutomationRuntimeLog,
  getAutomationRuntimeState,
  getLocalApiState,
  getProxyPoolState,
  getSchedulerState,
  getSystemInfo,
  getWorkerState,
  listGenerationJobs,
  listProfiles,
  listWorkspaces,
  openProfiles,
  openSmartProfiles,
  revealGenerationResult,
  revealLocalApiKey,
  rotateLocalApiKey,
  rotateProxyPoolItem,
  runWorkerTick,
  setAutomationRuntimeEnabled,
  setLocalApiEnabled,
  setLocalApiPort,
  setProxyPoolEnabled,
  setSchedulerEnabled,
  setWorkerEnabled,
  testProxyPoolItem,
  updateAutomationRuntimeConfig,
  updateProfileOperationalState,
  updateProxyPoolItem,
} from "./api";
import type {
  AutomationRuntimeState,
  BrowserProfile,
  CreateGenerationJobInput,
  CreateProfileInput,
  GenerationJob,
  LocalApiState,
  ProxyPoolItem,
  ProxyPoolItemInput,
  ProxyPoolState,
  SchedulerState,
  SystemInfo,
  WorkerState,
  Workspace,
} from "./types";
import seedanceLogo from "./assets/seedance-logo.svg";
import profilesIcon from "./assets/profiles-icon.svg";
import proxiesIcon from "./assets/proxies-icon.svg";
import "./App.css";

const MAX_SELECTED = 4;

type View = "profiles" | "proxies" | "queue";
type QueueFilter = "all" | "active" | "queued" | "completed" | "failed";
type QueueSort = "newest" | "oldest" | "active";
type ProfileDensity = "comfortable" | "compact";

const UI_PREFS_KEY = "dola-gateway-ui-v1";

type UiPreferences = {
  view: View;
  queueFilter: QueueFilter;
  queueSort: QueueSort;
  profileDensity: ProfileDensity;
  workspacesOpen: boolean;
  advancedRuntimeOpen: boolean;
};

const DEFAULT_UI_PREFS: UiPreferences = {
  view: "profiles",
  queueFilter: "all",
  queueSort: "newest",
  profileDensity: "comfortable",
  workspacesOpen: false,
  advancedRuntimeOpen: false,
};

function loadUiPreferences(): UiPreferences {
  try {
    const raw = window.localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return DEFAULT_UI_PREFS;
    return { ...DEFAULT_UI_PREFS, ...JSON.parse(raw) } as UiPreferences;
  } catch {
    return DEFAULT_UI_PREFS;
  }
}

const DEFAULT_PROXY_ITEM: ProxyPoolItemInput = {
  name: "",
  enabled: true,
  protocol: "http",
  host: "",
  port: 0,
  authUsername: null,
  rotationUrl: null,
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}

function relativeTime(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.floor(diff / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function errorMessage(error: unknown) {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "Something went wrong.";
}

type ProfileFormProps = {
  onClose: () => void;
  onSaved: (profile: BrowserProfile) => void;
};

function ProfileForm({ onClose, onSaved }: ProfileFormProps) {
  const [form, setForm] = useState<CreateProfileInput>({
    name: "",
    email: "",
    groupName: "",
    services: [],
    tags: [],
    notes: "",
  });
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) return;

    setSaving(true);
    setError("");
    try {
      const profile = await createProfile({
        ...form,
        name: form.name.trim(),
        email: form.email?.trim() || null,
        groupName: form.groupName?.trim() || null,
        notes: form.notes?.trim() || null,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      onSaved(profile);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal-card"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">NEW PROFILE</span>
            <h2>Create Chrome profile</h2>
            <p>
              Login session data stays isolated in this profile. Proxy routing is
              managed centrally from the Proxies tab.
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>

        <label>
          Profile name
          <input
            autoFocus
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Store US 01"
          />
        </label>

        <div className="form-grid">
          <label>
            Email / account label
            <input
              value={form.email ?? ""}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="account@example.com"
            />
          </label>
          <label>
            Group
            <input
              value={form.groupName ?? ""}
              onChange={(event) => setForm({ ...form, groupName: event.target.value })}
              placeholder="US Store"
            />
          </label>
        </div>

        <label>
          Tags
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="marketing, store, priority"
          />
        </label>

        <label>
          Notes
          <textarea
            value={form.notes ?? ""}
            onChange={(event) => setForm({ ...form, notes: event.target.value })}
            placeholder="Optional notes about this account"
            rows={3}
          />
        </label>

        {error && <div className="inline-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={saving || !form.name.trim()}>
            {saving ? "Creating…" : "Create profile"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ProxyForm({
  initial,
  onClose,
  onSaved,
}: {
  initial?: ProxyPoolItem;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<ProxyPoolItemInput>(
    initial
      ? {
          name: initial.name,
          enabled: initial.enabled,
          protocol: initial.protocol,
          host: initial.host,
          port: initial.port,
          authUsername: initial.authUsername,
          rotationUrl: initial.rotationUrl,
        }
      : { ...DEFAULT_PROXY_ITEM },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.name.trim() || !form.host.trim() || !form.port) return;

    setSaving(true);
    setError("");
    try {
      const request: ProxyPoolItemInput = {
        ...form,
        name: form.name.trim(),
        host: form.host.trim(),
        authUsername: form.authUsername?.trim() || null,
        rotationUrl: form.rotationUrl?.trim() || null,
      };

      if (initial) {
        await updateProxyPoolItem(initial.id, request);
      } else {
        await createProxyPoolItem(request);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal-card proxy-editor"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">PROXY POOL</span>
            <h2>{initial ? "Edit rotating proxy" : "Add rotating proxy"}</h2>
            <p>
              Each enabled slot can be assigned to one running Chrome profile at a
              time.
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>

        <label className="toggle-row proxy-item-toggle">
          <span>
            <strong>Available for allocation</strong>
            <small>Disabled proxies stay in the pool but will not be assigned.</small>
          </span>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
          />
        </label>

        <label>
          Proxy name
          <input
            autoFocus
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="US Rotating 01"
          />
        </label>

        <div className="form-grid proxy-form-grid">
          <label>
            Protocol
            <select
              value={form.protocol}
              onChange={(event) =>
                setForm({
                  ...form,
                  protocol: event.target.value as ProxyPoolItemInput["protocol"],
                })
              }
            >
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </label>

          <label>
            Host
            <input
              value={form.host}
              onChange={(event) => setForm({ ...form, host: event.target.value })}
              placeholder="gateway.proxy.com"
            />
          </label>

          <label>
            Port
            <input
              type="number"
              min={1}
              max={65535}
              value={form.port || ""}
              onChange={(event) =>
                setForm({ ...form, port: Number(event.target.value) || 0 })
              }
              placeholder="8000"
            />
          </label>

          <label>
            Auth username
            <input
              value={form.authUsername ?? ""}
              onChange={(event) =>
                setForm({
                  ...form,
                  authUsername: event.target.value.trim() || null,
                })
              }
              placeholder="Optional"
            />
          </label>
        </div>

        <label>
          Rotation URL
          <input
            value={form.rotationUrl ?? ""}
            onChange={(event) =>
              setForm({
                ...form,
                rotationUrl: event.target.value.trim() || null,
              })
            }
            placeholder="https://provider.example/rotate/..."
          />
          <small className="field-help">
            If present, the system calls this once before assigning this proxy to a
            newly opened profile.
          </small>
        </label>

        {form.authUsername && (
          <div className="proxy-note">
            Proxy password is not stored in SQLite. Upstream authentication may still
            require Chrome/provider-side handling.
          </div>
        )}

        {error && <div className="inline-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={
              saving || !form.name.trim() || !form.host.trim() || !form.port
            }
          >
            {saving ? "Saving…" : initial ? "Save proxy" : "Add proxy"}
          </button>
        </div>
      </form>
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>(() => loadUiPreferences().view);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [proxyPool, setProxyPool] = useState<ProxyPoolState>({
    enabled: false,
    items: [],
  });
  const [scheduler, setScheduler] = useState<SchedulerState>({
    enabled: false,
    readyProfiles: 0,
    blockedProfiles: 0,
  });
  const [generationJobs, setGenerationJobs] = useState<GenerationJob[]>([]);
  const [localApi, setLocalApi] = useState<LocalApiState>({
    enabled: false,
    running: false,
    port: 8787,
    baseUrl: "http://127.0.0.1:8787",
    apiKeyPreview: "dola_••••",
  });
  const [workerState, setWorkerState] = useState<WorkerState>({
    enabled: false,
    running: false,
    mode: "allocation_only",
    maxConcurrentJobs: 4,
    pollIntervalMs: 1000,
    activeAssignments: 0,
    queuedJobs: 0,
    lastTickAt: null,
    lastError: null,
  });
  const [automationRuntime, setAutomationRuntime] = useState<AutomationRuntimeState>({
    running: false,
    pid: null,
    concurrency: 1,
    timeoutSeconds: 1200,
    manualVerificationSeconds: 180,
    nodePath: null,
    scriptPath: null,
    logPath: null,
    startedAt: null,
    lastError: null,
  });
  const [automationDraft, setAutomationDraft] = useState({
    concurrency: 1,
    timeoutSeconds: 1200,
    manualVerificationSeconds: 180,
  });
  const [automationLog, setAutomationLog] = useState("");
  const [showAutomationLog, setShowAutomationLog] = useState(false);
  const [revealedApiKey, setRevealedApiKey] = useState("");
  const [apiPortDraft, setApiPortDraft] = useState("8787");
  const [showJobForm, setShowJobForm] = useState(false);
  const [jobForm, setJobForm] = useState<CreateGenerationJobInput>({
    prompt: "",
    model: "seedance-2.5",
    durationSeconds: 10,
    ratio: "1:1",
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All");
  const [showCreate, setShowCreate] = useState(false);
  const [editingProxy, setEditingProxy] = useState<ProxyPoolItem | null>(null);
  const [showProxyForm, setShowProxyForm] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [queueQuery, setQueueQuery] = useState("");
  const [queueFilter, setQueueFilter] = useState<QueueFilter>(
    () => loadUiPreferences().queueFilter,
  );
  const [queueSort, setQueueSort] = useState<QueueSort>(
    () => loadUiPreferences().queueSort,
  );
  const [profileDensity, setProfileDensity] = useState<ProfileDensity>(
    () => loadUiPreferences().profileDensity,
  );
  const [workspacesOpen, setWorkspacesOpen] = useState(
    () => loadUiPreferences().workspacesOpen,
  );
  const [advancedRuntimeOpen, setAdvancedRuntimeOpen] = useState(
    () => loadUiPreferences().advancedRuntimeOpen,
  );
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);

  async function refresh() {
    try {
      const [
        nextProfiles,
        nextWorkspaces,
        nextSystem,
        nextProxyPool,
        nextScheduler,
        nextJobs,
        nextLocalApi,
        nextWorker,
        nextAutomation,
      ] = await Promise.all([
        listProfiles(),
        listWorkspaces(),
        getSystemInfo(),
        getProxyPoolState(),
        getSchedulerState(),
        listGenerationJobs(),
        getLocalApiState(),
        getWorkerState(),
        getAutomationRuntimeState(),
      ]);
      setProfiles(nextProfiles);
      setWorkspaces(nextWorkspaces);
      setSystem(nextSystem);
      setProxyPool(nextProxyPool);
      setScheduler(nextScheduler);
      setGenerationJobs(nextJobs);
      setLocalApi(nextLocalApi);
      setApiPortDraft(String(nextLocalApi.port));
      setWorkerState(nextWorker);
      setAutomationRuntime(nextAutomation);
      if (!nextAutomation.running) {
        setAutomationDraft({
          concurrency: nextAutomation.concurrency,
          timeoutSeconds: nextAutomation.timeoutSeconds,
          manualVerificationSeconds: nextAutomation.manualVerificationSeconds,
        });
      }
      setSelected((current) =>
        current.filter((id) =>
          nextProfiles.some((profile) => profile.id === id),
        ),
      );
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      UI_PREFS_KEY,
      JSON.stringify({
        view,
        queueFilter,
        queueSort,
        profileDensity,
        workspacesOpen,
        advancedRuntimeOpen,
      } satisfies UiPreferences),
    );
  }, [
    view,
    queueFilter,
    queueSort,
    profileDensity,
    workspacesOpen,
    advancedRuntimeOpen,
  ]);


  const groups = useMemo(
    () => [
      "All",
      ...Array.from(
        new Set(
          profiles
            .map((profile) => profile.groupName)
            .filter(Boolean) as string[],
        ),
      ).sort(),
    ],
    [profiles],
  );

  const visibleProfiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return profiles.filter((profile) => {
      const groupMatch = group === "All" || profile.groupName === group;
      const searchMatch =
        !needle ||
        [
          profile.name,
          profile.email,
          profile.groupName,
          profile.activeProxy?.proxyName,
          profile.activeProxy?.publicIp,
          profile.activeProxy?.endpoint,
          ...profile.tags,
        ]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(needle));
      return groupMatch && searchMatch;
    });
  }, [profiles, query, group]);

  const runningCount = profiles.filter((profile) => profile.isRunning).length;
  const enabledProxyCount = proxyPool.items.filter((proxy) => proxy.enabled).length;
  const healthyProxyCount = proxyPool.items.filter(
    (proxy) => proxy.enabled && proxy.health === "healthy",
  ).length;
  const inUseProxyIds = new Set(
    profiles
      .filter((profile) => profile.isRunning && profile.activeProxy)
      .map((profile) => profile.activeProxy!.proxyId),
  );
  const queuedJobs = generationJobs.filter((job) => job.status === "queued").length;
  const activeJobs = generationJobs.filter((job) =>
    ["assigned", "starting", "generating", "recovering"].includes(job.status),
  ).length;
  const completedJobs = generationJobs.filter((job) => job.status === "completed").length;
  const failedJobs = generationJobs.filter((job) => job.status === "failed").length;
  const needsLoginCount = profiles.filter(
    (profile) => profile.operational.availability === "needs_login",
  ).length;

  const visibleJobs = useMemo(() => {
    const needle = queueQuery.trim().toLowerCase();
    const activeStatuses = new Set(["assigned", "starting", "generating", "recovering"]);

    const filtered = generationJobs.filter((job) => {
      const filterMatch =
        queueFilter === "all" ||
        (queueFilter === "active" && activeStatuses.has(job.status)) ||
        job.status === queueFilter;
      if (!filterMatch) return false;

      if (!needle) return true;
      const assignedProfile = job.profileId
        ? profiles.find((profile) => profile.id === job.profileId)
        : null;
      return [
        job.id,
        job.prompt,
        job.model,
        job.status,
        assignedProfile?.name,
        job.externalTaskId,
        job.localPath,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });

    return filtered.sort((a, b) => {
      if (queueSort === "oldest") {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      if (queueSort === "active") {
        const rank = (job: GenerationJob) =>
          activeStatuses.has(job.status)
            ? 0
            : job.status === "queued"
              ? 1
              : job.status === "failed"
                ? 2
                : 3;
        const diff = rank(a) - rank(b);
        if (diff !== 0) return diff;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [generationJobs, profiles, queueFilter, queueQuery, queueSort]);

  function toggleSelected(id: string) {
    setBanner(null);
    setSelected((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      if (current.length >= MAX_SELECTED) {
        setBanner({
          kind: "error",
          text: `You can select up to ${MAX_SELECTED} profiles at a time.`,
        });
        return current;
      }
      return [...current, id];
    });
  }

  async function perform(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setBanner(null);
    try {
      await action();
      if (success) setBanner({ kind: "success", text: success });
      await refresh();
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkspace() {
    if (!workspaceName.trim() || selected.length === 0) return;
    await perform(
      () => createWorkspace(workspaceName.trim(), selected),
      "Workspace saved.",
    );
    setWorkspaceName("");
  }

  async function toggleProxyPool(enabled: boolean) {
    setBusy(true);
    setBanner(null);
    try {
      const next = await setProxyPoolEnabled(enabled);
      setProxyPool(next);
      setBanner({
        kind: "success",
        text: enabled
          ? "System Proxy Pool enabled. New profile launches will use one proxy per profile."
          : "System Proxy Pool disabled. Running profiles keep their current route until closed.",
      });
      await refresh();
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleScheduler(enabled: boolean) {
    setBusy(true);
    setBanner(null);
    try {
      const next = await setSchedulerEnabled(enabled);
      setScheduler(next);
      setBanner({
        kind: "success",
        text: enabled
          ? "Smart Scheduler enabled. Open Smart will use only Ready profiles."
          : "Smart Scheduler disabled.",
      });
      await refresh();
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function markSessionHealthy(profile: BrowserProfile) {
    await perform(
      () =>
        updateProfileOperationalState(profile.id, {
          sessionStatus: "healthy",
          loginCheckedAt: new Date().toISOString(),
        }),
      `${profile.name} marked session healthy.`,
    );
  }

  async function markNeedsLogin(profile: BrowserProfile) {
    await perform(
      () =>
        updateProfileOperationalState(profile.id, {
          sessionStatus: "needs_login",
          loginCheckedAt: new Date().toISOString(),
        }),
      `${profile.name} marked as needing login.`,
    );
  }

  async function clearProfileBlocks(profile: BrowserProfile) {
    await perform(
      () => clearProfileOperationalBlocks(profile.id),
      `${profile.name} cooldown/rate-limit/quota blocks cleared.`,
    );
  }

  async function submitGenerationJob(event: FormEvent) {
    event.preventDefault();
    if (!jobForm.prompt.trim()) return;

    setBusy(true);
    setBanner(null);
    try {
      await createGenerationJob({
        ...jobForm,
        prompt: jobForm.prompt.trim(),
      });
      setJobForm({
        prompt: "",
        model: "seedance-2.5",
        durationSeconds: 10,
        ratio: "1:1",
      });
      setShowJobForm(false);
      setBanner({
        kind: "success",
        text: "Generation job queued persistently.",
      });
      await refresh();
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setBanner({ kind: "success", text: `${label} copied.` });
    } catch {
      setBanner({ kind: "error", text: `Could not copy ${label.toLowerCase()}.` });
    }
  }

  async function retryGenerationJob(job: GenerationJob) {
    await perform(
      () =>
        createGenerationJob({
          prompt: job.prompt,
          model: job.model,
          durationSeconds: job.durationSeconds,
          ratio: job.ratio,
        }),
      "Generation retry queued as a new job.",
    );
    setView("queue");
    setQueueFilter("queued");
  }

  async function toggleAutomationRuntime(enabled: boolean) {
    setBusy(true);
    setBanner(null);
    try {
      const next = await setAutomationRuntimeEnabled(enabled);
      setAutomationRuntime(next);
      if (!enabled) {
        setRevealedApiKey("");
      }
      setBanner({
        kind: "success",
        text: enabled
          ? "Automation Runtime started. Scheduler, Local API, allocator and Seedance adapter are active."
          : "Automation Runtime stopped. Adapter, allocator and Local API are off.",
      });
      await refresh();
      if (showAutomationLog) {
        setAutomationLog(await getAutomationRuntimeLog());
      }
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveAutomationConfig() {
    if (
      !Number.isInteger(automationDraft.concurrency) ||
      automationDraft.concurrency < 1 ||
      automationDraft.concurrency > 4
    ) {
      setBanner({ kind: "error", text: "Adapter concurrency must be between 1 and 4." });
      return;
    }

    setBusy(true);
    setBanner(null);
    try {
      const next = await updateAutomationRuntimeConfig({
        concurrency: automationDraft.concurrency,
        timeoutSeconds: automationDraft.timeoutSeconds,
        manualVerificationSeconds: automationDraft.manualVerificationSeconds,
      });
      setAutomationRuntime(next);
      setAutomationDraft({
        concurrency: next.concurrency,
        timeoutSeconds: next.timeoutSeconds,
        manualVerificationSeconds: next.manualVerificationSeconds,
      });
      setBanner({ kind: "success", text: "Automation Runtime settings saved." });
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function refreshAutomationLog(open = true) {
    setBusy(true);
    try {
      const log = await getAutomationRuntimeLog();
      setAutomationLog(log);
      if (open) setShowAutomationLog(true);
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleLocalApi(enabled: boolean) {
    await perform(
      () => setLocalApiEnabled(enabled),
      enabled
        ? "Local API started on loopback only."
        : "Local API stopped.",
    );
    if (!enabled) setRevealedApiKey("");
  }

  async function saveApiPort() {
    const port = Number(apiPortDraft);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setBanner({
        kind: "error",
        text: "Local API port must be between 1024 and 65535.",
      });
      return;
    }
    await perform(() => setLocalApiPort(port), `Local API moved to port ${port}.`);
  }

  async function revealApiKey() {
    setBusy(true);
    setBanner(null);
    try {
      const key = await revealLocalApiKey();
      setRevealedApiKey(key);
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function rotateApiKey() {
    setBusy(true);
    setBanner(null);
    try {
      const key = await rotateLocalApiKey();
      setRevealedApiKey(key);
      setBanner({
        kind: "success",
        text: "Local API key rotated. Existing clients must use the new key.",
      });
      await refresh();
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleWorker(enabled: boolean) {
    await perform(
      () => setWorkerEnabled(enabled),
      enabled
        ? "Allocation worker started."
        : "Allocation worker stopped.",
    );
  }

  async function allocateNow() {
    setBusy(true);
    setBanner(null);
    try {
      const count = await runWorkerTick();
      setBanner({
        kind: "success",
        text: count
          ? `Assigned ${count} queued job(s) to Ready profiles.`
          : "Worker tick completed; no new assignments.",
      });
      await refresh();
    } catch (error) {
      setBanner({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  function availabilityLabel(profile: BrowserProfile) {
    switch (profile.operational.availability) {
      case "ready":
        return "Ready";
      case "needs_login":
        return "Need login";
      case "cooldown":
        return "Cooldown";
      case "rate_limited":
        return "Rate limited";
      case "quota_blocked":
        return "Quota blocked";
      case "disabled":
        return "Disabled";
      default:
        return "Unknown";
    }
  }

  function availabilityClass(profile: BrowserProfile) {
    return `availability-${profile.operational.availability}`;
  }

  function profileProxyLabel(profile: BrowserProfile) {
    if (profile.activeProxy) {
      return profile.activeProxy.publicIp || profile.activeProxy.proxyName;
    }
    return proxyPool.enabled ? "Pool ready" : "OFF";
  }

  function profileProxyClass(profile: BrowserProfile) {
    if (profile.activeProxy) return "proxy-healthy";
    return proxyPool.enabled ? "proxy-unchecked" : "proxy-disabled";
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark brand-logo">
            <img src={seedanceLogo} alt="Seedance video generator logo" />
          </div>
          <div>
            <strong>Dola Gateway</strong>
            <span>Seedance Profile Manager</span>
          </div>
        </div>

        <nav>
          <button
            className={view === "profiles" ? "nav-item active" : "nav-item"}
            onClick={() => setView("profiles")}
          >
            <span className="nav-icon">
              <img src={profilesIcon} alt="" aria-hidden="true" />
            </span>
            Profiles
            <b>{profiles.length}</b>
          </button>

          <button
            className={view === "proxies" ? "nav-item active" : "nav-item"}
            onClick={() => setView("proxies")}
          >
            <span className="nav-icon">
              <img src={proxiesIcon} alt="" aria-hidden="true" />
            </span>
            Proxies
            <b>{enabledProxyCount}</b>
          </button>

          <button
            className={view === "queue" ? "nav-item active" : "nav-item"}
            onClick={() => setView("queue")}
          >
            <span className="nav-icon queue-nav-icon">
              <img src={seedanceLogo} alt="" aria-hidden="true" />
            </span>
            Queue
            <b>{queuedJobs + activeJobs}</b>
          </button>

          <details
            className="sidebar-workspaces"
            open={workspacesOpen}
            onToggle={(event) =>
              setWorkspacesOpen((event.currentTarget as HTMLDetailsElement).open)
            }
          >
            <summary>
              <span>Workspaces</span>
              <b>{workspaces.length}</b>
            </summary>
            <div className="sidebar-workspace-body">
              {workspaces.length === 0 ? (
                <p className="sidebar-empty">
                  Select profiles and save a workspace when you need a reusable batch.
                </p>
              ) : (
                workspaces.map((workspace) => (
                  <div className="workspace-row" key={workspace.id}>
                    <button
                      className="workspace-open"
                      onClick={() =>
                        perform(
                          () => openProfiles(workspace.profileIds),
                          `${workspace.name} opened.`,
                        )
                      }
                      disabled={busy}
                      title="Open workspace"
                    >
                      <span className="workspace-dot" />
                      <span>
                        {workspace.name}
                        <small>{workspace.profileIds.length} profiles</small>
                      </span>
                    </button>
                    <button
                      className="workspace-delete"
                      aria-label={`Delete ${workspace.name}`}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete workspace "${workspace.name}"? Profiles will not be deleted.`,
                          )
                        ) {
                          void perform(() => deleteWorkspace(workspace.id));
                        }
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </details>
        </nav>

        <div className="sidebar-status">
          <div
            className={system?.chromePath ? "status-dot online" : "status-dot"}
          />
          <div>
            <strong>
              {system?.chromePath ? "Chrome detected" : "Chrome not detected"}
            </strong>
            <span>
              {runningCount} / {system?.maxSimultaneousProfiles ?? 4} running
            </span>
          </div>
        </div>
      </aside>

      <main className="content">
        {view === "profiles" ? (
          <>
            <header className="topbar">
              <div>
                <span className="eyebrow">DOLA SESSIONS</span>
                <h1>Profiles</h1>
                <p>
                  Persistent Dola login sessions with optional rotating proxy routing.
                </p>
              </div>
              <button className="button primary" onClick={() => setShowCreate(true)}>
                <span className="plus">＋</span> New profile
              </button>
            </header>

            {banner && (
              <div className={`banner ${banner.kind}`}>{banner.text}</div>
            )}

            <section className="stats-grid">
              <div className="stat-card">
                <span>Total profiles</span>
                <strong>{profiles.length}</strong>
                <small>Persistent Chrome sessions</small>
              </div>
              <div className="stat-card">
                <span>Running now</span>
                <strong>{runningCount}</strong>
                <small>
                  Maximum {system?.maxSimultaneousProfiles ?? 4} at once
                </small>
              </div>
              <div className="stat-card">
                <span>Proxy Pool</span>
                <strong>{proxyPool.enabled ? "ON" : "OFF"}</strong>
                <small>
                  {proxyPool.enabled
                    ? `${enabledProxyCount} proxy slots available`
                    : "Direct connection for new launches"}
                </small>
              </div>
              <div className="stat-card">
                <span>Ready profiles</span>
                <strong>{scheduler.readyProfiles}</strong>
                <small>{scheduler.blockedProfiles} blocked from automation</small>
              </div>
            </section>

            <details className="scheduler-advanced-card">
              <summary>
                <span>Advanced scheduler settings</span>
                <small>
                  {automationRuntime.running
                    ? "Managed by Automation Runtime"
                    : scheduler.enabled
                      ? "Scheduler ON"
                      : "Scheduler OFF"}
                </small>
              </summary>
              <div className="scheduler-advanced-body">
                <div>
                  <strong>Smart Scheduler</strong>
                  <p>
                    Uses Ready profiles in least-recently-used order and skips blocked,
                    cooldown, quota-limited or login-required profiles.
                  </p>
                </div>
                <label className="master-toggle scheduler-toggle" title="Enable Smart Scheduler">
                  <input
                    type="checkbox"
                    checked={scheduler.enabled}
                    disabled={busy || automationRuntime.running}
                    onChange={(event) => void toggleScheduler(event.target.checked)}
                  />
                  <span />
                </label>
              </div>
            </details>

            <section className="panel">
              <div className="toolbar">
                <div className="search-box">
                  <span>⌕</span>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search profiles, IP, proxy, tags…"
                  />
                </div>
                <select
                  value={group}
                  onChange={(event) => setGroup(event.target.value)}
                >
                  {groups.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
                <button
                  className={profileDensity === "compact" ? "density-button active" : "density-button"}
                  type="button"
                  aria-pressed={profileDensity === "compact"}
                  onClick={() =>
                    setProfileDensity((current) =>
                      current === "compact" ? "comfortable" : "compact",
                    )
                  }
                  title="Toggle compact profile rows"
                >
                  {profileDensity === "compact" ? "Compact" : "Comfort"}
                </button>
                <div className="toolbar-spacer" />
                <button
                  className="button secondary"
                  disabled={!scheduler.enabled || scheduler.readyProfiles === 0 || busy}
                  onClick={() =>
                    perform(
                      () => openSmartProfiles(MAX_SELECTED),
                      "Ready profiles opened.",
                    )
                  }
                >
                  ▶ Open ready
                </button>
                <span className="selected-count">
                  {selected.length} / {MAX_SELECTED} selected
                </span>
                <button
                  className="button primary"
                  disabled={selected.length === 0 || busy}
                  onClick={() =>
                    perform(
                      () => openProfiles(selected),
                      proxyPool.enabled
                        ? `${selected.length} profile(s) opened with Proxy Pool allocation.`
                        : `${selected.length} profile(s) opened.`,
                    )
                  }
                >
                  ▶ Open selected
                </button>
              </div>

              {selected.length > 0 && (
                <div className="workspace-builder">
                  <span>Save this selection as a workspace</span>
                  <input
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    placeholder="e.g. Seedance Batch A"
                  />
                  <button
                    className="button secondary"
                    onClick={() => void saveWorkspace()}
                    disabled={!workspaceName.trim() || busy}
                  >
                    Save workspace
                  </button>
                </div>
              )}

              <div className="table-head">
                <span />
                <span>Profile</span>
                <span>Proxy</span>
                <span>Health</span>
                <span>Group</span>
                <span>Status</span>
                <span>Last opened</span>
                <span />
              </div>

              <div className={`profile-list ${profileDensity === "compact" ? "compact" : ""}`}>
                {visibleProfiles.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon">◫</div>
                    <h3>
                      {profiles.length
                        ? "No matching profiles"
                        : "Create your first profile"}
                    </h3>
                    <p>
                      {profiles.length
                        ? "Try another search or group."
                        : "Each profile gets its own Chrome user-data directory so sessions never mix."}
                    </p>
                    {!profiles.length && (
                      <button
                        className="button primary"
                        onClick={() => setShowCreate(true)}
                      >
                        Create profile
                      </button>
                    )}
                  </div>
                ) : (
                  visibleProfiles.map((profile) => {
                    const checked = selected.includes(profile.id);
                    return (
                      <article
                        className={
                          checked ? "profile-row selected" : "profile-row"
                        }
                        key={profile.id}
                      >
                        <label className="check-wrap">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSelected(profile.id)}
                          />
                          <span />
                        </label>

                        <div className="profile-cell">
                          <div className="avatar">{initials(profile.name)}</div>
                          <div>
                            <strong>{profile.name}</strong>
                            <span>{profile.email || "No account label"}</span>
                          </div>
                        </div>

                        <div
                          className={`proxy-pill ${profileProxyClass(profile)}`}
                          title={
                            profile.activeProxy?.endpoint ||
                            (proxyPool.enabled
                              ? "A proxy will be allocated when this profile opens."
                              : "System Proxy Pool is disabled.")
                          }
                        >
                          <i />
                          {profileProxyLabel(profile)}
                        </div>

                        <div
                          className="availability-cell"
                          title={profile.operational.availabilityReason || undefined}
                        >
                          <span
                            className={`availability-badge ${availabilityClass(profile)}`}
                          >
                            {availabilityLabel(profile)}
                          </span>
                        </div>

                        <span>{profile.groupName || "—"}</span>

                        <span
                          className={
                            profile.isRunning
                              ? "run-status running"
                              : "run-status"
                          }
                        >
                          <i />
                          {profile.isRunning ? "Running" : "Stopped"}
                        </span>

                        <span className="muted">
                          {relativeTime(profile.lastOpenedAt)}
                        </span>

                        <div className="row-actions">
                          {profile.isRunning ? (
                            <button
                              className="mini-button danger"
                              disabled={busy}
                              onClick={() =>
                                perform(
                                  () => closeProfile(profile.id),
                                  "Chrome profile closed and proxy slot released.",
                                )
                              }
                            >
                              Stop
                            </button>
                          ) : (
                            <button
                              className="mini-button"
                              disabled={busy}
                              onClick={() =>
                                perform(
                                  () => openProfiles([profile.id]),
                                  proxyPool.enabled
                                    ? "Chrome profile opened with an allocated proxy."
                                    : "Chrome profile opened.",
                                )
                              }
                            >
                              Open
                            </button>
                          )}
                          <details className="profile-action-menu">
                            <summary
                              className="dots-button"
                              aria-label={`More actions for ${profile.name}`}
                            >
                              ⋯
                            </summary>
                            <div className="profile-action-popover">
                              {!profile.isRunning &&
                                ["unknown", "needs_login"].includes(
                                  profile.operational.availability,
                                ) && (
                                  <button
                                    disabled={busy}
                                    onClick={() => void markSessionHealthy(profile)}
                                  >
                                    Mark session healthy
                                  </button>
                                )}
                              {!profile.isRunning &&
                                profile.operational.availability === "ready" && (
                                  <button
                                    disabled={busy}
                                    onClick={() => void markNeedsLogin(profile)}
                                  >
                                    Mark as need login
                                  </button>
                                )}
                              {!profile.isRunning &&
                                ["cooldown", "rate_limited", "quota_blocked"].includes(
                                  profile.operational.availability,
                                ) && (
                                  <button
                                    disabled={busy}
                                    onClick={() => void clearProfileBlocks(profile)}
                                  >
                                    Clear availability blocks
                                  </button>
                                )}
                              {!profile.isRunning &&
                                profile.operational.availability === "disabled" && (
                                  <button
                                    disabled={busy}
                                    onClick={() =>
                                      void perform(
                                        () =>
                                          updateProfileOperationalState(profile.id, {
                                            schedulingEnabled: true,
                                          }),
                                        `${profile.name} scheduling enabled.`,
                                      )
                                    }
                                  >
                                    Enable scheduling
                                  </button>
                                )}
                              <button
                                className="danger-item"
                                disabled={busy}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Remove "${profile.name}" from Dola Gateway? Chrome session data will stay on disk.`,
                                    )
                                  ) {
                                    void perform(
                                      () => deleteProfile(profile.id),
                                      "Profile entry removed. Session data was kept on disk.",
                                    );
                                  }
                                }}
                              >
                                Remove from manager
                              </button>
                            </div>
                          </details>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </section>

            <footer
              className="data-path"
              title={system?.dataDir ?? undefined}
            >
              Session data stays on this PC.
            </footer>
          </>
        ) : view === "proxies" ? (
          <>
            <header className="topbar">
              <div>
                <span className="eyebrow">SYSTEM NETWORK ROUTING</span>
                <h1>Proxies</h1>
                <p>
                  One rotating proxy slot is reserved for each newly opened Chrome
                  profile.
                </p>
              </div>
              <button
                className="button primary"
                onClick={() => {
                  setEditingProxy(null);
                  setShowProxyForm(true);
                }}
              >
                <span className="plus">＋</span> Add proxy
              </button>
            </header>

            {banner && (
              <div className={`banner ${banner.kind}`}>{banner.text}</div>
            )}

            <section className="proxy-master-card">
              <div>
                <span className="eyebrow">GLOBAL PROXY POOL</span>
                <h3>{proxyPool.enabled ? "Enabled" : "Disabled"}</h3>
                <p>
                  {proxyPool.enabled
                    ? "Opening 4 new profiles prepares 4 separate proxy slots, rotates each configured endpoint, checks them, then launches one profile through each proxy."
                    : "New Chrome profiles use the machine's direct connection. Existing running sessions are not changed."}
                </p>
              </div>
              <label className="master-toggle">
                <input
                  type="checkbox"
                  checked={proxyPool.enabled}
                  disabled={busy}
                  onChange={(event) => void toggleProxyPool(event.target.checked)}
                />
                <span />
              </label>
            </section>

            <section className="stats-grid proxy-stats">
              <div className="stat-card">
                <span>Total proxy slots</span>
                <strong>{proxyPool.items.length}</strong>
                <small>Configured endpoints</small>
              </div>
              <div className="stat-card">
                <span>Enabled</span>
                <strong>{enabledProxyCount}</strong>
                <small>Eligible for allocation</small>
              </div>
              <div className="stat-card">
                <span>Healthy</span>
                <strong>{healthyProxyCount}</strong>
                <small>Passed latest preflight</small>
              </div>
              <div className="stat-card">
                <span>In use</span>
                <strong>{inUseProxyIds.size}</strong>
                <small>Reserved by running profiles</small>
              </div>
            </section>

            <section className="panel proxy-pool-panel">
              <div className="proxy-pool-head">
                <div>
                  <strong>Rotating Proxy Pool</strong>
                  <span>
                    Add at least 4 enabled proxies if you normally open 4 profiles
                    together.
                  </span>
                </div>

              </div>

              <div className="proxy-table-head">
                <span>Proxy</span>
                <span>Endpoint</span>
                <span>Health</span>
                <span>Last IP</span>
                <span>Latency</span>
                <span>Rotation</span>
                <span />
              </div>

              <div className="proxy-list">
                {proxyPool.items.length === 0 ? (
                  <div className="empty-state proxy-empty">
                    <div className="empty-icon">⇄</div>
                    <h3>Add your first rotating proxy</h3>
                    <p>
                      For a 4-profile batch, configure at least 4 enabled proxy slots.
                      Each slot is reserved for only one running profile.
                    </p>
                    <button
                      className="button primary"
                      onClick={() => {
                        setEditingProxy(null);
                        setShowProxyForm(true);
                      }}
                    >
                      Add proxy
                    </button>
                  </div>
                ) : (
                  proxyPool.items.map((item) => {
                    const inUse = inUseProxyIds.has(item.id);
                    return (
                      <article className="proxy-row" key={item.id}>
                        <div className="proxy-name-cell">
                          <span
                            className={
                              item.enabled
                                ? "proxy-enable-dot enabled"
                                : "proxy-enable-dot"
                            }
                          />
                          <div>
                            <strong>{item.name}</strong>
                            <span>{inUse ? "In use" : item.enabled ? "Available" : "Disabled"}</span>
                          </div>
                        </div>

                        <code>
                          {item.protocol}://{item.host}:{item.port}
                        </code>

                        <span className={`pool-health health-${item.health}`}>
                          <i />
                          {item.health}
                        </span>

                        <span className="proxy-ip">{item.lastIp || "—"}</span>

                        <span className="muted">
                          {item.lastLatencyMs != null
                            ? `${item.lastLatencyMs} ms`
                            : "—"}
                        </span>

                        <span className="rotation-status">
                          {item.rotationUrl ? "Auto on allocation" : "Endpoint only"}
                        </span>

                        <div className="proxy-row-actions">
                          <button
                            className="mini-button"
                            disabled={busy || !item.enabled}
                            onClick={() =>
                              perform(
                                () => testProxyPoolItem(item.id),
                                `${item.name} proxy test completed.`,
                              )
                            }
                          >
                            Test
                          </button>
                          <button
                            className="mini-button"
                            disabled={busy || inUse || !item.rotationUrl || !item.enabled}
                            onClick={() =>
                              perform(
                                () => rotateProxyPoolItem(item.id),
                                `${item.name} rotated and checked.`,
                              )
                            }
                          >
                            Rotate
                          </button>
                          <button
                            className="dots-button"
                            title="Edit proxy"
                            disabled={busy || inUse}
                            onClick={() => {
                              setEditingProxy(item);
                              setShowProxyForm(true);
                            }}
                          >
                            ✎
                          </button>
                          <button
                            className="dots-button proxy-delete-button"
                            title="Delete proxy"
                            disabled={busy || inUse}
                            onClick={() => {
                              if (window.confirm(`Delete proxy "${item.name}"?`)) {
                                void perform(
                                  () => deleteProxyPoolItem(item.id),
                                  `${item.name} removed from Proxy Pool.`,
                                );
                              }
                            }}
                          >
                            ×
                          </button>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          </>
        ) : (
          <>
            <header className="topbar">
              <div>
                <span className="eyebrow">SEEDANCE OPERATIONS</span>
                <h1>Generation Queue</h1>
                <p>
                  Create, run and monitor Seedance generations across Ready profiles.
                </p>
              </div>
              <button
                className="button primary"
                onClick={() => setShowJobForm((current) => !current)}
              >
                <span className="plus">＋</span> New job
              </button>
            </header>

            {banner && (
              <div className={`banner ${banner.kind}`}>{banner.text}</div>
            )}

            <section className={`automation-master-card ${automationRuntime.running ? "running" : ""}`}>
              <div className="automation-master-head">
                <div className="automation-master-title">
                  <div className="automation-logo">
                    <img src={seedanceLogo} alt="" aria-hidden="true" />
                  </div>
                  <div>
                    <span className="eyebrow">ONE-CLICK ORCHESTRATION</span>
                    <h3>Automation Runtime</h3>
                    <p>
                      Starts Smart Scheduler, Local API, Profile Allocator and the Seedance
                      execution adapter as one managed runtime.
                    </p>
                  </div>
                </div>
                <div className="automation-master-status">
                  <span className={automationRuntime.running ? "runtime-chip on" : "runtime-chip"}>
                    {automationRuntime.running ? "RUNNING" : "STOPPED"}
                  </span>
                  <label className="master-toggle runtime-toggle" title="Toggle Automation Runtime">
                    <input
                      type="checkbox"
                      checked={automationRuntime.running}
                      disabled={busy}
                      onChange={(event) => void toggleAutomationRuntime(event.target.checked)}
                    />
                    <span />
                  </label>
                </div>
              </div>

              <div className="automation-dependencies">
                <span className={scheduler.readyProfiles > 0 ? "dependency-chip on" : "dependency-chip"}>
                  {scheduler.readyProfiles} Ready profile{scheduler.readyProfiles === 1 ? "" : "s"}
                </span>
                <span className={activeJobs > 0 ? "dependency-chip on" : "dependency-chip"}>
                  {activeJobs} active
                </span>
                <span className={queuedJobs > 0 ? "dependency-chip on" : "dependency-chip"}>
                  {queuedJobs} queued
                </span>
                {needsLoginCount > 0 && (
                  <span className="dependency-chip error">
                    {needsLoginCount} need login
                  </span>
                )}
                <span className={automationRuntime.nodePath ? "dependency-chip on" : "dependency-chip error"}>
                  Node {automationRuntime.nodePath ? "READY" : "MISSING"}
                </span>
              </div>

              <div className="automation-config-grid">
                <label>
                  Concurrency
                  <select
                    value={automationDraft.concurrency}
                    disabled={automationRuntime.running || busy}
                    onChange={(event) =>
                      setAutomationDraft({
                        ...automationDraft,
                        concurrency: Number(event.target.value),
                      })
                    }
                  >
                    <option value={1}>1 profile</option>
                    <option value={2}>2 profiles</option>
                    <option value={3}>3 profiles</option>
                    <option value={4}>4 profiles</option>
                  </select>
                </label>
                <label>
                  Generation timeout
                  <select
                    value={automationDraft.timeoutSeconds}
                    disabled={automationRuntime.running || busy}
                    onChange={(event) =>
                      setAutomationDraft({
                        ...automationDraft,
                        timeoutSeconds: Number(event.target.value),
                      })
                    }
                  >
                    <option value={600}>10 min</option>
                    <option value={1200}>20 min</option>
                    <option value={1800}>30 min</option>
                    <option value={3600}>60 min</option>
                  </select>
                </label>
                <label>
                  Manual verification
                  <select
                    value={automationDraft.manualVerificationSeconds}
                    disabled={automationRuntime.running || busy}
                    onChange={(event) =>
                      setAutomationDraft({
                        ...automationDraft,
                        manualVerificationSeconds: Number(event.target.value),
                      })
                    }
                  >
                    <option value={60}>1 min</option>
                    <option value={180}>3 min</option>
                    <option value={300}>5 min</option>
                    <option value={600}>10 min</option>
                  </select>
                </label>
                <button
                  className="mini-button automation-save-button"
                  disabled={
                    automationRuntime.running ||
                    busy ||
                    (automationDraft.concurrency === automationRuntime.concurrency &&
                      automationDraft.timeoutSeconds === automationRuntime.timeoutSeconds &&
                      automationDraft.manualVerificationSeconds ===
                        automationRuntime.manualVerificationSeconds)
                  }
                  onClick={() => void saveAutomationConfig()}
                >
                  Save settings
                </button>
              </div>

              <details className="automation-technical-details">
                <summary>Runtime details</summary>
                <div className="automation-meta">
                  <div>
                    <span>PID</span>
                    <strong>{automationRuntime.pid ?? "—"}</strong>
                  </div>
                  <div>
                    <span>Started</span>
                    <strong>{relativeTime(automationRuntime.startedAt)}</strong>
                  </div>
                  <div className="automation-path">
                    <span>Adapter</span>
                    <code title={automationRuntime.scriptPath ?? undefined}>
                      {automationRuntime.scriptPath ?? "Resource unavailable"}
                    </code>
                  </div>
                </div>
              </details>

              {automationRuntime.lastError && (
                <div className="runtime-error">{automationRuntime.lastError}</div>
              )}

              <div className="automation-actions">
                <button
                  className={automationRuntime.running ? "button secondary" : "button primary"}
                  disabled={busy}
                  onClick={() => void toggleAutomationRuntime(!automationRuntime.running)}
                >
                  {automationRuntime.running ? "■ Stop automation" : "▶ Start automation"}
                </button>
                <button
                  className="mini-button"
                  disabled={busy}
                  onClick={() =>
                    showAutomationLog
                      ? setShowAutomationLog(false)
                      : void refreshAutomationLog(true)
                  }
                >
                  {showAutomationLog ? "Hide logs" : "View logs"}
                </button>
                {showAutomationLog && (
                  <button
                    className="mini-button"
                    disabled={busy}
                    onClick={() => void refreshAutomationLog(false)}
                  >
                    Refresh logs
                  </button>
                )}
              </div>

              {showAutomationLog && (
                <pre className="automation-log">
                  {automationLog.trim() || "No adapter log output yet."}
                </pre>
              )}
            </section>

            <details
              className="advanced-runtime-details"
              open={advancedRuntimeOpen}
              onToggle={(event) =>
                setAdvancedRuntimeOpen((event.currentTarget as HTMLDetailsElement).open)
              }
            >
              <summary>
                <span>Advanced runtime controls</span>
                <small>Local API · Allocator · API key</small>
              </summary>
              <section className="runtime-grid">
              <article className="runtime-card">
                <div className="runtime-card-head">
                  <div>
                    <span className="eyebrow">LOCAL API</span>
                    <h3>Loopback Gateway</h3>
                  </div>
                  <span className={localApi.running ? "runtime-chip on" : "runtime-chip"}>
                    {localApi.running ? "RUNNING" : "STOPPED"}
                  </span>
                </div>
                <p>
                  Authenticated HTTP API bound only to <code>127.0.0.1</code>.
                </p>
                <div className="runtime-row">
                  <span>Base URL</span>
                  <code>{localApi.baseUrl}</code>
                </div>
                <div className="runtime-row runtime-port-row">
                  <span>Port</span>
                  <div>
                    <input
                      value={apiPortDraft}
                      inputMode="numeric"
                      onChange={(event) => setApiPortDraft(event.target.value)}
                    />
                    <button
                      className="mini-button"
                      disabled={
                        busy ||
                        automationRuntime.running ||
                        Number(apiPortDraft) === localApi.port
                      }
                      onClick={() => void saveApiPort()}
                    >
                      Save
                    </button>
                  </div>
                </div>
                <div className="runtime-row">
                  <span>API key</span>
                  <code>{revealedApiKey || localApi.apiKeyPreview}</code>
                </div>
                <div className="runtime-actions">
                  <button
                    className="mini-button"
                    disabled={busy}
                    onClick={() =>
                      revealedApiKey
                        ? setRevealedApiKey("")
                        : void revealApiKey()
                    }
                  >
                    {revealedApiKey ? "Hide key" : "Reveal key"}
                  </button>
                  <button
                    className="mini-button"
                    disabled={busy || automationRuntime.running}
                    onClick={() => void rotateApiKey()}
                  >
                    Rotate key
                  </button>
                  <label className="master-toggle runtime-toggle" title="Enable Local API">
                    <input
                      type="checkbox"
                      checked={localApi.enabled}
                      disabled={busy || automationRuntime.running}
                      onChange={(event) => void toggleLocalApi(event.target.checked)}
                    />
                    <span />
                  </label>
                </div>
              </article>

              <article className="runtime-card">
                <div className="runtime-card-head">
                  <div>
                    <span className="eyebrow">BACKGROUND WORKER</span>
                    <h3>Profile Allocator</h3>
                  </div>
                  <span className={workerState.running ? "runtime-chip on" : "runtime-chip"}>
                    {workerState.running ? "RUNNING" : "STOPPED"}
                  </span>
                </div>
                <p>
                  Allocation-only mode claims queued jobs and reserves Ready profiles.
                </p>
                <div className="runtime-metrics">
                  <div>
                    <span>Queued</span>
                    <strong>{workerState.queuedJobs}</strong>
                  </div>
                  <div>
                    <span>Assigned</span>
                    <strong>{workerState.activeAssignments}</strong>
                  </div>
                  <div>
                    <span>Max active</span>
                    <strong>{workerState.maxConcurrentJobs}</strong>
                  </div>
                </div>
                <div className="runtime-row">
                  <span>Last tick</span>
                  <strong>{relativeTime(workerState.lastTickAt)}</strong>
                </div>
                {workerState.lastError && (
                  <div className="runtime-error">{workerState.lastError}</div>
                )}
                <div className="runtime-actions">
                  <button
                    className="mini-button"
                    disabled={busy || !workerState.enabled}
                    onClick={() => void allocateNow()}
                  >
                    Allocate now
                  </button>
                  <span className="runtime-mode">{workerState.mode}</span>
                  <label className="master-toggle runtime-toggle" title="Enable allocation worker">
                    <input
                      type="checkbox"
                      checked={workerState.enabled}
                      disabled={
                        busy ||
                        automationRuntime.running ||
                        (!scheduler.enabled && !workerState.enabled)
                      }
                      onChange={(event) => void toggleWorker(event.target.checked)}
                    />
                    <span />
                  </label>
                </div>
              </article>
              </section>
            </details>

            {showJobForm && (
              <form className="queue-create-card" onSubmit={submitGenerationJob}>
                <div className="queue-create-heading">
                  <div>
                    <strong>Queue Seedance job</strong>
                    <span>
                      Jobs start automatically when Automation Runtime is running and a
                      Ready profile is available.
                    </span>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setShowJobForm(false)}
                  >
                    ×
                  </button>
                </div>

                <label>
                  Prompt
                  <textarea
                    rows={4}
                    value={jobForm.prompt}
                    onChange={(event) =>
                      setJobForm({ ...jobForm, prompt: event.target.value })
                    }
                    placeholder="Describe the Seedance video to generate..."
                  />
                </label>

                <div className="queue-form-grid">
                  <label>
                    Model
                    <select
                      value={jobForm.model ?? "seedance-2.5"}
                      onChange={(event) =>
                        setJobForm({ ...jobForm, model: event.target.value })
                      }
                    >
                      <option value="seedance-2.5">Seedance 2.5</option>
                      <option value="seedance-2.0">Seedance 2.0</option>
                    </select>
                  </label>
                  <label>
                    Duration
                    <select
                      value={jobForm.durationSeconds ?? 10}
                      onChange={(event) =>
                        setJobForm({
                          ...jobForm,
                          durationSeconds: Number(event.target.value),
                        })
                      }
                    >
                      <option value={10}>10s</option>
                      <option value={15}>15s</option>
                      <option value={30}>30s</option>
                    </select>
                  </label>
                  <label>
                    Ratio
                    <select
                      value={jobForm.ratio ?? "1:1"}
                      onChange={(event) =>
                        setJobForm({ ...jobForm, ratio: event.target.value })
                      }
                    >
                      <option value="1:1">1:1</option>
                      <option value="16:9">16:9</option>
                      <option value="9:16">9:16</option>
                    </select>
                  </label>
                </div>

                <div className="queue-create-actions">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setShowJobForm(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="button primary"
                    disabled={busy || !jobForm.prompt.trim()}
                  >
                    Queue generation
                  </button>
                </div>
              </form>
            )}

            <section className="panel queue-panel">
              <div className="queue-panel-head queue-panel-head-rich">
                <div>
                  <strong>Generation jobs</strong>
                  <span>
                    {visibleJobs.length} shown · {generationJobs.length} total
                  </span>
                </div>
                <div className="queue-search-box">
                  <span>⌕</span>
                  <input
                    value={queueQuery}
                    onChange={(event) => setQueueQuery(event.target.value)}
                    placeholder="Search jobs, prompt, profile…"
                  />
                </div>
                <select
                  className="queue-sort-select"
                  value={queueSort}
                  onChange={(event) => setQueueSort(event.target.value as QueueSort)}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="active">Active first</option>
                </select>
              </div>
              <div className="queue-filter-bar">
                {([
                  ["all", "All", generationJobs.length],
                  ["active", "Active", activeJobs],
                  ["queued", "Queued", queuedJobs],
                  ["completed", "Completed", completedJobs],
                  ["failed", "Failed", failedJobs],
                ] as const).map(([value, label, count]) => (
                  <button
                    key={value}
                    type="button"
                    className={queueFilter === value ? "queue-filter active" : "queue-filter"}
                    onClick={() => setQueueFilter(value)}
                  >
                    {label}
                    <b>{count}</b>
                  </button>
                ))}
              </div>

              {generationJobs.length === 0 ? (
                <div className="empty-state queue-empty">
                  <div className="empty-icon">
                    <img src={seedanceLogo} alt="" aria-hidden="true" />
                  </div>
                  <h3>No generation jobs yet</h3>
                  <p>
                    Queue a Seedance generation. Automation Runtime will assign a Ready
                    profile, run it, and download the completed video automatically.
                  </p>
                  <button
                    className="button primary"
                    onClick={() => setShowJobForm(true)}
                  >
                    Create first job
                  </button>
                </div>
              ) : visibleJobs.length === 0 ? (
                <div className="empty-state queue-empty filtered">
                  <h3>No matching jobs</h3>
                  <p>Change the status filter, sort order, or search query.</p>
                  <button
                    className="button secondary"
                    onClick={() => {
                      setQueueFilter("all");
                      setQueueQuery("");
                    }}
                  >
                    Clear filters
                  </button>
                </div>
              ) : (
                <div className="job-list">
                  {visibleJobs.map((job) => {
                    const assignedProfile = job.profileId
                      ? profiles.find((profile) => profile.id === job.profileId)
                      : null;
                    const terminal = ["completed", "failed", "cancelled"].includes(
                      job.status,
                    );
                    return (
                      <article className="job-row" key={job.id}>
                        <div className="job-main">
                          <span className={`job-status job-status-${job.status}`}>
                            {job.status}
                          </span>
                          <strong>{job.prompt}</strong>
                          <small>
                            {job.model} · {job.durationSeconds}s · {job.ratio}
                          </small>
                          <div className="job-progress-track" aria-label={`Progress ${job.progressPercent}%`}>
                            <span style={{ width: `${job.progressPercent}%` }} />
                          </div>
                          <div className="job-meta-inline">
                            <span>{job.progressPercent}%</span>
                            {job.nextRetryAt && (
                              <span>retry {relativeTime(job.nextRetryAt)}</span>
                            )}
                          </div>
                          {job.status === "completed" && (
                            <div className="job-result-meta">
                              {job.resultWidth && job.resultHeight && (
                                <span
                                  className={
                                    Math.min(job.resultWidth, job.resultHeight) >= 1080
                                      ? "result-quality-badge hd"
                                      : "result-quality-badge"
                                  }
                                >
                                  {job.resultWidth}×{job.resultHeight}
                                </span>
                              )}
                              {job.resultNoWatermark === true && (
                                <span
                                  className="result-quality-badge original"
                                  title="Selected from Dola video_model original-stream candidates."
                                >
                                  Original · no-watermark priority
                                </span>
                              )}
                              {job.resultFileSize && (
                                <span>
                                  {(job.resultFileSize / 1024 / 1024).toFixed(1)} MB
                                </span>
                              )}
                            </div>
                          )}
                          <details className="job-technical-details">
                            <summary>Details</summary>
                            <div className="job-technical-body">
                              <span>Attempt {job.attemptCount}</span>
                              {job.leaseOwner && <span>Lease {job.leaseOwner}</span>}
                              {job.resultSourceKind && (
                                <span>Source {job.resultSourceKind}</span>
                              )}
                              {job.resultBitrate && (
                                <span>
                                  {(job.resultBitrate / 1_000_000).toFixed(1)} Mbps
                                </span>
                              )}
                              {job.localPath && (
                                <code title={job.localPath}>{job.localPath}</code>
                              )}
                            </div>
                          </details>
                        </div>
                        <div className="job-assignment">
                          <span>Profile</span>
                          <strong>{assignedProfile?.name || "Unassigned"}</strong>
                        </div>
                        <div className="job-assignment">
                          <span>Created</span>
                          <strong>{relativeTime(job.createdAt)}</strong>
                        </div>
                        <div className="job-actions">
                          {job.resultUrl && (
                            <span className="job-result-ready">
                              {job.localPath ? "Downloaded" : "Result ready"}
                            </span>
                          )}
                          {job.status === "completed" && job.resultUrl && (
                            <button
                              className="mini-button"
                              disabled={busy}
                              onClick={() => void copyText(job.resultUrl!, "Result URL")}
                            >
                              Copy URL
                            </button>
                          )}
                          {job.status === "completed" && job.localPath && (
                            <button
                              className="mini-button"
                              disabled={busy}
                              onClick={() =>
                                void perform(
                                  () => revealGenerationResult(job.id),
                                  "Opened the managed downloads folder.",
                                )
                              }
                            >
                              Show folder
                            </button>
                          )}
                          {terminal && (
                            <button
                              className="mini-button"
                              disabled={busy}
                              onClick={() => void retryGenerationJob(job)}
                            >
                              Retry
                            </button>
                          )}
                          {!terminal && (
                            <button
                              className="mini-button danger"
                              disabled={busy}
                              onClick={() =>
                                perform(
                                  () => cancelGenerationJob(job.id),
                                  "Generation job cancelled.",
                                )
                              }
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {showCreate && (
        <ProfileForm
          onClose={() => setShowCreate(false)}
          onSaved={(profile) => {
            setProfiles((current) => [profile, ...current]);
            setShowCreate(false);
            setBanner({
              kind: "success",
              text: "Profile created. Open it and sign in once.",
            });
          }}
        />
      )}

      {showProxyForm && (
        <ProxyForm
          initial={editingProxy ?? undefined}
          onClose={() => {
            setShowProxyForm(false);
            setEditingProxy(null);
          }}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

export default App;
