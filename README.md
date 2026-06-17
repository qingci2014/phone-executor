# Phone Executor

Remote Android phone automation through a lightweight cloud gateway.  
Hermes / AI agent → Gateway (HTTP) → Phone polls task → executes → returns result.

The phone runs a modified [NeuralBridge](https://github.com/dondetir/NeuralBridge_mcp) APK that polls the Gateway.  
The Gateway is a single Node.js server with no database — just append-only JSONL persistence.

## Quick Start

### 1. Deploy the Gateway

```bash
git clone https://github.com/qingci2014/phone-executor.git
cd phone-executor/gateway
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "host": "0.0.0.0",
  "port": 8787,
  "authToken": "",
  "clientToken": "",
  "deviceToken": "",
  "logDir": "logs",
  "dataDir": "data",
  "defaultTransport": "cloud",
  "enableLocalMcpProxy": false,
  "resultTtlMs": 3600000,
  "confirmationRequiredActions": ["install_app"],
  "devices": [
    {
      "id": "my-phone",
      "name": "My Android Phone",
      "transport": "cloud"
    }
  ]
}
```

- `clientToken` — used by Hermes / CLI to submit tasks. Generate a long random string.
- `deviceToken` — used by the phone APK to register and poll. Generate a different random string.
- `authToken` — shared fallback (development only). Leave empty in production.

Set environment variables (or use a `.env` file):

```bash
export HOST=0.0.0.0
export PORT=8787
export PHONE_EXECUTOR_CLIENT_TOKEN='your-client-token-here'
export PHONE_EXECUTOR_DEVICE_TOKEN='your-device-token-here'
```

Start:

```bash
node server.mjs
```

The Gateway MUST be reachable from the phone over HTTPS. Set up a reverse proxy (nginx, Caddy) with TLS in production.

### 2. Set Up the Phone

Build and install the Android APK from the [NeuralBridge phone-executor fork](https://github.com/qingci2014/NeuralBridge_mcp) on branch `codex/phone-executor-cloud`.

In the NeuralBridge app:
- Set the Gateway URL to `https://your-server.example.com/phone-executor`
- Set the Device Token to match `deviceToken` in your Gateway config
- Grant Accessibility Service and MediaProjection permissions

The phone will poll the Gateway for tasks and execute them.

### 3. Use the CLI

The CLI submits actions to the Gateway and waits for results.

```bash
cd phone-executor/scripts

# Set credentials via environment:
export PHONE_EXECUTOR_CLIENT_TOKEN='your-client-token-here'
export PHONE_EXECUTOR_BASE_URL='https://your-server.example.com/phone-executor'
export PHONE_EXECUTOR_DEVICE_ID='my-phone'

# Or use an env file (default: gateway.env in current directory):
# echo "PHONE_EXECUTOR_CLIENT_TOKEN=your-token" > gateway.env

# Basic commands:
python3 phone_execute.py get_device_info '{}'
python3 phone_execute.py get_ui_tree '{}'
python3 phone_execute.py screenshot '{"quality":"full"}'
python3 phone_execute.py tap '{"x":500,"y":300}'
python3 phone_execute.py type '{"text":"hello"}'
python3 phone_execute.py swipe '{"start_x":600,"start_y":2000,"end_x":600,"end_y":200,"duration_ms":300}'
python3 phone_execute.py open_app '{"package_name":"com.android.settings"}'
python3 phone_execute.py get_installed_package '{"package_name":"com.example.app"}'
python3 phone_execute.py wait_for_text '{"text":"Settings","timeout_ms":5000}'
python3 phone_execute.py install_app '{"app_name":"Example","package_name":"com.example.app","market":"honor","timeout_ms":180000}' --timeout-ms 180000
```

All commands return JSON. Use `--no-auto-approve` if you want manual confirmation for risky actions.

### 4. Systemd (optional)

```bash
sudo cp systemd/phone-executor-gateway.service.example /etc/systemd/system/phone-executor-gateway.service
sudo cp systemd/gateway.env.example /opt/phone-executor/gateway/gateway.env
# Edit gateway.env with your tokens
sudo systemctl daemon-reload
sudo systemctl enable --now phone-executor-gateway
```

## Available Actions

| Action | Parameter | Description |
|--------|-----------|-------------|
| `get_device_info` | `{}` | Device manufacturer, model, Android version, screen |
| `get_ui_tree` | `{}` | Compressed interactive UI element tree |
| `screenshot` | `{"quality":"full"}` or `{"quality":"thumbnail"}` | Take screenshot |
| `tap` | `{"x":int,"y":int}` | Tap at coordinates |
| `swipe` | `{"start_x":int,"start_y":int,"end_x":int,"end_y":int,"duration_ms":int}` | Swipe gesture |
| `type` | `{"text":"str"}` | Type text |
| `press` | `{"key":"back"}` or `{"key":"home"}` | Press key |
| `open_app` | `{"package_name":"str"}` | Launch app by package name |
| `back` | `{}` | Press back |
| `home` | `{}` | Press home |
| `get_installed_package` | `{"package_name":"str"}` | Check if app is installed |
| `wait_for_text` | `{"text":"str","timeout_ms":int}` | Wait for text to appear on screen |
| `dismiss_overlay` | `{"known_overlays":["..."]}` | Dismiss popups and overlays |
| `tap_text` | `{"text":"str"}` | Tap element by visible text |
| `click_by_resource_id` | `{"resource_id":"str"}` | Tap element by resource ID |
| `set_text` | `{"text":"str"}` | Set text in focused field |
| `clear_text` | `{}` | Clear text in focused field |
| `install_app` | `{"app_name":"str","package_name":"str","market":"honor","timeout_ms":int}` | Install app from app market |

## Confirmation Gate

Actions in `confirmationRequiredActions` (default: `install_app`) trigger a confirmation flow:

1. Gateway returns `status: "confirmation_required"` with a `confirmation_id`
2. Caller approves via `POST /task/confirm`
3. Gateway queues the real task

The CLI auto-approves by default. Use `--no-auto-approve` to handle confirmations manually.

## API Reference

All endpoints require `Authorization: Bearer <client-token>`.

- `GET /health` — Gateway health and device count
- `GET /devices` — List registered devices
- `POST /execute` — Queue a task
- `GET /task/status?task_id=...&step_id=...` — Poll task status
- `GET /task/result?task_id=...&step_id=...` — Get task result (404 until ready)
- `POST /task/cancel` — Cancel a queued task
- `GET /confirmations` — List pending confirmations
- `POST /task/confirm` — Approve/deny a confirmation

## Project Structure

```
phone-executor/
├── gateway/           # Node.js HTTP Gateway
│   ├── server.mjs     # Main server
│   ├── config.example.json
│   ├── package.json
│   ├── Dockerfile
│   └── systemd/
├── scripts/           # CLI tools
│   ├── phone_execute.py           # General action executor
│   └── phone_install_app_legacy.py # App Market installer (fallback)
└── patches/           # NeuralBridge APK patches
    ├── neuralbridge-phone-executor-cloud.patch
    └── neuralbridge-android15-screenshot-timeout.patch
```

## Phone Requirements

- Android 11+ (tested on Android 15)
- Accessibility Service enabled for NeuralBridge
- MediaProjection permission for screenshots
- Network access to Gateway URL
- Recommended: disable battery optimization for NeuralBridge

## License

Apache 2.0 — see the NeuralBridge upstream repo for details.
