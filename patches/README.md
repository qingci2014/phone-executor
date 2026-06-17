# NeuralBridge Patches

These patches capture the Android-side changes that currently live in `vendor/NeuralBridge_mcp`.

## Main Patch

- `neuralbridge-phone-executor-cloud.patch`

Includes:

- Phone-to-Gateway cloud polling client.
- Debug-only cloud configuration via launch intent.
- Debug/release cleartext HTTP split.
- Android 14/15 MediaProjection foreground service type fix.
- Screenshot timeout guards.
- Disabled automatic MediaProjection consent popup.

Apply from the root of a clean NeuralBridge checkout:

```bash
git apply path/to/neuralbridge-phone-executor-cloud.patch
```

## Legacy Patch

- `neuralbridge-android15-screenshot-timeout.patch`

Kept for audit history only. The main patch supersedes it.
