import http from "node:http";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.PHONE_EXECUTOR_CONFIG || path.join(__dirname, "config.json");
const defaultConfigPath = path.join(__dirname, "config.example.json");

const TOOL_BY_ACTION = {
  get_device_info: "android_get_device_info",
  get_ui_tree: "android_get_ui_tree",
  screenshot: "android_screenshot",
  tap: "android_tap",
  swipe: "android_swipe",
  type: "android_input_text",
  press: "android_press_key",
  open_app: "android_launch_app",
  back: "android_global_action",
  home: "android_global_action",
  install_app: "android_install_app",
  tap_text: "android_tap_text",
  wait_for_text: "android_wait_for_text",
  click_by_resource_id: "android_click_by_resource_id",
  set_text: "android_set_text",
  clear_text: "android_clear_text",
  dismiss_overlay: "android_dismiss_overlay",
  get_installed_package: "android_get_installed_package"
};

let rpcId = 1;
const deviceStates = new Map();
const pendingTasks = new Map();
const completedTasks = new Map();
const canceledTasks = new Map();
const pendingConfirmations = new Map();
const pollWaiters = new Map();

async function loadConfig() {
  const file = existsSync(configPath) ? configPath : defaultConfigPath;
  const raw = await readFile(file, "utf8");
  const config = JSON.parse(raw);
  if (process.env.PORT) config.port = Number(process.env.PORT);
  if (process.env.HOST) config.host = process.env.HOST;
  if (process.env.PHONE_EXECUTOR_TOKEN) config.authToken = process.env.PHONE_EXECUTOR_TOKEN;
  if (process.env.PHONE_EXECUTOR_CLIENT_TOKEN) config.clientToken = process.env.PHONE_EXECUTOR_CLIENT_TOKEN;
  if (process.env.PHONE_EXECUTOR_DEVICE_TOKEN) config.deviceToken = process.env.PHONE_EXECUTOR_DEVICE_TOKEN;
  config.defaultTransport = config.defaultTransport || "cloud";
  config.resultTtlMs = Number(config.resultTtlMs || 60 * 60 * 1000);
  config.confirmationRequiredActions = config.confirmationRequiredActions || [];
  config.baseDir = __dirname;
  return config;
}

function resolveDataPath(config, fileName) {
  const dataDir = path.isAbsolute(config.dataDir || "")
    ? config.dataDir
    : path.join(config.baseDir, config.dataDir || "data");
  return {
    dataDir,
    filePath: path.join(dataDir, fileName)
  };
}

function validateConfig(config) {
  const host = config.host || "127.0.0.1";
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const clientToken = (config.clientToken || config.authToken || "").trim();
  const deviceToken = (config.deviceToken || config.authToken || "").trim();
  if ((!clientToken || !deviceToken) && !loopback && process.env.ALLOW_INSECURE_DEV !== "1") {
    throw new Error("Gateway client and device tokens are required when listening outside localhost");
  }
  if (clientToken === "change-me-before-deploy" || deviceToken === "change-me-before-deploy") {
    throw new Error("Replace placeholder Gateway tokens before starting the server");
  }
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function selectDevice(config, deviceId) {
  const device = deviceId
    ? config.devices.find((item) => item.id === deviceId)
    : config.devices[0];
  if (!device) {
    const suffix = deviceId ? `: ${deviceId}` : "";
    throw Object.assign(new Error(`Device not found${suffix}`), { statusCode: 404 });
  }
  return device;
}

function requireBearerToken(token, req) {
  if (!token) return;
  const header = req.headers.authorization || "";
  const expected = `Bearer ${token}`;
  if (header !== expected) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
}

function requireClientAuth(config, req) {
  requireBearerToken(config.clientToken || config.authToken, req);
}

function requireDeviceAuth(config, req) {
  requireBearerToken(config.deviceToken || config.authToken, req);
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
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
      const err = new Error(`HTTP ${response.status}`);
      err.statusCode = response.status;
      err.body = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function callMcp(device, method, params = {}, timeoutMs = 15000) {
  if (!device.mcpUrl) {
    throw Object.assign(new Error("Device has no local MCP URL configured"), { statusCode: 400 });
  }
  const request = {
    jsonrpc: "2.0",
    id: rpcId++,
    method,
    params
  };
  return fetchJson(device.mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json"
    },
    body: JSON.stringify(request)
  }, timeoutMs);
}

