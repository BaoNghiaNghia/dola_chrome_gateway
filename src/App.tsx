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
  getProxyPoolState,
  getSchedulerState,
  getSystemInfo,
  listGenerationJobs,
  listProfiles,
  listWorkspaces,
  openProfiles,
  openSmartProfiles,
  rotateProxyPoolItem,
  setProxyPoolEnabled,
  setSchedulerEnabled,
  testProxyPoolItem,
  updateProfileOperationalState,
  updateProxyPoolItem,
} from "./api";
import type {
  BrowserProfile,
  CreateGenerationJobInput,
  CreateProfileInput,
  GenerationJob,
  ProxyPoolItem,
  ProxyPoolItemInput,
  ProxyPoolState,
  SchedulerState,
  SystemInfo,
  Workspace,
} from "./types";
import seedanceLogo from "./assets/seedance-logo.svg";
import profilesIcon from "./assets/profiles-icon.svg";
import proxiesIcon from "./assets/proxies-icon.svg";
import "./App.css";

const SERVICES = ["Gmail", "Facebook", "Apple ID"];
const MAX_SELECTED = 4;

type View = "profiles" | "proxies" | "queue";

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
    services: ["Gmail"],
    tags: [],
    notes: "",
  });
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggleService = (service: string) => {
    setForm((current) => ({
      ...current,
      services: current.services.includes(service)
        ? current.services.filter((item) => item !== service)
        : [...current.services, service],
    }));
  };

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

        <div className="field-block">
          <span className="field-label">Services</span>
          <div className="service-picker">
            {SERVICES.map((service) => (
              <button
                type="button"
                key={service}
                className={form.services.includes(service) ? "chip active" : "chip"}
                onClick={() => toggleService(service)}
              >
                {service}
              </button>
            ))}
          </div>
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
  const [view, setView] = useState<View>("profiles");
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
      ] = await Promise.all([
        listProfiles(),
        listWorkspaces(),
        getSystemInfo(),
        getProxyPoolState(),
        getSchedulerState(),
        listGenerationJobs(),
      ]);
      setProfiles(nextProfiles);
      setWorkspaces(nextWorkspaces);
      setSystem(nextSystem);
      setProxyPool(nextProxyPool);
      setScheduler(nextScheduler);
      setGenerationJobs(nextJobs);
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
          ...profile.services,
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
    ["starting", "generating", "recovering"].includes(job.status),
  ).length;
  const completedJobs = generationJobs.filter((job) => job.status === "completed").length;
  const failedJobs = generationJobs.filter((job) => job.status === "failed").length;

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

          <div className="nav-caption">WORKSPACES</div>
          {workspaces.length === 0 ? (
            <p className="sidebar-empty">
              Select profiles and save your first workspace.
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
                  onClick={() => perform(() => deleteWorkspace(workspace.id))}
                >
                  ×
                </button>
              </div>
            ))
          )}
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
                <span className="eyebrow">LOCAL BROWSER CONTROL</span>
                <h1>Profiles</h1>
                <p>
                  Persistent sessions with optional system-wide rotating proxy pool.
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
              <div className="stat-card system-card">
                <span>Chrome</span>
                <strong>{system?.chromePath ? "Ready" : "Check setup"}</strong>
                <small>
                  {system?.chromePath ? "Executable found" : "Executable not found"}
                </small>
              </div>
            </section>

            <section className="scheduler-card">
              <div className="scheduler-copy">
                <span className="eyebrow">SMART PROFILE POOL</span>
                <h3>{scheduler.enabled ? "Smart Scheduler enabled" : "Smart Scheduler disabled"}</h3>
                <p>
                  Ready profiles are selected by least-recently-used order. Profiles in
                  cooldown, rate limit, quota block, disabled scheduling, or need-login
                  state are skipped automatically.
                </p>
              </div>
              <div className="scheduler-summary">
                <div>
                  <span>Ready</span>
                  <strong>{scheduler.readyProfiles}</strong>
                </div>
                <div>
                  <span>Blocked</span>
                  <strong>{scheduler.blockedProfiles}</strong>
                </div>
                <button
                  className="button secondary scheduler-open"
                  disabled={!scheduler.enabled || scheduler.readyProfiles === 0 || busy}
                  onClick={() =>
                    perform(
                      () => openSmartProfiles(MAX_SELECTED),
                      "Smart Scheduler opened available Ready profiles.",
                    )
                  }
                >
                  ▶ Open Smart
                </button>
                <label className="master-toggle scheduler-toggle" title="Enable Smart Scheduler">
                  <input
                    type="checkbox"
                    checked={scheduler.enabled}
                    disabled={busy}
                    onChange={(event) => void toggleScheduler(event.target.checked)}
                  />
                  <span />
                </label>
              </div>
            </section>

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
                <div className="toolbar-spacer" />
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
                    placeholder="e.g. Facebook Team A"
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
                <span>Services</span>
                <span>Proxy</span>
                <span>Health</span>
                <span>Group</span>
                <span>Status</span>
                <span>Last opened</span>
                <span />
              </div>

              <div className="profile-list">
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

                        <div className="services">
                          {profile.services.length ? (
                            profile.services.map((service) => (
                              <span className="service-badge" key={service}>
                                {service}
                              </span>
                            ))
                          ) : (
                            <span className="muted">—</span>
                          )}
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
                          {!profile.isRunning &&
                            ["unknown", "needs_login"].includes(
                              profile.operational.availability,
                            ) && (
                              <button
                                className="health-inline-action"
                                disabled={busy}
                                onClick={() => void markSessionHealthy(profile)}
                              >
                                Mark OK
                              </button>
                            )}
                          {!profile.isRunning &&
                            ["cooldown", "rate_limited", "quota_blocked"].includes(
                              profile.operational.availability,
                            ) && (
                              <button
                                className="health-inline-action"
                                disabled={busy}
                                onClick={() => void clearProfileBlocks(profile)}
                              >
                                Clear
                              </button>
                            )}
                          {!profile.isRunning &&
                            profile.operational.availability === "disabled" && (
                              <button
                                className="health-inline-action"
                                disabled={busy}
                                onClick={() =>
                                  perform(
                                    () =>
                                      updateProfileOperationalState(profile.id, {
                                        schedulingEnabled: true,
                                      }),
                                    `${profile.name} scheduling enabled.`,
                                  )
                                }
                              >
                                Enable
                              </button>
                            )}
                          {!profile.isRunning &&
                            profile.operational.availability === "ready" && (
                              <button
                                className="health-inline-action health-warning-action"
                                disabled={busy}
                                onClick={() => void markNeedsLogin(profile)}
                              >
                                Need login
                              </button>
                            )}
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
                          <button
                            className="dots-button"
                            title="Remove manager entry"
                            onClick={() =>
                              perform(
                                () => deleteProfile(profile.id),
                                "Profile entry removed. Session data was kept on disk.",
                              )
                            }
                          >
                            ⋯
                          </button>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </section>

            <footer className="data-path">
              Session data stays on this PC ·{" "}
              {system?.dataDir ?? "Loading data path…"}
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
                <span className={proxyPool.enabled ? "pool-badge on" : "pool-badge"}>
                  {proxyPool.enabled ? "SYSTEM ON" : "SYSTEM OFF"}
                </span>
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
                            onClick={() =>
                              perform(
                                () => deleteProxyPoolItem(item.id),
                                `${item.name} removed from Proxy Pool.`,
                              )
                            }
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
                  Persistent jobs survive app restarts and are ready for the Seedance
                  execution adapter.
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

            <section className="queue-foundation-card">
              <div>
                <span className="eyebrow">PERSISTENT ORCHESTRATION</span>
                <h3>Queue foundation active</h3>
                <p>
                  Jobs are stored in SQLite. If the app restarts while a future worker
                  is starting or generating, those jobs return as Recovering instead of
                  disappearing. Automatic Seedance submission/polling is not connected
                  yet.
                </p>
              </div>
              <div className="queue-ready-chip">RECOVERY READY</div>
            </section>

            <section className="stats-grid queue-stats">
              <div className="stat-card">
                <span>Queued</span>
                <strong>{queuedJobs}</strong>
                <small>Waiting for execution</small>
              </div>
              <div className="stat-card">
                <span>Active / Recovering</span>
                <strong>{activeJobs}</strong>
                <small>Worker-owned jobs</small>
              </div>
              <div className="stat-card">
                <span>Completed</span>
                <strong>{completedJobs}</strong>
                <small>Finished generations</small>
              </div>
              <div className="stat-card">
                <span>Failed</span>
                <strong>{failedJobs}</strong>
                <small>Needs review or retry</small>
              </div>
            </section>

            {showJobForm && (
              <form className="queue-create-card" onSubmit={submitGenerationJob}>
                <div className="queue-create-heading">
                  <div>
                    <strong>Queue Seedance job</strong>
                    <span>
                      This creates a persistent job record. The generation worker will
                      be connected in the next integration phase.
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
                      <option value={5}>5s</option>
                      <option value={10}>10s</option>
                      <option value={15}>15s</option>
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
              <div className="queue-panel-head">
                <div>
                  <strong>Generation jobs</strong>
                  <span>{generationJobs.length} total persistent job(s)</span>
                </div>
              </div>

              {generationJobs.length === 0 ? (
                <div className="empty-state queue-empty">
                  <div className="empty-icon">
                    <img src={seedanceLogo} alt="" aria-hidden="true" />
                  </div>
                  <h3>No generation jobs yet</h3>
                  <p>
                    Create a job now to validate the persistent queue workflow before
                    the Seedance execution adapter is connected.
                  </p>
                  <button
                    className="button primary"
                    onClick={() => setShowJobForm(true)}
                  >
                    Create first job
                  </button>
                </div>
              ) : (
                <div className="job-list">
                  {generationJobs.map((job) => {
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
                            <span className="job-result-ready">Result ready</span>
                          )}
                          <button
                            className="mini-button danger"
                            disabled={busy || terminal}
                            onClick={() =>
                              perform(
                                () => cancelGenerationJob(job.id),
                                "Generation job cancelled.",
                              )
                            }
                          >
                            Cancel
                          </button>
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
