import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CONFIG_FILENAME,
  DEFAULT_IGNORED_BRANCHES,
} from "./constants.js";
import type {
  ConfigActionResult,
  PrCompanionConfig,
  ProviderConfig,
  ProviderKind,
  StatusBarStyle,
} from "./types.js";

interface RawProviderConfig {
  kind?: unknown;
  ignoredBranches?: unknown;
  showNoPrState?: unknown;
  hosts?: unknown;
}

interface RawConfig {
  cacheTtlMs?: unknown;
  showStatusBar?: unknown;
  statusBarStyle?: unknown;
  showCoverageInStatusBar?: unknown;
  showBlockerHintInStatusBar?: unknown;
  showUpdatedAgeInPickers?: unknown;
  stalePrDays?: unknown;
  workspaceRoots?: unknown;
  sharedReviewInstructions?: unknown;
  reviewSessionMode?: unknown;
  providers?: unknown;
}

export function getConfigPath(): string {
  const envPath = process.env.PI_PR_COMPANION_CONFIG;
  if (envPath && envPath.trim()) {
    return normalizePath(envPath);
  }

  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
    ? normalizePath(process.env.PI_CODING_AGENT_DIR)
    : path.join(os.homedir(), ".pi/agent");
  return path.join(agentDir, DEFAULT_CONFIG_FILENAME);
}

export async function loadConfig(): Promise<PrCompanionConfig> {
  const configPath = getConfigPath();

  try {
    const rawText = await readFile(configPath, "utf8");
    return normalizeConfig(JSON.parse(rawText) as RawConfig);
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT") {
      return defaultConfig();
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${configPath}: ${error.message}`);
    }
    throw error;
  }
}

export async function saveConfig(config: PrCompanionConfig): Promise<void> {
  const configPath = getConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${serializeConfig(config)}\n`, "utf8");
}

export function serializeConfig(config: PrCompanionConfig): string {
  return JSON.stringify(config, null, 2);
}

export function defaultConfig(): PrCompanionConfig {
  return {
    cacheTtlMs: DEFAULT_CACHE_TTL_MS,
    showStatusBar: true,
    statusBarStyle: "diff-prefix",
    showCoverageInStatusBar: false,
    showBlockerHintInStatusBar: true,
    showUpdatedAgeInPickers: true,
    stalePrDays: 7,
    workspaceRoots: [],
    sharedReviewInstructions: "",
    reviewSessionMode: false,
    providers: [createDefaultProvider("gitlab"), createDefaultProvider("github")],
  };
}

export function normalizeConfig(raw: RawConfig): PrCompanionConfig {
  const defaults = defaultConfig();
  const providers = Array.isArray(raw.providers)
    ? ensureProviderDefaults(
        raw.providers
          .map((provider) => normalizeProvider(provider as RawProviderConfig))
          .filter((provider): provider is ProviderConfig => provider !== null)
      )
    : defaults.providers;

  return {
    cacheTtlMs:
      typeof raw.cacheTtlMs === "number" && Number.isFinite(raw.cacheTtlMs) && raw.cacheTtlMs > 0
        ? raw.cacheTtlMs
        : defaults.cacheTtlMs,
    showStatusBar:
      typeof raw.showStatusBar === "boolean" ? raw.showStatusBar : defaults.showStatusBar,
    statusBarStyle: normalizeStatusBarStyle(raw.statusBarStyle, defaults.statusBarStyle),
    showCoverageInStatusBar:
      typeof raw.showCoverageInStatusBar === "boolean"
        ? raw.showCoverageInStatusBar
        : defaults.showCoverageInStatusBar,
    showBlockerHintInStatusBar:
      typeof raw.showBlockerHintInStatusBar === "boolean"
        ? raw.showBlockerHintInStatusBar
        : defaults.showBlockerHintInStatusBar,
    showUpdatedAgeInPickers:
      typeof raw.showUpdatedAgeInPickers === "boolean"
        ? raw.showUpdatedAgeInPickers
        : defaults.showUpdatedAgeInPickers,
    stalePrDays:
      typeof raw.stalePrDays === "number" && Number.isFinite(raw.stalePrDays) && raw.stalePrDays > 0
        ? Math.floor(raw.stalePrDays)
        : defaults.stalePrDays,
    workspaceRoots: normalizePaths(raw.workspaceRoots),
    sharedReviewInstructions:
      typeof raw.sharedReviewInstructions === "string" ? raw.sharedReviewInstructions.trim() : "",
    reviewSessionMode:
      typeof raw.reviewSessionMode === "boolean"
        ? raw.reviewSessionMode
        : defaults.reviewSessionMode,
    providers: providers.length > 0 ? providers : defaults.providers,
  };
}

