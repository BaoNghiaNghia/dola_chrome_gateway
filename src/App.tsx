import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  closeProfile,
  createProfile,
  createWorkspace,
  deleteProfile,
  deleteWorkspace,
  getSystemInfo,
  listProfiles,
  listWorkspaces,
  openProfiles,
  rotateProfileProxy,
  testProfileProxy,
  updateProfileProxy,
} from "./api";
import type {
  BrowserProfile,
  CreateProfileInput,
  ProxyCheckResult,
  ProxySettings,
  ProxySettingsInput,
  SystemInfo,
  Workspace,
} from "./types";
import "./App.css";

const SERVICES = ["Gmail", "Facebook", "Apple ID"];
const MAX_SELECTED = 4;

const DEFAULT_PROXY: ProxySettingsInput = {
  enabled: false,
  protocol: "http",
  host: "",
  port: 0,
  authUsername: null,
  rotationMode: "sticky",
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

function proxyInput(proxy: ProxySettings): ProxySettingsInput {
  return {
    enabled: proxy.enabled,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    authUsername: proxy.authUsername,
    rotationMode: proxy.rotationMode,
    rotationUrl: proxy.rotationUrl,
  };
}

function ProxyFields({
  value,
  onChange,
}: {
  value: ProxySettingsInput;
  onChange: (next: ProxySettingsInput) => void;
}) {
  const set = <K extends keyof ProxySettingsInput>(
    key: K,
    next: ProxySettingsInput[K],
  ) => onChange({ ...value, [key]: next });

  return (
    <div className="proxy-fields">
      <label className="toggle-row">
        <span>
          <strong>Use proxy</strong>
          <small>Proxy is only attached to Chrome when this is enabled.</small>
        </span>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => set("enabled", event.target.checked)}
        />
      </label>

      {value.enabled && (
        <>
          <div className="form-grid proxy-grid">
            <label>
              Protocol
              <select
                value={value.protocol}
                onChange={(event) =>
                  set("protocol", event.target.value as ProxySettingsInput["protocol"])
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
                value={value.host}
                onChange={(event) => set("host", event.target.value)}
                placeholder="gateway.proxy.com"
              />
            </label>
            <label>
              Port
              <input
                type="number"
                min={1}
                max={65535}
                value={value.port || ""}
                onChange={(event) => set("port", Number(event.target.value) || 0)}
                placeholder="8000"
              />
            </label>
            <label>
              Auth username
              <input
                value={value.authUsername ?? ""}
                onChange={(event) =>
                  set("authUsername", event.target.value.trim() || null)
                }
                placeholder="Optional"
              />
            </label>
          </div>

          <div className="field-block">
            <span className="field-label">Rotation mode</span>
            <div className="rotation-picker">
              {[
                ["sticky", "Sticky"],
                ["rotate_on_launch", "Rotate on launch"],
                ["manual", "Manual rotate"],
              ].map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={value.rotationMode === mode ? "chip active" : "chip"}
                  onClick={() =>
                    set(
                      "rotationMode",
                      mode as ProxySettingsInput["rotationMode"],
                    )
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {(value.rotationMode === "rotate_on_launch" ||
            value.rotationMode === "manual") && (
            <label>
              Rotation URL
              <input
                value={value.rotationUrl ?? ""}
                onChange={(event) =>
                  set("rotationUrl", event.target.value.trim() || null)
                }
                placeholder="https://provider.example/rotate/..."
              />
              <small className="field-help">
                Called only before launch or when you explicitly press Rotate.
              </small>
            </label>
          )}

          {value.authUsername && (
            <div className="proxy-note">
              Proxy password is intentionally not stored in SQLite. Chrome may ask for
              proxy credentials when the upstream requires authentication.
            </div>
          )}
        </>
      )}
    </div>
  );
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
    proxy: { ...DEFAULT_PROXY },
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
        className="modal-card modal-card-wide"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">NEW PROFILE</span>
            <h2>Create Chrome profile</h2>
            <p>Session data stays isolated in a dedicated Chrome user-data directory.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
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

        <div className="proxy-section">
          <div className="section-title">
            <span>Network / Proxy</span>
            <small>Optional · OFF by default</small>
          </div>
          <ProxyFields
            value={form.proxy ?? DEFAULT_PROXY}
            onChange={(proxy) => setForm({ ...form, proxy })}
          />
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

function ProxyModal({
  profile,
  onClose,
  onChanged,
}: {
  profile: BrowserProfile;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [form, setForm] = useState<ProxySettingsInput>(proxyInput(profile.proxy));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProxyCheckResult | null>(null);
  const [error, setError] = useState("");

  async function persist() {
    await updateProfileProxy(profile.id, form);
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      await persist();
      await onChanged();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      await persist();
      const check = await testProfileProxy(profile.id);
      setResult(check);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      await persist();
      const check = await rotateProfileProxy(profile.id);
      setResult(check);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal-card proxy-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">PROFILE NETWORK</span>
            <h2>{profile.name}</h2>
            <p>
              Proxy settings remain unchanged for the full lifetime of an open Chrome
              session.
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {profile.isRunning && (
          <div className="proxy-lock-note">
            This profile is running. Close Chrome before changing or rotating its proxy.
          </div>
        )}

        <ProxyFields value={form} onChange={setForm} />

        <div className="proxy-health-card">
          <div>
            <span>Current health</span>
            <strong className={`health-${profile.proxy.health}`}>
              {profile.proxy.enabled ? profile.proxy.health : "disabled"}
            </strong>
          </div>
          <div>
            <span>Last IP</span>
            <strong>{profile.proxy.lastIp || "—"}</strong>
          </div>
          <div>
            <span>Latency</span>
            <strong>
              {profile.proxy.lastLatencyMs != null
                ? `${profile.proxy.lastLatencyMs} ms`
                : "—"}
            </strong>
          </div>
        </div>

        {result && <div className="banner success">{result.message}</div>}
        {error && <div className="inline-error">{error}</div>}

        <div className="modal-actions proxy-actions">
          <div>
            <button
              type="button"
              className="button secondary"
              disabled={busy || profile.isRunning || !form.enabled}
              onClick={() => void test()}
            >
              Test proxy
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={
                busy ||
                profile.isRunning ||
                !form.enabled ||
                !form.rotationUrl
              }
              onClick={() => void rotate()}
            >
              Rotate now
            </button>
          </div>
          <div>
            <button type="button" className="button secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || profile.isRunning}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save proxy"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All");
  const [showCreate, setShowCreate] = useState(false);
  const [proxyProfileId, setProxyProfileId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);

  async function refresh() {
    try {
      const [nextProfiles, nextWorkspaces, nextSystem] = await Promise.all([
        listProfiles(),
        listWorkspaces(),
        getSystemInfo(),
      ]);
      setProfiles(nextProfiles);
      setWorkspaces(nextWorkspaces);
      setSystem(nextSystem);
      setSelected((current) =>
        current.filter((id) => nextProfiles.some((profile) => profile.id === id)),
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
          profiles.map((profile) => profile.groupName).filter(Boolean) as string[],
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
          profile.proxy.host,
          profile.proxy.lastIp,
          ...profile.tags,
          ...profile.services,
        ]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(needle));
      return groupMatch && searchMatch;
    });
  }, [profiles, query, group]);

  const runningCount = profiles.filter((profile) => profile.isRunning).length;
  const proxyCount = profiles.filter((profile) => profile.proxy.enabled).length;
  const proxyProfile =
    profiles.find((profile) => profile.id === proxyProfileId) ?? null;

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

  function proxyLabel(profile: BrowserProfile) {
    if (!profile.proxy.enabled) return "OFF";
    if (profile.proxy.health === "healthy") return profile.proxy.lastIp || "Healthy";
    if (profile.proxy.health === "offline") return "Offline";
    return "Unchecked";
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">D</div>
          <div>
            <strong>Dola Gateway</strong>
            <span>Chrome Profile Manager</span>
          </div>
        </div>

        <nav>
          <button className="nav-item active">
            <span>◫</span>
            Profiles
            <b>{profiles.length}</b>
          </button>
          <div className="nav-caption">WORKSPACES</div>
          {workspaces.length === 0 ? (
            <p className="sidebar-empty">Select profiles and save your first workspace.</p>
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
          <div className={system?.chromePath ? "status-dot online" : "status-dot"} />
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
        <header className="topbar">
          <div>
            <span className="eyebrow">LOCAL BROWSER CONTROL</span>
            <h1>Profiles</h1>
            <p>Persistent sessions with optional per-profile rotating proxy.</p>
          </div>
          <button className="button primary" onClick={() => setShowCreate(true)}>
            <span className="plus">＋</span> New profile
          </button>
        </header>

        {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}

        <section className="stats-grid">
          <div className="stat-card">
            <span>Total profiles</span>
            <strong>{profiles.length}</strong>
            <small>Persistent Chrome sessions</small>
          </div>
          <div className="stat-card">
            <span>Running now</span>
            <strong>{runningCount}</strong>
            <small>Maximum {system?.maxSimultaneousProfiles ?? 4} at once</small>
          </div>
          <div className="stat-card">
            <span>Proxy enabled</span>
            <strong>{proxyCount}</strong>
            <small>Fail-closed before Chrome launch</small>
          </div>
          <div className="stat-card system-card">
            <span>Chrome</span>
            <strong>{system?.chromePath ? "Ready" : "Check setup"}</strong>
            <small title={system?.chromePath ?? undefined}>
              {system?.chromePath ? "Executable found" : "Executable not found"}
            </small>
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
            <select value={group} onChange={(event) => setGroup(event.target.value)}>
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
                  `${selected.length} profile(s) opened.`,
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
            <span>Group</span>
            <span>Status</span>
            <span>Last opened</span>
            <span />
          </div>

          <div className="profile-list">
            {visibleProfiles.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">◫</div>
                <h3>{profiles.length ? "No matching profiles" : "Create your first profile"}</h3>
                <p>
                  {profiles.length
                    ? "Try another search or group."
                    : "Each profile gets its own Chrome user-data directory so sessions never mix."}
                </p>
                {!profiles.length && (
                  <button className="button primary" onClick={() => setShowCreate(true)}>
                    Create profile
                  </button>
                )}
              </div>
            ) : (
              visibleProfiles.map((profile) => {
                const checked = selected.includes(profile.id);
                return (
                  <article
                    className={checked ? "profile-row selected" : "profile-row"}
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

                    <button
                      className={`proxy-pill proxy-${profile.proxy.enabled ? profile.proxy.health : "disabled"}`}
                      onClick={() => setProxyProfileId(profile.id)}
                      title={
                        profile.proxy.enabled
                          ? `${profile.proxy.protocol}://${profile.proxy.host}:${profile.proxy.port}`
                          : "Proxy is disabled"
                      }
                    >
                      <i />
                      {proxyLabel(profile)}
                    </button>

                    <span>{profile.groupName || "—"}</span>

                    <span className={profile.isRunning ? "run-status running" : "run-status"}>
                      <i />
                      {profile.isRunning ? "Running" : "Stopped"}
                    </span>

                    <span className="muted">{relativeTime(profile.lastOpenedAt)}</span>

                    <div className="row-actions">
                      {profile.isRunning ? (
                        <button
                          className="mini-button danger"
                          disabled={busy}
                          onClick={() =>
                            perform(() => closeProfile(profile.id), "Chrome profile closed.")
                          }
                        >
                          Stop
                        </button>
                      ) : (
                        <button
                          className="mini-button"
                          disabled={busy}
                          onClick={() =>
                            perform(() => openProfiles([profile.id]), "Chrome profile opened.")
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
          Session data stays on this PC · {system?.dataDir ?? "Loading data path…"}
        </footer>
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

      {proxyProfile && (
        <ProxyModal
          profile={proxyProfile}
          onClose={() => setProxyProfileId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

export default App;
