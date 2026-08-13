import http from "http";
import https from "https";
import type { ConnectionConfig } from "./config";
import { requestRemoteOAuthJson } from "./remote-oauth";
import type { CachedSession } from "./session-cache";
import {
  extractLeadingVisionImageFallback,
  stripTrailingImagePlaceholders,
} from "./session-attachment-store";
import {
  dedupeSearchResultsBySession,
  expandRowsToHistory,
  type HistoryItem,
  type RawMessageRow,
  type SearchResult,
  type SessionSummary,
} from "./sessions";
import type { Attachment } from "../shared/attachments";
import { isImageMime, MAX_IMAGE_BYTES } from "../shared/attachments";
import {
  buildCompressionLineageProjection,
  projectCompressionLineages,
  type CompressionLineageRow,
} from "./session-lineage";

export interface RemoteSessionConfig {
  remoteUrl: string;
  apiKey: string;
  /** When set (and not "default"), every dashboard request is scoped to this
   *  profile via `?profile=`. The SSH transport uses ONE unified machine
   *  dashboard for all profiles (see ensureDashboardInner), so per-profile data
   *  correctness comes from this query param rather than a per-profile server. */
  profile?: string;
}

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

interface RemoteRequestOptions {
  method?: HttpMethod;
  body?: unknown;
  timeoutMs?: number;
}

type RemoteRecord = Record<string, unknown>;

function normalizeRemoteDashboardBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("Remote Hermes dashboard URL is not configured.");
  const url = new URL(raw);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.pathname === "/v1" || url.pathname === "/api") {
    url.pathname = "";
  }
  return url.toString().replace(/\/+$/, "");
}

// Exported so every dashboard request — including remote-metadata's /api/status
// probe — shares ONE URL builder and gets the same `?profile=` scoping.
export function dashboardApiUrl(
  config: RemoteSessionConfig,
  path: string,
): string {
  const base = normalizeRemoteDashboardBaseUrl(config.remoteUrl);
  const url = new URL(path, `${base}/`);
  // Scope to the requested profile on the unified machine dashboard, unless the
  // path already carries an explicit profile (e.g. the sessions list uses
  // `profile=all`). "default"/empty needs no param.
  const profile = config.profile?.trim();
  if (profile && profile !== "default" && !url.searchParams.has("profile")) {
    url.searchParams.set("profile", profile);
  }
  return url.toString();
}

