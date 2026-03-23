import { COMMAND_NAME } from "./constants.js";

const TOP_LEVEL_SUBCOMMANDS = [
  "status",
  "refresh",
  "review",
  "end-review",
  "switch",
  "ready",
  "checks",
  "threads",
  "active",
  "dashboard",
  "workspace",
  "config",
  "help",
];
const REVIEW_SUBCOMMANDS = ["session"];
const END_REVIEW_VALUE_OPTIONS = ["return", "summary", "comments", "queue"];
const CONFIG_SUBCOMMANDS = ["edit", "show", "statusbar", "footer", "coverage", "blockers"];
const STATUSBAR_VALUE_OPTIONS = ["shown", "hidden"];
const COVERAGE_VALUE_OPTIONS = ["shown", "hidden"];
const BLOCKER_VALUE_OPTIONS = ["shown", "hidden"];
const FOOTER_VALUE_OPTIONS = ["diff-prefix", "diff-suffix", "minimal"];

export function parseSubcommand(raw: string): { name: string; rest: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { name: "", rest: "" };

  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) {
    return { name: trimmed.toLowerCase(), rest: "" };
  }

  return {
    name: trimmed.slice(0, spaceIndex).toLowerCase(),
    rest: trimmed.slice(spaceIndex + 1).trim(),
  };
}

export function buildArgumentCompletions(
  rawPrefix: string
): { value: string; label: string }[] | null {
  const normalizedPrefix = rawPrefix.trimStart().toLowerCase();
  const endsWithSpace = /\s$/.test(rawPrefix);
  const { name } = parseSubcommand(normalizedPrefix);

  if (!name) {
    return toCompletionItems(TOP_LEVEL_SUBCOMMANDS);
  }

  if (name === "config") {
    return buildConfigCompletions(normalizedPrefix, endsWithSpace);
  }

  if (name === "review") {
    return buildReviewCompletions(normalizedPrefix, endsWithSpace);
  }

  if (name === "end-review") {
    return buildEndReviewCompletions(normalizedPrefix, endsWithSpace);
  }

  return toCompletionItems(filterMatches(TOP_LEVEL_SUBCOMMANDS, normalizedPrefix));
}

export function buildHelpText(): string {
  return [
    `/${COMMAND_NAME}           Open the PR menu`,
    `/${COMMAND_NAME} status [ref|url]`,
    `/${COMMAND_NAME} review [ref|url] [--extra <notes>]`,
    `/${COMMAND_NAME} switch <ref|url>`,
    `/${COMMAND_NAME} active`,
    `/${COMMAND_NAME} dashboard`,
    `/${COMMAND_NAME} config`,
    "",
    "More:",
    `/${COMMAND_NAME} ready [ref|url]`,
    `/${COMMAND_NAME} checks [ref|url]`,
    `/${COMMAND_NAME} threads [ref|url]`,
    `/${COMMAND_NAME} review session [ref|url] [--extra <notes>]`,
    `/${COMMAND_NAME} end-review [return|summary|comments|queue]`,
    `/${COMMAND_NAME} workspace`,
    `/${COMMAND_NAME} refresh`,
    `/${COMMAND_NAME} config show`,
    `/${COMMAND_NAME} config edit`,
    `/${COMMAND_NAME} config statusbar [shown|hidden]`,
    `/${COMMAND_NAME} config footer [diff-prefix|diff-suffix|minimal]`,
    `/${COMMAND_NAME} config coverage [shown|hidden]`,
    `/${COMMAND_NAME} config blockers [shown|hidden]`,
  ].join("\n");
}

function buildConfigCompletions(
  normalizedPrefix: string,
  endsWithSpace: boolean
): { value: string; label: string }[] | null {
  const configInput = normalizedPrefix.slice("config".length).trimStart();
  if (!configInput) {
    return toCompletionItems(CONFIG_SUBCOMMANDS.map((subcommand) => `config ${subcommand}`));
  }

  const { name: configName, rest: configRest } = parseSubcommand(configInput);
  if (!configName) {
    return toCompletionItems(CONFIG_SUBCOMMANDS.map((subcommand) => `config ${subcommand}`));
  }

  if (!configRest && !endsWithSpace) {
    return toCompletionItems(
      filterMatches(CONFIG_SUBCOMMANDS, configName).map((subcommand) => `config ${subcommand}`)
    );
  }

  const values = getConfigValueOptions(configName);
  if (!values) {
    return null;
  }

  return toCompletionItems(
    filterMatches(values, endsWithSpace ? "" : configRest).map(
      (value) => `config ${configName} ${value}`
    )
  );
}

function buildReviewCompletions(
  normalizedPrefix: string,
  endsWithSpace: boolean
): { value: string; label: string }[] | null {
  const reviewInput = normalizedPrefix.slice("review".length).trimStart();
  if (!reviewInput) {
    return toCompletionItems(REVIEW_SUBCOMMANDS.map((subcommand) => `review ${subcommand}`));
  }

  const { name: reviewName, rest } = parseSubcommand(reviewInput);
  if (!reviewName) {
    return toCompletionItems(REVIEW_SUBCOMMANDS.map((subcommand) => `review ${subcommand}`));
  }

  if (!rest && !endsWithSpace) {
    return toCompletionItems(
      filterMatches(REVIEW_SUBCOMMANDS, reviewName).map((subcommand) => `review ${subcommand}`)
    );
  }

  return null;
}

function buildEndReviewCompletions(
  normalizedPrefix: string,
  endsWithSpace: boolean
): { value: string; label: string }[] | null {
  const endReviewInput = normalizedPrefix.slice("end-review".length).trimStart();
  if (!endReviewInput && !endsWithSpace) {
    return toCompletionItems(filterMatches(TOP_LEVEL_SUBCOMMANDS, normalizedPrefix));
  }

  return toCompletionItems(
    filterMatches(END_REVIEW_VALUE_OPTIONS, endsWithSpace ? "" : endReviewInput).map(
      (value) => `end-review ${value}`
    )
  );
}

function filterMatches(options: string[], prefix: string): string[] {
  if (!prefix) return options;
  return options.filter((option) => option.startsWith(prefix));
}

function getConfigValueOptions(configName: string): string[] | undefined {
  switch (configName) {
    case "statusbar":
      return STATUSBAR_VALUE_OPTIONS;
    case "footer":
      return FOOTER_VALUE_OPTIONS;
    case "coverage":
      return COVERAGE_VALUE_OPTIONS;
    case "blockers":
      return BLOCKER_VALUE_OPTIONS;
    default:
      return undefined;
  }
}

function toCompletionItems(values: string[]): { value: string; label: string }[] | null {
  return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
}