function resolveTransport(config, device, requestedTransport) {
  const transport = requestedTransport || device.transport || config.defaultTransport || "cloud";
  if (transport === "local_mcp" && config.enableLocalMcpProxy !== true) {
    throw Object.assign(new Error("Local MCP proxy is disabled"), { statusCode: 403 });
  }
  if (transport !== "cloud" && transport !== "local_mcp") {
    throw Object.assign(new Error(`Unsupported transport: ${transport}`), { statusCode: 400 });
  }
  return transport;
}

function normalizeAction(action, args) {
  const tool = TOOL_BY_ACTION[action];
  if (!tool) {
    throw Object.assign(new Error(`Unknown action: ${action}`), { statusCode: 400 });
  }

  if (action === "back") return { tool, arguments: { action: "back" } };
  if (action === "home") return { tool, arguments: { action: "home" } };
  return { tool, arguments: args || {} };
}

function getQueue(deviceId) {
  if (!pendingTasks.has(deviceId)) pendingTasks.set(deviceId, []);
  return pendingTasks.get(deviceId);
}

function taskKey(taskId, stepId) {
  return `${taskId || ""}:${stepId || ""}`;
}

function matchTask(task, query) {
  if (query.task_id && task.task_id !== query.task_id) return false;
  if (query.step_id && task.step_id !== query.step_id) return false;
  if (query.device_id && task.device_id !== query.device_id) return false;
  return Boolean(query.task_id || query.step_id);
}

function findQueuedTask(query) {
  for (const queue of pendingTasks.values()) {
    const task = queue.find((item) => matchTask(item, query));
    if (task) return task;
  }
  return null;
}

function findStoredTask(store, query) {
  for (const task of store.values()) {
    if (matchTask(task, query)) return task;
  }
  return null;
}

async function appendStoreRecord(config, fileName, record) {
  const { dataDir, filePath } = resolveDataPath(config, fileName);
  await mkdir(dataDir, { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  const raw = await readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function loadCompletedResults(config) {
  const { filePath } = resolveDataPath(config, "results.jsonl");
  const rows = await loadJsonl(filePath);
  for (const row of rows) {
    const key = taskKey(row.task_id, row.step_id);
    if (key !== ":") completedTasks.set(key, row);
  }
  pruneCompletedTasks(config);
}

async function loadCanceledTasks(config) {
  const { filePath } = resolveDataPath(config, "cancellations.jsonl");
  const rows = await loadJsonl(filePath);
  for (const row of rows) {
    const key = taskKey(row.task_id, row.step_id);
    if (key !== ":") canceledTasks.set(key, row);
  }
}

async function loadPendingConfirmations(config) {
  const { filePath } = resolveDataPath(config, "confirmations.jsonl");
  const rows = await loadJsonl(filePath);
  for (const row of rows) {
    if (!row.confirmation_id) continue;
    if (row.status === "pending") {
      pendingConfirmations.set(row.confirmation_id, row);
    } else {
      pendingConfirmations.delete(row.confirmation_id);
    }
  }
}

function setDeviceOnline(deviceId, patch = {}) {
  deviceStates.set(deviceId, {
    ...(deviceStates.get(deviceId) || {}),
    ...patch,
    online: true,
    last_seen_at: new Date().toISOString()
  });
}

function enqueueRemoteTask(device, body) {
  const taskId = body.task_id || crypto.randomUUID();
  const stepId = body.step_id || crypto.randomUUID();
  const { tool, arguments: toolArgs } = normalizeAction(body.action, body.arguments);
  const task = {
    task_id: taskId,
    step_id: stepId,
    device_id: device.id,
    action: body.action,
    tool,
    arguments: toolArgs,
    created_at: new Date().toISOString()
  };

  getQueue(device.id).push(task);
  const waiter = pollWaiters.get(device.id);
  if (waiter) {
    pollWaiters.delete(device.id);
    waiter();
  }

  return {
    task_id: taskId,
    step_id: stepId,
    device_id: device.id,
    action: body.action,
    tool,
    status: "queued"
  };
}

async function enqueueTask(config, device, body) {
  const queued = enqueueRemoteTask(device, body);
  const queue = getQueue(device.id);
  const task = queue[queue.length - 1];
  await appendStoreRecord(config, "tasks.jsonl", {
    ...task,
    queued_at_ms: Date.now()
  });
  return queued;
}

function pruneCompletedTasks(config) {
  const ttlMs = Number(config.resultTtlMs || 60 * 60 * 1000);
  const cutoff = Date.now() - ttlMs;
  for (const [key, result] of completedTasks) {
    if ((result.completed_at_ms || 0) < cutoff) completedTasks.delete(key);
  }
}

async function waitForRemoteTask(deviceId, timeoutMs = 25000) {
  const queue = getQueue(deviceId);
  while (queue.length > 0) {
    const next = queue.shift();
    if (!canceledTasks.has(taskKey(next.task_id, next.step_id))) return next;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pollWaiters.delete(deviceId);
      resolve();
    }, timeoutMs);
    pollWaiters.set(deviceId, () => {
      clearTimeout(timer);
      resolve();
    });
  });

  while (queue.length > 0) {
    const next = queue.shift();
    if (!canceledTasks.has(taskKey(next.task_id, next.step_id))) return next;
  }
  return null;
}

