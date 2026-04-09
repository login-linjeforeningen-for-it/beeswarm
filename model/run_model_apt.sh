#!/bin/bash
set -e

# --- Paths ---
CURRENT_DIR=$(pwd)
LLAMA_DIR="$CURRENT_DIR/llama.cpp"
LLAMA_BUILD_DIR="$LLAMA_DIR/build"
MODEL_DIR="$CURRENT_DIR/models/mistral"
MODEL_PATH="$MODEL_DIR/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf"
MODEL_API_ENTRY="$CURRENT_DIR/api/src/index.ts"
MODEL_PORT=8081
VENV_DIR="$CURRENT_DIR/venv"

download_model() {
    if command -v hf >/dev/null 2>&1; then
        hf download bartowski/Mistral-7B-Instruct-v0.3-GGUF \
            --include "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf" \
            --local-dir "$MODEL_DIR"
        return
    fi

    huggingface-cli download bartowski/Mistral-7B-Instruct-v0.3-GGUF \
        --include "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf" \
        --local-dir "$MODEL_DIR"
}

binary_matches_host_arch() {
    BINARY_PATH="$1"

    if [ ! -x "$BINARY_PATH" ] || ! command -v file >/dev/null 2>&1; then
        return 1
    fi

    BINARY_INFO=$(file "$BINARY_PATH" 2>/dev/null || true)

    case "$(uname -m)" in
        x86_64)
            echo "$BINARY_INFO" | grep -q "x86-64"
            ;;
        aarch64 | arm64)
            echo "$BINARY_INFO" | grep -q "ARM aarch64"
            ;;
        *)
            return 1
            ;;
    esac
}

install_apt_packages_if_missing() {
    MISSING_PACKAGES=""

    if ! command -v git >/dev/null 2>&1; then
        MISSING_PACKAGES="$MISSING_PACKAGES git"
    fi

    if ! command -v wget >/dev/null 2>&1; then
        MISSING_PACKAGES="$MISSING_PACKAGES wget"
    fi

    if ! command -v python3 >/dev/null 2>&1; then
        MISSING_PACKAGES="$MISSING_PACKAGES python3"
    fi

    if ! python3 -m pip --version >/dev/null 2>&1; then
        MISSING_PACKAGES="$MISSING_PACKAGES python3-pip"
    fi

    if ! command -v node >/dev/null 2>&1; then
        MISSING_PACKAGES="$MISSING_PACKAGES nodejs"
    fi

    if ! command -v gcc >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1; then
        MISSING_PACKAGES="$MISSING_PACKAGES build-essential"
    fi

    if [ -n "$MISSING_PACKAGES" ]; then
        sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update
        # shellcheck disable=SC2086
        sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y $MISSING_PACKAGES
    fi
}

# --- Kill stale processes ---
kill_stale_processes() {
    if command -v pgrep >/dev/null 2>&1; then
        for pid in $(pgrep -f "node src/index.ts" 2>/dev/null); do
            if [ "$pid" != "$$" ] && [ -L "/proc/$pid/cwd" ] && [ "$(readlink "/proc/$pid/cwd")" = "$CURRENT_DIR/api" ]; then
                kill "$pid" 2>/dev/null || true
            fi
        done

        for pid in $(pgrep -f "$MODEL_API_ENTRY" 2>/dev/null); do
            if [ "$pid" != "$$" ]; then
                kill "$pid" 2>/dev/null || true
            fi
        done
    fi

    if command -v lsof >/dev/null 2>&1; then
        for pid in $(lsof -ti tcp:"$MODEL_PORT" 2>/dev/null); do
            if [ "$pid" != "$$" ]; then
                kill "$pid" 2>/dev/null || true
            fi
        done
    fi
}

# --- System dependencies ---
install_apt_packages_if_missing

if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required but was not found after package setup."
    echo "Install Node.js with npm support (for example via NodeSource or nvm) and retry."
    exit 1
fi

# --- Virtual environment setup ---
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"
pip install --upgrade pip huggingface_hub cmake

# --- Clone llama.cpp ---
if [ ! -d "$LLAMA_DIR" ] || [ ! -f "$LLAMA_DIR/CMakeLists.txt" ]; then
    rm -rf "$LLAMA_DIR"
    git clone https://github.com/ggml-org/llama.cpp.git "$LLAMA_DIR"
fi

# --- Build llama.cpp ---
mkdir -p "$LLAMA_BUILD_DIR"

LLAMA_SERVER_BIN="$LLAMA_BUILD_DIR/bin/llama-server"
if [ ! -x "$LLAMA_SERVER_BIN" ] && [ -x "$LLAMA_DIR/bin/llama-server" ]; then
    LLAMA_SERVER_BIN="$LLAMA_DIR/bin/llama-server"
fi

if ! binary_matches_host_arch "$LLAMA_SERVER_BIN"; then
    BUILD_FLAGS="-DGGML_CUDA=OFF -DLLAMA_CURL=OFF"
    if command -v nvidia-smi >/dev/null 2>&1; then
        BUILD_FLAGS="-DGGML_CUDA=ON -DLLAMA_CURL=OFF"
    fi

    rm -rf "$LLAMA_BUILD_DIR"
    mkdir -p "$LLAMA_BUILD_DIR"
    cmake -S "$LLAMA_DIR" -B "$LLAMA_BUILD_DIR" $BUILD_FLAGS
    cmake --build "$LLAMA_BUILD_DIR" --config Release -j"$(nproc)"
else
    echo "llama.cpp already built"
fi

LLAMA_SERVER_BIN="$LLAMA_BUILD_DIR/bin/llama-server"
if [ ! -x "$LLAMA_SERVER_BIN" ] && [ -x "$LLAMA_DIR/bin/llama-server" ]; then
    LLAMA_SERVER_BIN="$LLAMA_DIR/bin/llama-server"
fi

if [ ! -x "$LLAMA_SERVER_BIN" ]; then
    echo "Failed to find llama-server after build."
    exit 1
fi

# --- Download model ---
mkdir -p "$MODEL_DIR"

if [ ! -f "$MODEL_PATH" ]; then
    download_model
else
    echo "Model already downloaded"
fi

kill_stale_processes

# --- Run Node API ---
cd api || exit
npm install
node src/index.ts &
NODE_PID=$!

trap "echo 'Stopping server...'; kill $NODE_PID 2>/dev/null" EXIT

echo "Node.js API running with pid $NODE_PID"

# --- Run llama-server ---
"$LLAMA_SERVER_BIN" \
    -m "$MODEL_PATH" \
    --port "$MODEL_PORT" \
    --ctx-size 25000 \
    -t "$(nproc)" \
    -ngl 33
