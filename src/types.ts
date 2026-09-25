export type ProxySettings = {
  enabled: boolean;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  authUsername: string | null;
  rotationMode: "sticky" | "rotate_on_launch" | "manual";
  rotationUrl: string | null;
  lastIp: string | null;
  health: "disabled" | "unchecked" | "healthy" | "offline";
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
};

export type ProxySettingsInput = Pick<
  ProxySettings,
  | "enabled"
  | "protocol"
  | "host"
  | "port"
  | "authUsername"
  | "rotationMode"
  | "rotationUrl"
>;

export type ProxyCheckResult = {
  reachable: boolean;
  publicIp: string | null;
  latencyMs: number | null;
  checkedAt: string;
  message: string;
};

export type ProxyPoolItem = {
  id: string;
  name: string;
  enabled: boolean;
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  authUsername: string | null;
  rotationUrl: string | null;
  lastIp: string | null;
  health: "unchecked" | "healthy" | "offline";
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProxyPoolItemInput = Pick<
  ProxyPoolItem,
  "name" | "enabled" | "protocol" | "host" | "port" | "authUsername" | "rotationUrl"
>;

export type ProxyPoolState = {
  enabled: boolean;
  items: ProxyPoolItem[];
};

export type ActiveProxyAssignment = {
  proxyId: string;
  proxyName: string;
  endpoint: string;
  publicIp: string | null;
  assignedAt: string;
};

export type ProfileAvailability =
  | "ready"
  | "unknown"
  | "disabled"
  | "needs_login"
  | "cooldown"
  | "rate_limited"
  | "quota_blocked";

export type ProfileOperationalState = {
  schedulingEnabled: boolean;
  sessionStatus: "unknown" | "healthy" | "needs_login";
  loginCheckedAt: string | null;
  cooldownUntil: string | null;
  rateLimitedUntil: string | null;
  quotaBlockedUntil: string | null;
  creditBalance: number | null;
  usedToday: number;
  remaining: number | null;
  lastUsedAt: string | null;
  availability: ProfileAvailability;
  availabilityReason: string | null;
};

export type UpdateProfileOperationalStateInput = Partial<
  Pick<
    ProfileOperationalState,
    | "schedulingEnabled"
    | "sessionStatus"
    | "loginCheckedAt"
    | "cooldownUntil"
    | "rateLimitedUntil"
    | "quotaBlockedUntil"
    | "creditBalance"
    | "usedToday"
    | "remaining"
    | "lastUsedAt"
  >
>;

export type BrowserProfile = {
  id: string;
  name: string;
  email: string | null;
  groupName: string | null;
  services: string[];
  tags: string[];
  notes: string | null;
  profilePath: string;
  proxy: ProxySettings;
  activeProxy: ActiveProxyAssignment | null;
  operational: ProfileOperationalState;
  isRunning: boolean;
  pid: number | null;
  lastOpenedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SchedulerState = {
  enabled: boolean;
  readyProfiles: number;
  blockedProfiles: number;
};

export type GenerationJobStatus =
  | "queued"
  | "assigned"
  | "starting"
  | "generating"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled";

export type GenerationJob = {
  id: string;
  prompt: string;
  model: string;
  durationSeconds: number;
  ratio: string;
  status: GenerationJobStatus;
  profileId: string | null;
  proxyId: string | null;
  externalTaskId: string | null;
  resultUrl: string | null;
  failureCode: string | null;
  errorMessage: string | null;
  deadlineAt: string | null;
  lastPollAt: string | null;
  progressPercent: number;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export type CreateGenerationJobInput = {
  prompt: string;
  model?: string | null;
  durationSeconds?: number | null;
  ratio?: string | null;
};

export type UpdateGenerationJobInput = Partial<
  Pick<
    GenerationJob,
    | "status"
    | "profileId"
    | "proxyId"
    | "externalTaskId"
    | "resultUrl"
    | "failureCode"
    | "errorMessage"
    | "deadlineAt"
    | "lastPollAt"
  >
>;

export type LocalApiState = {
  enabled: boolean;
  running: boolean;
  port: number;
  baseUrl: string;
  apiKeyPreview: string;
};

export type WorkerState = {
  enabled: boolean;
  running: boolean;
  mode: string;
  maxConcurrentJobs: number;
  pollIntervalMs: number;
  activeAssignments: number;
  queuedJobs: number;
  lastTickAt: string | null;
  lastError: string | null;
};

export type Workspace = {
  id: string;
  name: string;
  profileIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type SystemInfo = {
  chromePath: string | null;
  dataDir: string;
  maxSimultaneousProfiles: number;
};

export type CreateProfileInput = {
  name: string;
  email?: string | null;
  groupName?: string | null;
  services: string[];
  tags: string[];
  notes?: string | null;
};