export function getProviderConfig(
  config: PrCompanionConfig,
  kind: ProviderKind
): ProviderConfig | undefined {
  return config.providers.find((provider) => provider.kind === kind);
}

export function setShowStatusBar(
  config: PrCompanionConfig,
  showStatusBar: boolean
): ConfigActionResult {
  if (config.showStatusBar === showStatusBar) {
    return { config, changed: false };
  }

  return {
    config: { ...config, showStatusBar },
    changed: true,
  };
}

export function setStatusBarStyle(
  config: PrCompanionConfig,
  statusBarStyle: StatusBarStyle
): ConfigActionResult {
  if (config.statusBarStyle === statusBarStyle) {
    return { config, changed: false };
  }

  return {
    config: { ...config, statusBarStyle },
    changed: true,
  };
}

export function setShowCoverageInStatusBar(
  config: PrCompanionConfig,
  showCoverageInStatusBar: boolean
): ConfigActionResult {
  if (config.showCoverageInStatusBar === showCoverageInStatusBar) {
    return { config, changed: false };
  }

  return {
    config: { ...config, showCoverageInStatusBar },
    changed: true,
  };
}

export function setShowBlockerHintInStatusBar(
  config: PrCompanionConfig,
  showBlockerHintInStatusBar: boolean
): ConfigActionResult {
  if (config.showBlockerHintInStatusBar === showBlockerHintInStatusBar) {
    return { config, changed: false };
  }

  return {
    config: { ...config, showBlockerHintInStatusBar },
    changed: true,
  };
}

export function isIgnoredBranch(provider: ProviderConfig, branch: string): boolean {
  return provider.ignoredBranches.includes(branch);
}

export function isHostEnabled(provider: ProviderConfig, host: string): boolean {
  const hostEntries = Object.entries(provider.hosts);
  if (hostEntries.length === 0) return true;

  const hostConfig = provider.hosts[host];
  return hostConfig?.enabled !== false;
}

export function normalizePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }

  if (input.startsWith("~/")) {
    return path.resolve(path.join(os.homedir(), input.slice(2)));
  }

  return path.resolve(input);
}

function createDefaultProvider(kind: ProviderKind): ProviderConfig {
  return {
    kind,
    ignoredBranches: [...DEFAULT_IGNORED_BRANCHES],
    showNoPrState: false,
    hosts: {},
  };
}

function normalizeProvider(raw: RawProviderConfig): ProviderConfig | null {
  if (raw.kind !== "gitlab" && raw.kind !== "github") return null;

  return {
    kind: raw.kind,
    ignoredBranches: normalizeIgnoredBranches(raw.ignoredBranches),
    showNoPrState: typeof raw.showNoPrState === "boolean" ? raw.showNoPrState : false,
    hosts: normalizeHosts(raw.hosts),
  };
}

function ensureProviderDefaults(providers: ProviderConfig[]): ProviderConfig[] {
  const kinds = new Set(providers.map((provider) => provider.kind));
  const completeProviders = [...providers];
  const order: Record<ProviderKind, number> = { gitlab: 0, github: 1 };

  if (!kinds.has("gitlab")) {
    completeProviders.push(createDefaultProvider("gitlab"));
  }
  if (!kinds.has("github")) {
    completeProviders.push(createDefaultProvider("github"));
  }

  return completeProviders.sort((left, right) => order[left.kind] - order[right.kind]);
}

function normalizeIgnoredBranches(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_IGNORED_BRANCHES];

  const branches = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return branches.length > 0 ? branches : [...DEFAULT_IGNORED_BRANCHES];
}

function normalizeHosts(value: unknown): Record<string, { enabled?: boolean }> {
  if (!value || typeof value !== "object") return {};

  const entries = Object.entries(value as Record<string, unknown>);
  const normalizedEntries = entries.flatMap(([host, config]) => {
    const normalizedHost = host.trim();
    if (!normalizedHost) return [];
    if (!config || typeof config !== "object") return [[normalizedHost, {}]] as const;

    const enabled = (config as { enabled?: unknown }).enabled;
    return [[normalizedHost, typeof enabled === "boolean" ? { enabled } : {}]] as const;
  });

  return Object.fromEntries(normalizedEntries);
}

function normalizePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => normalizePath(item.trim()));
}

function normalizeStatusBarStyle(value: unknown, fallback: StatusBarStyle): StatusBarStyle {
  return value === "minimal" || value === "diff-prefix" || value === "diff-suffix"
    ? value
    : fallback;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
