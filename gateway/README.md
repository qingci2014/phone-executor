# Phone Executor Gateway

Gateway is the cloud-facing service Hermes calls. The production path is:

```text
Hermes -> Gateway -> phone polls task -> phone executes -> Gateway stores result
```

The phone should not expose its local MCP port to the public internet. It registers with Gateway and polls for work over an authenticated channel.

## Production Start

```bash
cd /opt/phone-executor/gateway
# ^ or wherever you cloned the repo
cp config.example.json config.json
export HOST=0.0.0.0
export PORT=8787
export PHONE_EXECUTOR_CLIENT_TOKEN='replace-with-a-long-random-token-for-hermes'
export PHONE_EXECUTOR_DEVICE_TOKEN='replace-with-a-long-random-token-for-phone'
node server.mjs
```

Client and device tokens are required when listening outside localhost. `PHONE_EXECUTOR_TOKEN` is still accepted as a single shared token for development, but production should use separate tokens.

Hermes must send:

```http
Authorization: Bearer replace-with-a-long-random-token-for-hermes
```

The phone executor must send:

```http
Authorization: Bearer replace-with-a-long-random-token-for-phone
```

## API

- `GET /health`
  - Public liveness check for Gateway.
  - Does not call the phone by default.

- `GET /devices`
  - Lists configured devices and last seen state.
  - Requires Bearer token.

- `POST /execute`
  - Hermes queues a normalized action for a device.
  - Requires Bearer token.

- `POST /device/register`
  - Phone executor registers itself online.
  - Requires device Bearer token.

- `GET /device/:device_id/poll`
  - Phone executor long-polls for the next task.
  - Requires device Bearer token.

- `POST /device/:device_id/result`
  - Phone executor posts task result.
  - Requires device Bearer token.

- `GET /task/result?task_id=...&step_id=...`
  - Hermes reads task result.
  - Requires Bearer token.

- `GET /task/status?task_id=...&step_id=...`
  - Hermes checks whether a task is queued, completed, canceled, cancel-requested, or unknown.
  - Requires Bearer token.

- `POST /task/cancel`
  - Hermes cancels a queued task before the phone picks it up.
  - If the task is already running or unknown, Gateway records `cancel_requested`.
  - Requires Bearer token.

- `GET /confirmations`
  - Hermes lists pending confirmations.
  - Requires Bearer token.

- `POST /task/confirm`
  - Hermes approves or denies a pending high-risk action.
  - Requires Bearer token.

## Actions

Supported normalized actions:

- `get_device_info`
- `get_ui_tree`
- `screenshot`
- `tap`
- `swipe`
- `type`
- `press`
- `open_app`
- `back`
- `home`

Example Hermes request:

```json
{
  "device_id": "honor-ali-an00",
  "action": "screenshot",
  "arguments": {
    "quality": "thumbnail"
  }
}
```

Gateway returns a queued task:

```json
{
  "task_id": "...",
  "step_id": "...",
  "device_id": "honor-ali-an00",
  "action": "screenshot",
  "tool": "android_screenshot",
  "status": "queued"
}
```

If the action is listed in `confirmationRequiredActions`, Gateway returns a confirmation instead of queueing it:

```json
{
  "confirmation_id": "...",
  "task_id": "...",
  "step_id": "...",
  "device_id": "honor-ali-an00",
  "action": "tap",
  "status": "confirmation_required",
  "reason": null,
  "created_at": "..."
}
```

Approve it:

```json
{
  "confirmation_id": "...",
  "approve": true,
  "reason": "Operator approved"
}
```

Denied confirmations are not queued:

```json
{
  "confirmation_id": "...",
  "approve": false,
  "reason": "Wrong target app"
}
```

Check task status:

```http
GET /task/status?task_id=...&step_id=...
Authorization: Bearer replace-with-a-long-random-token
```

Cancel a queued task:

```json
{
  "task_id": "...",
  "step_id": "...",
  "reason": "Hermes superseded this step"
}
```

## Development Mode

Local MCP proxying is disabled by default. To use the old local debugging path, set:

```json
{
  "enableLocalMcpProxy": true,
  "devices": [
    {
      "id": "honor-ali-an00",
      "name": "HONOR ALI-AN00",
      "transport": "local_mcp",
      "mcpUrl": "http://127.0.0.1:7474/mcp",
      "healthUrl": "http://127.0.0.1:7474/health"
    }
  ]
}
```

Then use ADB forwarding/reverse only for local tests:

```powershell
C:\Users\Administrator\Documents\New project\phone-executor\.tools\android-sdk\platform-tools\adb.exe forward tcp:7474 tcp:7474
C:\Users\Administrator\Documents\New project\phone-executor\.tools\android-sdk\platform-tools\adb.exe reverse tcp:8787 tcp:8787
```

## Linux Service

```bash
sudo cp systemd/phone-executor-gateway.service.example /etc/systemd/system/phone-executor-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now phone-executor-gateway
```

## Docker

```bash
docker build -t phone-executor-gateway .
docker run -d --name phone-executor-gateway \
  -p 8787:8787 \
  -e PHONE_EXECUTOR_CLIENT_TOKEN='replace-with-a-long-random-token-for-hermes' \
  -e PHONE_EXECUTOR_DEVICE_TOKEN='replace-with-a-long-random-token-for-phone' \
  phone-executor-gateway
```

## Current Limits

- Tasks and results are persisted as JSONL files under `dataDir`.
- Results are indexed in memory on startup and expire by `resultTtlMs`.
- `POST /task/cancel` cancels queued tasks. True mid-execution stop still needs phone-side cooperation.
- Human confirmation is API-based. A separate UI can be added later without changing Hermes' core task protocol.
- Production should use HTTPS/WSS in front of Gateway.

## Data Files

Gateway writes append-only JSONL files:

- `data/tasks.jsonl`
  - Queued tasks.
- `data/results.jsonl`
  - Reported task results.
- `data/cancellations.jsonl`
  - Canceled tasks and cancel requests.
- `data/confirmations.jsonl`
  - Pending, approved, and denied high-risk action confirmations.
- `logs/steps.jsonl`
  - Operational step log with large image base64 scrubbed.

`data/` and `logs/` are ignored by Git.
