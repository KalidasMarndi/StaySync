#!/usr/bin/env bash
set -eo pipefail

# --- Configuration & Defaults ---
export PORT="${PORT:-4000}"
export TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-127.0.0.1:7233}"
export TEMPORAL_NAMESPACE="${TEMPORAL_NAMESPACE:-default}"
export TEMPORAL_TASK_QUEUE="${TEMPORAL_TASK_QUEUE:-hotel-offers}"
export TEMPORAL_WORKFLOW_BUNDLE_PATH="${TEMPORAL_WORKFLOW_BUNDLE_PATH:-/app/dist/workflow-bundle.js}"

# Internal loopback for mock suppliers hosted on the Express API.
# Prevents public DNS lookups, circular router calls, and cold-start timeouts.
export SUPPLIER_A_BASE_URL="${SUPPLIER_A_BASE_URL:-http://127.0.0.1:${PORT}/supplierA}"
export SUPPLIER_B_BASE_URL="${SUPPLIER_B_BASE_URL:-http://127.0.0.1:${PORT}/supplierB}"

# Limit Node heap sizes to stay within Render's 512MB RAM limit
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=128}"

echo "=========================================================="
echo " Starting StaySync Combined Process Architecture"
echo " Node Port:          ${PORT}"
echo " Temporal Address:   ${TEMPORAL_ADDRESS}"
echo " Task Queue:         ${TEMPORAL_TASK_QUEUE}"
echo " Supplier A URL:     ${SUPPLIER_A_BASE_URL}"
echo " Supplier B URL:     ${SUPPLIER_B_BASE_URL}"
echo " Redis Host:         ${REDIS_HOST:-localhost}:${REDIS_PORT:-6379}"
echo " Redis TLS:          ${REDIS_TLS:-false}"
echo "=========================================================="

# Track child PIDs
PID_TEMPORAL=""
PID_WORKER=""
PID_API=""

# Graceful termination handler
cleanup() {
  echo ""
  echo "[combined] Signal received or process terminated. Shutting down gracefully..."

  # 1. Stop API first so no new incoming requests arrive
  if [ -n "$PID_API" ] && kill -0 "$PID_API" 2>/dev/null; then
    echo "[combined] Stopping API (PID $PID_API)..."
    kill -TERM "$PID_API" 2>/dev/null || true
  fi

  # 2. Stop Worker next so in-flight tasks can finish
  if [ -n "$PID_WORKER" ] && kill -0 "$PID_WORKER" 2>/dev/null; then
    echo "[combined] Stopping Worker (PID $PID_WORKER)..."
    kill -TERM "$PID_WORKER" 2>/dev/null || true
  fi

  # 3. Stop Temporal Server
  if [ -n "$PID_TEMPORAL" ] && kill -0 "$PID_TEMPORAL" 2>/dev/null; then
    echo "[combined] Stopping Temporal Server (PID $PID_TEMPORAL)..."
    kill -TERM "$PID_TEMPORAL" 2>/dev/null || true
  fi

  # Wait for children to exit (up to 10s)
  local deadline=$((SECONDS + 10))
  for pid in "$PID_API" "$PID_WORKER" "$PID_TEMPORAL"; do
    if [ -n "$pid" ]; then
      while kill -0 "$pid" 2>/dev/null && [ $SECONDS -lt $deadline ]; do
        sleep 0.2
      done
      # Force kill if still hanging
      if kill -0 "$pid" 2>/dev/null; then
        echo "[combined] Force killing PID $pid..."
        kill -KILL "$pid" 2>/dev/null || true
      fi
    fi
  done

  echo "[combined] All processes stopped."
  exit "${EXIT_STATUS:-0}"
}

trap 'EXIT_STATUS=0; cleanup' SIGTERM SIGINT

# -----------------------------------------------------------
# 1. Start Temporal Dev Server
# -----------------------------------------------------------
echo "[combined] Starting Temporal dev server (headless) on 127.0.0.1:7233..."
temporal server start-dev \
  --ip 127.0.0.1 \
  --port 7233 \
  --headless \
  --db-filename /tmp/temporal.db &
PID_TEMPORAL=$!

echo "[combined] Waiting for Temporal Server to report SERVING..."
TEMPORAL_READY=false
for i in $(seq 1 40); do
  if ! kill -0 "$PID_TEMPORAL" 2>/dev/null; then
    echo "[combined] ERROR: Temporal Server exited unexpectedly during boot!"
    EXIT_STATUS=1
    cleanup
  fi
  if temporal operator cluster health --address 127.0.0.1:7233 2>/dev/null | grep -q "SERVING"; then
    TEMPORAL_READY=true
    break
  fi
  sleep 0.5
done

if [ "$TEMPORAL_READY" != "true" ]; then
  echo "[combined] ERROR: Timed out waiting for Temporal Server to become healthy."
  EXIT_STATUS=1
  cleanup
fi
echo "[combined] Temporal Server is healthy and serving."

# -----------------------------------------------------------
# 2. Start Temporal Worker
# -----------------------------------------------------------
echo "[combined] Starting Temporal worker..."
node dist/temporal/worker.js &
PID_WORKER=$!

echo "[combined] Waiting for Temporal Worker to register pollers on '${TEMPORAL_TASK_QUEUE}'..."
WORKER_READY=false
for i in $(seq 1 40); do
  if ! kill -0 "$PID_WORKER" 2>/dev/null; then
    echo "[combined] ERROR: Temporal Worker exited unexpectedly during boot!"
    EXIT_STATUS=1
    cleanup
  fi
  if temporal task-queue describe --task-queue "$TEMPORAL_TASK_QUEUE" --address 127.0.0.1:7233 -o json 2>/dev/null | grep -q '"pollers": \['; then
    WORKER_READY=true
    break
  fi
  sleep 0.5
done

if [ "$WORKER_READY" != "true" ]; then
  echo "[combined] ERROR: Timed out waiting for Temporal Worker to poll task queue."
  EXIT_STATUS=1
  cleanup
fi
echo "[combined] Temporal Worker registered and actively polling."

# -----------------------------------------------------------
# 3. Start Express API Server
# -----------------------------------------------------------
echo "[combined] Starting Express API server on port ${PORT}..."
node dist/server.js &
PID_API=$!

# Wait briefly to confirm API doesn't crash on startup
sleep 1
if ! kill -0 "$PID_API" 2>/dev/null; then
  echo "[combined] ERROR: Express API exited unexpectedly on startup!"
  EXIT_STATUS=1
  cleanup
fi
echo "[combined] Express API running. Combined services are UP."

# -----------------------------------------------------------
# 4. Process Supervision
# -----------------------------------------------------------
# Block until any of the three processes exits
wait -n "$PID_TEMPORAL" "$PID_WORKER" "$PID_API"
EXIT_STATUS=$?
echo "[combined] A managed process exited with status ${EXIT_STATUS}."
cleanup