function scrubForLog(value) {
  if (Array.isArray(value)) return value.map(scrubForLog);
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "data" && typeof item === "string" && item.length > 200) {
      out[key] = `[base64 omitted: ${item.length} chars]`;
    } else {
      out[key] = scrubForLog(item);
    }
  }
  return out;
}

async function writeStepLog(config, entry) {
  const logDir = path.isAbsolute(config.logDir)
    ? config.logDir
    : path.join(config.baseDir, config.logDir || "logs");
  await mkdir(logDir, { recursive: true });
  await appendFile(path.join(logDir, "steps.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

function requiresConfirmation(config, action) {
  return (config.confirmationRequiredActions || []).includes(action);
}

function publicConfirmation(record) {
  return {
    confirmation_id: record.confirmation_id,
    task_id: record.request.task_id || null,
    step_id: record.request.step_id || null,
    device_id: record.device_id,
    action: record.request.action,
    status: record.status,
    reason: record.reason || null,
    created_at: record.created_at
  };
}

async function createConfirmation(config, device, body) {
  const confirmation = {
    confirmation_id: crypto.randomUUID(),
    device_id: device.id,
    status: "pending",
    reason: body.confirmation_reason || null,
    request: {
      ...body,
      device_id: device.id
    },
    created_at: new Date().toISOString()
  };
  pendingConfirmations.set(confirmation.confirmation_id, confirmation);
  await appendStoreRecord(config, "confirmations.jsonl", confirmation);
  await writeStepLog(config, {
    confirmation_id: confirmation.confirmation_id,
    task_id: body.task_id || null,
    step_id: body.step_id || null,
    device_id: device.id,
    action: body.action,
    status: "confirmation_required",
    started_at: confirmation.created_at,
    duration_ms: 0
  });
  return {
    ...publicConfirmation(confirmation),
    status: "confirmation_required"
  };
}

async function handleExecute(config, body, options = {}) {
  const device = selectDevice(config, body.device_id);
  const transport = resolveTransport(config, device, body.transport);
  if (transport === "cloud" && requiresConfirmation(config, body.action) && options.skipConfirmation !== true) {
    return createConfirmation(config, device, body);
  }

  if (transport === "cloud") {
    const queued = await enqueueTask(config, device, body);
    await writeStepLog(config, {
      ...queued,
      started_at: new Date().toISOString(),
      duration_ms: 0
    });
    return queued;
  }

  const taskId = body.task_id || crypto.randomUUID();
  const stepId = body.step_id || crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const { tool, arguments: toolArgs } = normalizeAction(body.action, body.arguments);

  try {
    const response = await callMcp(device, "tools/call", {
      name: tool,
      arguments: toolArgs
    }, body.timeout_ms || 20000);

    const isError = Boolean(response?.error || response?.result?.isError);
    const result = {
      task_id: taskId,
      step_id: stepId,
      device_id: device.id,
      action: body.action,
      tool,
      status: isError ? "error" : "ok",
      started_at: startedAt,
      duration_ms: Date.now() - startMs,
      mcp: response
    };

    await writeStepLog(config, {
      ...result,
      mcp: scrubForLog(response)
    });

    return result;
  } catch (error) {
    const result = {
      task_id: taskId,
      step_id: stepId,
      device_id: device.id,
      action: body.action,
      tool,
      status: "error",
      started_at: startedAt,
      duration_ms: Date.now() - startMs,
      error: {
        message: error.message,
        detail: error.body || null
      }
    };
    await writeStepLog(config, result);
    return result;
  }
}

async function handleConfirmTask(config, body) {
  const confirmation = pendingConfirmations.get(body.confirmation_id || "");
  if (!confirmation) {
    throw Object.assign(new Error("Confirmation not found"), { statusCode: 404 });
  }

  pendingConfirmations.delete(confirmation.confirmation_id);
  const now = new Date().toISOString();
  if (body.approve === false) {
    const denied = {
      ...confirmation,
      status: "denied",
      denied_at: now,
      decision_reason: body.reason || null
    };
    await appendStoreRecord(config, "confirmations.jsonl", denied);
    await writeStepLog(config, {
      confirmation_id: confirmation.confirmation_id,
      task_id: confirmation.request.task_id || null,
      step_id: confirmation.request.step_id || null,
      device_id: confirmation.device_id,
      action: confirmation.request.action,
      status: "confirmation_denied",
      started_at: now,
      duration_ms: 0
    });
    return {
      confirmation_id: confirmation.confirmation_id,
      status: "denied"
    };
  }

  const approved = {
    ...confirmation,
    status: "approved",
    approved_at: now,
    decision_reason: body.reason || null
  };
  await appendStoreRecord(config, "confirmations.jsonl", approved);
  await writeStepLog(config, {
    confirmation_id: confirmation.confirmation_id,
    task_id: confirmation.request.task_id || null,
    step_id: confirmation.request.step_id || null,
    device_id: confirmation.device_id,
    action: confirmation.request.action,
    status: "confirmation_approved",
    started_at: now,
    duration_ms: 0
  });

  const queued = await handleExecute(config, confirmation.request, { skipConfirmation: true });
  return {
    confirmation_id: confirmation.confirmation_id,
    status: "approved",
    queued
  };
}

function listConfirmations(deviceId) {
  return [...pendingConfirmations.values()]
    .filter((record) => !deviceId || record.device_id === deviceId)
    .map(publicConfirmation);
}

async function handleTaskStatus(config, query) {
  pruneCompletedTasks(config);
  const completed = findStoredTask(completedTasks, query);
  if (completed) return completed;

  const canceled = findStoredTask(canceledTasks, query);
  if (canceled) return canceled;

  const queued = findQueuedTask(query);
  if (queued) {
    return {
      task_id: queued.task_id,
      step_id: queued.step_id,
      device_id: queued.device_id,
      action: queued.action,
      tool: queued.tool,
      status: "queued",
      created_at: queued.created_at
    };
  }

  return {
    task_id: query.task_id || null,
    step_id: query.step_id || null,
    device_id: query.device_id || null,
    status: "unknown"
  };
}

async function handleCancelTask(config, body) {
  if (!body.task_id && !body.step_id) {
    throw Object.assign(new Error("task_id or step_id is required"), { statusCode: 400 });
  }

  const removed = [];
  for (const [deviceId, queue] of pendingTasks) {
    const kept = [];
    for (const task of queue) {
      if (matchTask(task, body)) {
        removed.push(task);
      } else {
        kept.push(task);
      }
    }
    pendingTasks.set(deviceId, kept);
  }

  const now = new Date().toISOString();
  const records = removed.length > 0
    ? removed.map((task) => ({
        task_id: task.task_id,
        step_id: task.step_id,
        device_id: task.device_id,
        action: task.action,
        tool: task.tool,
        status: "canceled",
        canceled_at: now,
        reason: body.reason || null
      }))
    : [{
        task_id: body.task_id || null,
        step_id: body.step_id || null,
        device_id: body.device_id || null,
        status: "cancel_requested",
        canceled_at: now,
        reason: body.reason || null
      }];

  for (const record of records) {
    canceledTasks.set(taskKey(record.task_id, record.step_id), record);
    await appendStoreRecord(config, "cancellations.jsonl", record);
    await writeStepLog(config, record);
  }

  return {
    status: removed.length > 0 ? "canceled" : "cancel_requested",
    canceled: removed.length,
    records
  };
}

async function handleRawMcp(config, body) {
  if (config.enableLocalMcpProxy !== true) {
    throw Object.assign(new Error("Local MCP proxy is disabled"), { statusCode: 403 });
  }
  const device = selectDevice(config, body.device_id);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const method = body.method;
  if (!method) {
    throw Object.assign(new Error("Missing method"), { statusCode: 400 });
  }
  const response = await callMcp(device, method, body.params || {}, body.timeout_ms || 15000);
  const result = {
    task_id: body.task_id || crypto.randomUUID(),
    step_id: body.step_id || crypto.randomUUID(),
    device_id: device.id,
    method,
    status: response?.error ? "error" : "ok",
    started_at: startedAt,
    duration_ms: Date.now() - startMs,
    mcp: response
  };
  await writeStepLog(config, { ...result, mcp: scrubForLog(response) });
  return result;
}

async function handleRequest(config, req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    const deviceId = url.searchParams.get("device_id");
    const body = {
      status: "ok",
      gateway: "phone-executor-gateway",
      devices: config.devices.length
    };

    if (deviceId) {
      const device = selectDevice(config, deviceId);
      body.device_id = device.id;
      body.device = deviceStates.get(device.id) || { online: false };

      if (config.enableLocalMcpProxy === true && url.searchParams.get("check_local") === "true" && device.healthUrl) {
        try {
          body.local_mcp = await fetchJson(device.healthUrl, { method: "GET" }, 5000);
        } catch (error) {
          body.local_mcp = { status: "error", message: error.message };
        }
      }
    }

    return jsonResponse(res, 200, body);
  }

  if (req.method === "GET" && url.pathname === "/devices") {
    requireClientAuth(config, req);
    return jsonResponse(res, 200, {
      devices: config.devices.map((device) => {
        const view = {
          id: device.id,
          name: device.name,
          transport: device.transport || config.defaultTransport || "cloud",
          state: deviceStates.get(device.id) || { online: false }
        };
        if (config.enableLocalMcpProxy === true) {
          view.mcpUrl = device.mcpUrl || null;
          view.healthUrl = device.healthUrl || null;
        }
        return view;
      })
    });
  }

  if (req.method === "POST" && url.pathname === "/execute") {
    requireClientAuth(config, req);
    const body = await readJsonBody(req);
    return jsonResponse(res, 200, await handleExecute(config, body));
  }

  if (req.method === "POST" && url.pathname === "/task/cancel") {
    requireClientAuth(config, req);
    const body = await readJsonBody(req);
    return jsonResponse(res, 200, await handleCancelTask(config, body));
  }

  if (req.method === "GET" && url.pathname === "/confirmations") {
    requireClientAuth(config, req);
    return jsonResponse(res, 200, {
      confirmations: listConfirmations(url.searchParams.get("device_id") || "")
    });
  }

  if (req.method === "POST" && url.pathname === "/task/confirm") {
    requireClientAuth(config, req);
    const body = await readJsonBody(req);
    return jsonResponse(res, 200, await handleConfirmTask(config, body));
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
    requireClientAuth(config, req);
    const body = await readJsonBody(req);
    return jsonResponse(res, 200, await handleRawMcp(config, body));
  }

  if (req.method === "POST" && url.pathname === "/device/register") {
    requireDeviceAuth(config, req);
    const body = await readJsonBody(req);
    const device = selectDevice(config, body.device_id);
    setDeviceOnline(device.id, {
      name: body.name || device.name,
      executor_version: body.executor_version || null
    });
    return jsonResponse(res, 200, {
      status: "ok",
      device_id: device.id,
      state: deviceStates.get(device.id)
    });
  }

  const pollMatch = url.pathname.match(/^\/device\/([^/]+)\/poll$/);
  if (req.method === "GET" && pollMatch) {
    requireDeviceAuth(config, req);
    const device = selectDevice(config, decodeURIComponent(pollMatch[1]));
    setDeviceOnline(device.id);
    const task = await waitForRemoteTask(device.id, Number(url.searchParams.get("timeout_ms") || 25000));
    if (!task) return jsonResponse(res, 204, {});
    return jsonResponse(res, 200, task);
  }

  const resultMatch = url.pathname.match(/^\/device\/([^/]+)\/result$/);
  if (req.method === "POST" && resultMatch) {
    requireDeviceAuth(config, req);
    const device = selectDevice(config, decodeURIComponent(resultMatch[1]));
    const body = await readJsonBody(req);
    setDeviceOnline(device.id);
    const key = taskKey(body.task_id, body.step_id);
    const result = {
      ...body,
      device_id: device.id,
      completed_at_ms: Date.now(),
      received_at: new Date().toISOString()
    };
    pruneCompletedTasks(config);
    completedTasks.set(key, result);
    await appendStoreRecord(config, "results.jsonl", result);
    await writeStepLog(config, {
      task_id: body.task_id,
      step_id: body.step_id,
      device_id: device.id,
      action: body.action || null,
      tool: body.tool || null,
      status: body.status || "reported",
      started_at: body.started_at || null,
      duration_ms: body.duration_ms || null,
      mcp: scrubForLog(body.mcp || body.result || null)
    });
    return jsonResponse(res, 200, { status: "ok" });
  }

  if (req.method === "GET" && url.pathname === "/task/result") {
    requireClientAuth(config, req);
    pruneCompletedTasks(config);
    const taskId = url.searchParams.get("task_id") || "";
    const stepId = url.searchParams.get("step_id") || "";
    const result = completedTasks.get(taskKey(taskId, stepId));
    if (!result) return jsonResponse(res, 404, { status: "pending" });
    return jsonResponse(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/task/status") {
    requireClientAuth(config, req);
    const query = {
      task_id: url.searchParams.get("task_id") || "",
      step_id: url.searchParams.get("step_id") || "",
      device_id: url.searchParams.get("device_id") || ""
    };
    if (!query.task_id && !query.step_id) {
      throw Object.assign(new Error("task_id or step_id is required"), { statusCode: 400 });
    }
    return jsonResponse(res, 200, await handleTaskStatus(config, query));
  }

  return jsonResponse(res, 404, { status: "error", message: "Not found" });
}

async function main() {
  const config = await loadConfig();
  validateConfig(config);
  await loadCompletedResults(config);
  await loadCanceledTasks(config);
  await loadPendingConfirmations(config);
  const server = http.createServer((req, res) => {
    handleRequest(config, req, res).catch((error) => {
      jsonResponse(res, error.statusCode || 500, {
        status: "error",
        message: error.message
      });
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`Phone Executor Gateway listening on http://${config.host}:${config.port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