export function remoteRequestJson<T>(
  config: RemoteSessionConfig | ConnectionConfig,
  path: string,
  options: RemoteRequestOptions = {},
): Promise<T> {
  if ("mode" in config) {
    if (config.mode !== "remote") {
      throw new Error(
        "Remote dashboard API is available only in direct Remote mode.",
      );
    }
    if (config.remoteAuthMode === "oauth") {
      return requestRemoteOAuthJson(
        dashboardApiUrl(config, path),
        options,
      ) as Promise<T>;
    }
  }

  const token = config.apiKey.trim();
  if (!token)
    throw new Error("Remote Hermes dashboard token is not configured.");

  return new Promise((resolve, reject) => {
    const parsed = new URL(dashboardApiUrl(config, path));
    const client = parsed.protocol === "https:" ? https : http;
    const body =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = client.request(
      parsed,
      {
        method: options.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Hermes-Session-Token": token,
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("error", reject);
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(
              new Error(`${res.statusCode}: ${text || res.statusMessage}`),
            );
            return;
          }
          if (!text) {
            resolve(null as T);
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(
              new Error(
                `Invalid JSON from ${parsed.toString()} (status ${
                  res.statusCode
                }): ${text.slice(0, 200)}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs ?? 15_000, () => {
      req.destroy(
        new Error(
          `Timed out connecting to remote Hermes dashboard after ${
            options.timeoutMs ?? 15_000
          }ms`,
        ),
      );
    });
    if (body) req.write(body);
    req.end();
  });
}

function asRecord(value: unknown): RemoteRecord {
  return value && typeof value === "object" ? (value as RemoteRecord) : {};
}

function asArray(value: unknown): RemoteRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function dataUrlValue(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("data:image/")
    ? value
    : null;
}

function remoteImageName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || "image";
}

function highlightTextMatch(text: string, query: string): string {
  if (!text) return "";
  const terms = [query.trim(), ...query.trim().split(/\s+/)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const term of terms) {
    const index = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
    if (index >= 0) {
      return `${text.slice(0, index)}<<${text.slice(
        index,
        index + term.length,
      )}>>${text.slice(index + term.length)}`;
    }
  }
  return text;
}

function historyItemSearchText(item: HistoryItem): string {
  switch (item.kind) {
    case "user":
    case "assistant":
    case "tool_result":
      return item.content || "";
    case "reasoning":
      return item.text || "";
    case "tool_call":
      return [item.name, item.args].filter(Boolean).join(" ");
  }
}

function attachmentFromRemoteDataUrl(
  dataUrl: string | null,
  filePath: string,
  id: string,
): Attachment | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!match) return null;
  const mime = match[1].toLowerCase();
  if (!isImageMime(mime)) return null;
  const size = Buffer.byteLength(match[2], "base64");
  if (size <= 0 || size > MAX_IMAGE_BYTES) return null;
  return {
    id,
    kind: "image",
    name: remoteImageName(filePath),
    mime,
    size,
    dataUrl: dataUrl || "",
    path: filePath,
  };
}

interface RemoteLineageFields {
  id: string;
  hasEndedAt: boolean;
  parentSessionId?: string;
  endReason?: string;
  modelConfig?: string;
  relationshipType?: string;
}

function lineageFields(row: RemoteRecord): RemoteLineageFields {
  const id = stringValue(row.id, stringValue(row.session_id));
  const parentSessionId = nullableString(
    row.parent_session_id ?? row.parentSessionId,
  );
  const endReason = nullableString(row.end_reason ?? row.endReason);
  const relationshipType = nullableString(
    row.relationship_type ?? row.relationshipType,
  );
  const rawModelConfig = row.model_config ?? row.modelConfig;
  const modelConfig =
    typeof rawModelConfig === "string"
      ? rawModelConfig
      : rawModelConfig && typeof rawModelConfig === "object"
        ? JSON.stringify(rawModelConfig)
        : undefined;
  const hasEndedAt =
    Object.prototype.hasOwnProperty.call(row, "ended_at") ||
    Object.prototype.hasOwnProperty.call(row, "endedAt");
  return {
    id,
    hasEndedAt,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(endReason ? { endReason } : {}),
    ...(modelConfig ? { modelConfig } : {}),
    ...(relationshipType ? { relationshipType } : {}),
  };
}

function normalizeSessionSummary(
  row: RemoteRecord,
): SessionSummary & RemoteLineageFields {
  const id = stringValue(row.id, stringValue(row.session_id));
  const normalized = {
    ...lineageFields(row),
    id,
    source: stringValue(row.source),
    startedAt: numberValue(
      row.started_at,
      numberValue(row.session_started, numberValue(row.last_active)),
    ),
    endedAt: nullableNumber(row.ended_at ?? row.endedAt),
    messageCount: numberValue(row.message_count),
    model: stringValue(row.model),
    title: nullableString(row.title),
    preview: stringValue(row.preview),
  } as SessionSummary & RemoteLineageFields;
  if (Object.prototype.hasOwnProperty.call(row, "archived")) {
    normalized.archived = Boolean(row.archived);
  }
  if (Object.prototype.hasOwnProperty.call(row, "pinned")) {
    normalized.pinned = Boolean(row.pinned);
  }
  if (Object.prototype.hasOwnProperty.call(row, "cwd")) {
    normalized.cwd = nullableString(row.cwd);
  }
  if (Object.prototype.hasOwnProperty.call(row, "last_activity_at")) {
    normalized.lastActive = nullableNumber(row.last_activity_at);
  }
  if (row.is_working === true || row.isWorking === true) {
    normalized.isWorking = true;
    normalized.activityPhase = stringValue(
      row.activity_phase ?? row.activityPhase,
      "running",
    );
    normalized.activityStartedAt = numberValue(
      row.activity_started_at,
      numberValue(row.activityStartedAt),
    );
    normalized.activityHeartbeatAt = numberValue(
      row.activity_heartbeat_at,
      numberValue(row.activityHeartbeatAt),
    );
  }
  return normalized;
}

function sessionsFromResponse(response: unknown): RemoteRecord[] {
  const record = asRecord(response);
  const data = record.data;
  if (Array.isArray(record.sessions)) return asArray(record.sessions);
  if (Array.isArray(data)) return asArray(data);
  return asArray(asRecord(data).sessions);
}

function hasLineageMetadata(rows: readonly RemoteRecord[]): boolean {
  return rows.some((row) =>
    [
      "parent_session_id",
      "parentSessionId",
      "end_reason",
      "endReason",
      "model_config",
      "modelConfig",
      "relationship_type",
      "relationshipType",
    ].some((key) => Object.prototype.hasOwnProperty.call(row, key)),
  );
}

type RemoteSessionEndpoint = "profiles" | "legacy";

interface RemoteSessionListPage {
  response: unknown;
  endpoint: RemoteSessionEndpoint;
}

async function remoteSessionListPage(
  config: RemoteSessionConfig,
  limit: number,
  offset: number,
  endpoint?: RemoteSessionEndpoint,
  includeArchived = false,
): Promise<RemoteSessionListPage> {
  const archiveFilter = includeArchived ? "include" : "exclude";
  const profileEndpoint =
    `/api/profiles/sessions?limit=${limit}&offset=${offset}` +
    `&min_messages=0&archived=${archiveFilter}&order=recent&profile=all`;
  const legacyEndpoint = `/api/sessions?limit=${limit}&offset=${offset}&archived=${archiveFilter}&order=recent`;

  if (endpoint === "profiles") {
    return {
      response: await remoteRequestJson(config, profileEndpoint),
      endpoint,
    };
  }
  if (endpoint === "legacy") {
    return {
      response: await remoteRequestJson(config, legacyEndpoint),
      endpoint,
    };
  }

  try {
    return {
      response: await remoteRequestJson(config, profileEndpoint),
      endpoint: "profiles",
    };
  } catch {
    return {
      response: await remoteRequestJson(config, legacyEndpoint),
      endpoint: "legacy",
    };
  }
}

const REMOTE_LINEAGE_PAGE_SIZE = 200;
const MAX_REMOTE_LINEAGE_PAGES = 100;

async function remoteLineageRows(
  config: RemoteSessionConfig,
  initialEndpoint?: RemoteSessionEndpoint,
  includeArchived = false,
): Promise<RemoteRecord[]> {
  const rows: RemoteRecord[] = [];
  const seenIds = new Set<string>();
  let endpoint = initialEndpoint;

  for (let page = 0; page < MAX_REMOTE_LINEAGE_PAGES; page += 1) {
    const offset = page * REMOTE_LINEAGE_PAGE_SIZE;
    const result = await remoteSessionListPage(
      config,
      REMOTE_LINEAGE_PAGE_SIZE,
      offset,
      endpoint,
      includeArchived,
    );
    endpoint = result.endpoint;
    const pageRows = sessionsFromResponse(result.response);
    let added = 0;
    for (const row of pageRows) {
      const id = stringValue(row.id, stringValue(row.session_id));
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      rows.push(row);
      added += 1;
    }
    if (pageRows.length < REMOTE_LINEAGE_PAGE_SIZE || added === 0) break;
  }

  return rows;
}

async function remoteProjectedRows<T extends CompressionLineageRow>(
  config: RemoteSessionConfig,
  initialPage: RemoteSessionListPage,
  normalize: (row: RemoteRecord) => T,
  limit: number,
  offset: number,
  includeArchived = false,
): Promise<T[]> {
  const initialRows = sessionsFromResponse(initialPage.response);
  // Offset zero without lineage keys is already a complete logical first page.
  // Later physical pages must still scan globally because compressed segments
  // on earlier pages may have consumed the requested logical offset.
  if (offset === 0 && !hasLineageMetadata(initialRows)) {
    return projectCompressionLineages(initialRows.map(normalize));
  }
  try {
    const lineageRows = await remoteLineageRows(
      config,
      initialPage.endpoint,
      includeArchived,
    );
    const initialIds = new Set(
      initialRows
        .map((row) => stringValue(row.id, stringValue(row.session_id)))
        .filter(Boolean),
    );
    if (
      initialIds.size > 0 &&
      !lineageRows.some((row) =>
        initialIds.has(stringValue(row.id, stringValue(row.session_id))),
      )
    ) {
      return projectCompressionLineages(initialRows.map(normalize));
    }
    if (!hasLineageMetadata(lineageRows)) {
      return projectCompressionLineages(initialRows.map(normalize));
    }
    return projectCompressionLineages(lineageRows.map(normalize)).slice(
      offset,
      offset + limit,
    );
  } catch {
    // A partially upgraded endpoint may expose lineage keys on a page while
    // rejecting the wider page size needed for global projection. Keep the
    // initial page rather than mixing rows from a different API generation.
    return projectCompressionLineages(initialRows.map(normalize));
  }
}

export async function remoteListSessions(
  config: RemoteSessionConfig,
  limit = 30,
  offset = 0,
  includeArchived = false,
): Promise<SessionSummary[]> {
  const initialPage = await remoteSessionListPage(
    config,
    limit,
    offset,
    undefined,
    includeArchived,
  );
  const projected = await remoteProjectedRows(
    config,
    initialPage,
    normalizeSessionSummary,
    limit,
    offset,
    includeArchived,
  );
  return projected.map(({ hasEndedAt: _hasEndedAt, ...summary }) => ({
    ...summary,
    source: summary.source || "chat",
  }));
}

export async function remoteListCachedSessions(
  config: RemoteSessionConfig,
  limit = 50,
  offset = 0,
  includeArchived = false,
): Promise<CachedSession[]> {
  const initialPage = await remoteSessionListPage(
    config,
    limit,
    offset,
    undefined,
    includeArchived,
  );
  const projected = await remoteProjectedRows(
    config,
    initialPage,
    normalizeSessionSummary,
    limit,
    offset,
    includeArchived,
  );
  return projected.map((summary) => ({
    id: summary.id,
    title:
      summary.title ??
      (summary.preview.trim()
        ? summary.preview
        : `Session ${summary.id.slice(-6)}`),
    startedAt: summary.startedAt,
    ...(summary.hasEndedAt ? { endedAt: summary.endedAt } : {}),
    source: summary.source,
    messageCount: summary.messageCount,
    model: summary.model,
    contextFolder: null,
    ...(summary.cwd !== undefined ? { cwd: summary.cwd ?? null } : {}),
    ...(summary.archived !== undefined ? { archived: summary.archived } : {}),
    ...(summary.pinned !== undefined ? { pinned: summary.pinned } : {}),
    ...(summary.parentSessionId
      ? { parentSessionId: summary.parentSessionId }
      : {}),
    ...(summary.relationshipType
      ? { relationshipType: summary.relationshipType }
      : {}),
    ...(summary.endReason ? { endReason: summary.endReason } : {}),
    ...(summary.modelConfig ? { modelConfig: summary.modelConfig } : {}),
    ...(summary.lineageRootId ? { lineageRootId: summary.lineageRootId } : {}),
    ...(summary.compressionSegmentCount
      ? { compressionSegmentCount: summary.compressionSegmentCount }
      : {}),
    ...(summary.isWorking
      ? {
          isWorking: true,
          activityPhase: summary.activityPhase,
          activityStartedAt: summary.activityStartedAt,
          activityHeartbeatAt: summary.activityHeartbeatAt,
        }
      : {}),
  }));
}

export async function remoteSearchSessions(
  config: RemoteSessionConfig,
  query: string,
  limit = 20,
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const response = await remoteRequestJson(
    config,
    `/api/sessions/search?q=${encodeURIComponent(trimmed)}`,
  );
  const records = asArray(asRecord(response).results);
  const results = records.map((row) => {
    const sessionId = stringValue(row.session_id, stringValue(row.id));
    return {
      sessionId,
      title: nullableString(row.title),
      startedAt: numberValue(
        row.session_started,
        numberValue(row.started_at, numberValue(row.timestamp)),
      ),
      source: stringValue(row.source, "chat"),
      messageCount: numberValue(row.message_count),
      model: stringValue(row.model),
      snippet: stringValue(row.snippet),
    };
  });

  const { results: enriched, summaries } = await enrichRemoteSearchResults(
    config,
    results,
  );
  const lineageAvailable =
    hasLineageMetadata(records) ||
    summaries.some(
      (summary) =>
        Boolean(summary.parentSessionId) ||
        Boolean(summary.endReason) ||
        Boolean(summary.modelConfig),
    );
  let canonicalResults = enriched;
  if (enriched.length === 0) {
    return remoteSearchRecentSessionMessages(config, trimmed, limit, new Set());
  }
  try {
    const lineageRows = await remoteLineageRows(config);
    if (lineageAvailable || hasLineageMetadata(lineageRows)) {
      const lineage = buildCompressionLineageProjection(
        lineageRows.map(normalizeSessionSummary),
      );
      canonicalResults = enriched.map((result) => {
        const canonical = lineage.canonicalBySessionId.get(result.sessionId);
        if (!canonical) return result;
        return {
          ...result,
          sessionId: canonical.id,
          title: canonical.title,
          startedAt: canonical.startedAt,
          source: canonical.source,
          messageCount: canonical.messageCount,
          model: canonical.model,
        };
      });
    }
  } catch {
    // Older endpoints may expose partial lineage fields but no compatible
    // full-list endpoint. Preserve their original search results.
  }
  canonicalResults = dedupeSearchResultsBySession(canonicalResults, limit);
  if (canonicalResults.length >= limit) return canonicalResults;

  const fallback = await remoteSearchRecentSessionMessages(
    config,
    trimmed,
    limit,
    new Set(canonicalResults.map((result) => result.sessionId)),
  );
  return dedupeSearchResultsBySession(
    [...canonicalResults, ...fallback],
    limit,
  );
}

async function remoteSearchRecentSessionMessages(
  config: RemoteSessionConfig,
  query: string,
  limit: number,
  excludedSessionIds: Set<string>,
): Promise<SearchResult[]> {
  let sessions: SessionSummary[];
  try {
    sessions = await remoteListSessions(config, 75, 0);
  } catch {
    return [];
  }

  const lower = query.toLocaleLowerCase();
  const results: SearchResult[] = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    const chunk = sessions.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(
      chunk.map(async (session) => {
        if (!session.id || excludedSessionIds.has(session.id)) return null;
        try {
          const items = await remoteGetSessionMessages(config, session.id);
          const match = items
            .map(historyItemSearchText)
            .find((text) => text.toLocaleLowerCase().includes(lower));
          if (!match) return null;
          return {
            sessionId: session.id,
            title: session.title,
            startedAt: session.startedAt,
            source: session.source,
            messageCount: session.messageCount,
            model: session.model,
            snippet: highlightTextMatch(match, query).slice(0, 500),
          } satisfies SearchResult;
        } catch {
          return null;
        }
      }),
    );
    for (const result of fetched) {
      if (!result) continue;
      excludedSessionIds.add(result.sessionId);
      results.push(result);
      if (results.length >= limit) return results;
    }
  }
  return results;
}

async function remoteGetSessionSummary(
  config: RemoteSessionConfig,
  sessionId: string,
): Promise<(SessionSummary & RemoteLineageFields) | null> {
  try {
    const response = await remoteRequestJson(
      config,
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { timeoutMs: 8_000 },
    );
    const record = asRecord(response);
    const payload = asRecord(record.session ?? record.data ?? record);
    return payload.id || payload.session_id
      ? normalizeSessionSummary(payload)
      : null;
  } catch {
    return null;
  }
}

async function enrichRemoteSearchResults(
  config: RemoteSessionConfig,
  results: SearchResult[],
): Promise<{
  results: SearchResult[];
  summaries: Array<SessionSummary & RemoteLineageFields>;
}> {
  const uniqueIds = Array.from(
    new Set(results.map((result) => result.sessionId).filter(Boolean)),
  );
  if (uniqueIds.length === 0) return { results, summaries: [] };

  const summaries = new Map<string, SessionSummary & RemoteLineageFields>();
  const CONCURRENCY = 5;
  for (let i = 0; i < uniqueIds.length; i += CONCURRENCY) {
    const chunk = uniqueIds.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(
      chunk.map((id) => remoteGetSessionSummary(config, id)),
    );
    for (const summary of fetched) {
      if (summary?.id) summaries.set(summary.id, summary);
    }
  }

  return {
    results: results.map((result) => {
      const summary = summaries.get(result.sessionId);
      if (!summary) return result;
      return {
        ...result,
        title: result.title ?? summary.title,
        startedAt: result.startedAt || summary.startedAt,
        source: result.source || summary.source,
        messageCount: summary.messageCount,
        model: result.model || summary.model,
      };
    }),
    summaries: Array.from(summaries.values()),
  };
}

function toNumericMessageId(value: unknown, index: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return index + 1;
}

function normalizeMessageRow(row: RemoteRecord, index: number): RawMessageRow {
  return {
    id: toNumericMessageId(row.id, index),
    role: stringValue(row.role),
    content: typeof row.content === "string" ? row.content : null,
    timestamp: numberValue(row.timestamp, index),
    tool_call_id: nullableString(row.tool_call_id),
    tool_calls: typeof row.tool_calls === "string" ? row.tool_calls : null,
    tool_name: nullableString(row.tool_name),
    reasoning: nullableString(row.reasoning),
    reasoning_content: nullableString(row.reasoning_content),
    reasoning_details:
      typeof row.reasoning_details === "string"
        ? row.reasoning_details
        : row.reasoning_details === undefined || row.reasoning_details === null
          ? null
          : JSON.stringify(row.reasoning_details),
  };
}

export async function remoteGetSessionMessages(
  config: RemoteSessionConfig,
  sessionId: string,
): Promise<HistoryItem[]> {
  const response = await remoteRequestJson(
    config,
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  const record = asRecord(response);
  const data = record.data;
  const rawRows = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(data)
      ? data
      : asRecord(data).messages;
  const rows = asArray(rawRows).map(normalizeMessageRow);
  return hydrateRemotePromptImageAttachments(config, expandRowsToHistory(rows));
}

async function hydrateRemotePromptImageAttachments(
  config: RemoteSessionConfig,
  items: HistoryItem[],
): Promise<HistoryItem[]> {
  const hydrated: HistoryItem[] = [];
  const cache = new Map<string, Promise<string | null>>();

  for (const item of items) {
    if (item.kind !== "user") {
      hydrated.push(item);
      continue;
    }

    const fallback = extractLeadingVisionImageFallback(item.content);
    if (!fallback.imagePath) {
      hydrated.push(item);
      continue;
    }

    const nextContent = stripTrailingImagePlaceholders(fallback.content);
    if (item.attachments?.length) {
      hydrated.push({ ...item, content: nextContent });
      continue;
    }

    const dataUrlPromise =
      cache.get(fallback.imagePath) ??
      remoteReadMediaAsDataUrl(config, fallback.imagePath);
    cache.set(fallback.imagePath, dataUrlPromise);
    const attachment = attachmentFromRemoteDataUrl(
      await dataUrlPromise,
      fallback.imagePath,
      `remote-fallback-att-${item.id}-0`,
    );

    hydrated.push({
      ...item,
      content: nextContent,
      ...(attachment ? { attachments: [attachment] } : {}),
    });
  }

  return hydrated;
}

export async function remoteReadMediaAsDataUrl(
  config: RemoteSessionConfig,
  filePath: string,
): Promise<string | null> {
  if (!filePath.trim()) return null;
  try {
    const response = await remoteRequestJson<unknown>(
      config,
      `/api/media?path=${encodeURIComponent(filePath)}`,
      { timeoutMs: 30_000 },
    );
    return dataUrlValue(asRecord(response).data_url);
  } catch {
    return null;
  }
}

export async function remoteUpdateSessionMetadata(
  config: RemoteSessionConfig,
  sessionId: string,
  fields: {
    title?: string;
    cwd?: string;
    workspace?: string;
    archived?: boolean;
    pinned?: boolean;
  },
): Promise<void> {
  await remoteRequestJson(
    config,
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      body: fields,
    },
  );
}

export async function remoteUpdateSessionTitle(
  config: RemoteSessionConfig,
  sessionId: string,
  title: string,
): Promise<void> {
  return remoteUpdateSessionMetadata(config, sessionId, { title });
}

export async function remoteUpdateSessionWorkspace(
  config: RemoteSessionConfig,
  sessionId: string,
  cwd: string,
): Promise<void> {
  return remoteUpdateSessionMetadata(config, sessionId, { cwd });
}

export async function remoteUpdateSessionArchived(
  config: RemoteSessionConfig,
  sessionId: string,
  archived: boolean,
): Promise<void> {
  return remoteUpdateSessionMetadata(config, sessionId, { archived });
}

export async function remoteUpdateSessionPinned(
  config: RemoteSessionConfig,
  sessionId: string,
  pinned: boolean,
): Promise<void> {
  return remoteUpdateSessionMetadata(config, sessionId, { pinned });
}

export async function remoteDeleteSession(
  config: RemoteSessionConfig,
  sessionId: string,
): Promise<void> {
  await remoteRequestJson(
    config,
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
    },
  );
}

export interface RemoteDeleteSessionsResult {
  requested: number;
  deleted: number;
}

export async function remoteDeleteSessions(
  config: RemoteSessionConfig,
  sessionIds: string[],
): Promise<RemoteDeleteSessionsResult> {
  let deleted = 0;
  for (const id of sessionIds) {
    await remoteDeleteSession(config, id);
    deleted += 1;
  }
  return { requested: sessionIds.length, deleted };
}
