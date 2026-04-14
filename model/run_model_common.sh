#!/usr/bin/env bash
set -euo pipefail

LAUNCHER_MODE="${1:-generic}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CURRENT_DIR="$SCRIPT_DIR"

LLAMA_DIR="$CURRENT_DIR/llama.cpp"
LLAMA_BUILD_DIR="$LLAMA_DIR/build"
MODELS_ROOT="$CURRENT_DIR/models"
API_DIR="$CURRENT_DIR/api"
MODEL_API_ENTRY="$API_DIR/src/index.ts"
MODEL_PORT="${MODEL_PORT:-8081}"
BUILD_MARKER="$LLAMA_BUILD_DIR/.beeswarm-build"

OS_NAME="$(uname -s)"
CPU_CORES="$(sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 8)"
N_GPU_LAYERS=0
NODE_PID=""
SERVER_PID=""
HF_CMD=""

if [ "$OS_NAME" = "Darwin" ]; then
  TOTAL_RAM_BYTES="$(sysctl -n hw.memsize)"
else
  TOTAL_RAM_BYTES="$(awk '/MemTotal/ {print int($2 * 1024)}' /proc/meminfo)"
fi
TOTAL_RAM_GB=$((TOTAL_RAM_BYTES / 1024 / 1024 / 1024))

NVIDIA_GPU_COUNT=0
if command -v nvidia-smi >/dev/null 2>&1; then
  NVIDIA_GPU_COUNT="$(nvidia-smi --list-gpus 2>/dev/null | wc -l | tr -d ' ')"
fi

echo "Detected: OS=${OS_NAME}, RAM=${TOTAL_RAM_GB}GB, CPU=${CPU_CORES} cores, NVIDIA GPUs=${NVIDIA_GPU_COUNT}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

process_cwd() {
  local pid="$1"

  if [ -L "/proc/$pid/cwd" ]; then
    readlink "/proc/$pid/cwd" 2>/dev/null || true
    return
  fi

  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

kill_stale_processes() {
  if need_cmd pgrep; then
    while IFS= read -r pid; do
      [ -n "${pid:-}" ] || continue
      [ "$pid" = "$$" ] && continue

      if [ "$(process_cwd "$pid")" = "$API_DIR" ]; then
        kill "$pid" 2>/dev/null || true
      fi
    done < <(pgrep -f "node src/index.ts" 2>/dev/null || true)

    while IFS= read -r pid; do
      [ -n "${pid:-}" ] || continue
      [ "$pid" = "$$" ] && continue
      kill "$pid" 2>/dev/null || true
    done < <(pgrep -f "$MODEL_API_ENTRY" 2>/dev/null || true)
  fi

  if need_cmd lsof; then
    while IFS= read -r pid; do
      [ -n "${pid:-}" ] || continue
      [ "$pid" = "$$" ] && continue
      kill "$pid" 2>/dev/null || true
    done < <(lsof -ti tcp:"$MODEL_PORT" 2>/dev/null || true)
  fi
}

install_apt_prereqs() {
  [ "$LAUNCHER_MODE" = "apt" ] || return 0

  local missing=()
  need_cmd git || missing+=(git)
  need_cmd wget || missing+=(wget)
  need_cmd python3 || missing+=(python3)
  python3 -m venv --help >/dev/null 2>&1 || missing+=(python3-venv)
  python3 -m pip --version >/dev/null 2>&1 || missing+=(python3-pip)
  need_cmd node || missing+=(nodejs)
  need_cmd gcc || missing+=(build-essential)
  need_cmd make || missing+=(build-essential)
  need_cmd file || missing+=(file)
  need_cmd lsof || missing+=(lsof)

  if [ "${#missing[@]}" -gt 0 ]; then
    sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update
    sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y "${missing[@]}"
  fi
}

install_prereqs() {
  install_apt_prereqs

  local missing=0
  for cmd in git node npm python3; do
    if ! need_cmd "$cmd"; then
      echo "Missing required command: $cmd"
      missing=1
    fi
  done

  if ! need_cmd cmake; then
    if [ "$LAUNCHER_MODE" = "apt" ]; then
      true
    elif [ "$OS_NAME" = "Darwin" ] && need_cmd brew; then
      brew install cmake
    else
      echo "Missing required command: cmake"
      missing=1
    fi
  fi

  if [ "$missing" -ne 0 ]; then
    echo "Please install the missing prerequisites and rerun."
    exit 1
  fi

  if [ "$LAUNCHER_MODE" = "apt" ]; then
    if [ ! -d "$CURRENT_DIR/venv" ]; then
      python3 -m venv "$CURRENT_DIR/venv"
    fi
    # shellcheck disable=SC1091
    source "$CURRENT_DIR/venv/bin/activate"
    pip install --upgrade pip huggingface_hub cmake
  fi

  if need_cmd hf; then
    HF_CMD="hf"
  elif need_cmd huggingface-cli; then
    HF_CMD="huggingface-cli"
  elif need_cmd pip3; then
    pip3 install --user -U "huggingface_hub[cli]"
    HF_CMD="$HOME/.local/bin/hf"
  else
    python3 -m pip install --user -U "huggingface_hub[cli]"
    HF_CMD="$HOME/.local/bin/hf"
  fi

  if [ ! -x "$(command -v "$HF_CMD" 2>/dev/null || echo "$HF_CMD")" ] && ! need_cmd "$HF_CMD"; then
    echo "Failed to locate Hugging Face CLI after setup."
    exit 1
  fi
}

select_backend() {
  BACKEND="cpu"
  CMAKE_BACKEND_FLAGS=(-DCMAKE_CXX_STANDARD=17 -DLLAMA_CURL=OFF)
  SERVER_EXTRA_ARGS=()

  if [ "$OS_NAME" = "Darwin" ]; then
    BACKEND="metal"
    CMAKE_BACKEND_FLAGS+=(-DGGML_METAL=ON)
    N_GPU_LAYERS=999
  elif [ "$NVIDIA_GPU_COUNT" -ge 1 ]; then
    BACKEND="cuda"
    CMAKE_BACKEND_FLAGS+=(-DGGML_CUDA=ON)
    N_GPU_LAYERS=999
  else
    BACKEND="cpu"
    CMAKE_BACKEND_FLAGS+=(-DGGML_CUDA=OFF)
    N_GPU_LAYERS=0
  fi
}

select_model() {
  CTX_SIZE=16384

  if [ "$OS_NAME" != "Darwin" ] && [ "$TOTAL_RAM_GB" -ge 200 ] && [ "$NVIDIA_GPU_COUNT" -ge 2 ]; then
    MODEL_NAME="qwen3-coder-next"
    MODEL_REPO="bartowski/Qwen_Qwen3-Coder-Next-GGUF"
    MODEL_FILE="Qwen3-Coder-Next-Q4_K_M.gguf"
    CTX_SIZE=32768
  elif [ "$TOTAL_RAM_GB" -ge 96 ]; then
    MODEL_NAME="qwen2.5-coder-32b"
    MODEL_REPO="bartowski/Qwen2.5-Coder-32B-Instruct-GGUF"
    MODEL_FILE="Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf"
    CTX_SIZE=16384
  elif [ "$TOTAL_RAM_GB" -ge 40 ]; then
    MODEL_NAME="qwen2.5-coder-14b"
    MODEL_REPO="bartowski/Qwen2.5-Coder-14B-Instruct-GGUF"
    MODEL_FILE="Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf"
    CTX_SIZE=24576
  else
    MODEL_NAME="qwen2.5-coder-7b"
    MODEL_REPO="bartowski/Qwen2.5-Coder-7B-Instruct-GGUF"
    MODEL_FILE="Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf"
    CTX_SIZE=16384
  fi

  MODEL_DIR="$MODELS_ROOT/$MODEL_NAME"
  MODEL_PATH="$MODEL_DIR/$MODEL_FILE"
}

binary_matches_host_arch() {
  local binary_path="$1"
  [ -x "$binary_path" ] || return 1
  need_cmd file || return 0

  local binary_info
  binary_info="$(file "$binary_path" 2>/dev/null || true)"

  case "$(uname -m)" in
    x86_64) echo "$binary_info" | grep -q "x86-64" ;;
    arm64 | aarch64) echo "$binary_info" | grep -Eq "arm64|ARM aarch64" ;;
    *) return 0 ;;
  esac
}

build_marker_matches() {
  [ -f "$BUILD_MARKER" ] || return 1
  grep -qx "backend=$BACKEND" "$BUILD_MARKER"
}

build_llama_cpp() {
  if [ ! -d "$LLAMA_DIR" ] || [ ! -f "$LLAMA_DIR/CMakeLists.txt" ]; then
    rm -rf "$LLAMA_DIR"
    git clone https://github.com/ggml-org/llama.cpp.git "$LLAMA_DIR"
  fi

  LLAMA_SERVER_BIN="$LLAMA_BUILD_DIR/bin/llama-server"

  if ! binary_matches_host_arch "$LLAMA_SERVER_BIN" || ! build_marker_matches; then
    echo "Building llama.cpp with backend: $BACKEND"
    rm -rf "$LLAMA_BUILD_DIR"
    cmake -S "$LLAMA_DIR" -B "$LLAMA_BUILD_DIR" "${CMAKE_BACKEND_FLAGS[@]}"
    cmake --build "$LLAMA_BUILD_DIR" --config Release -j"$CPU_CORES"
    echo "backend=$BACKEND" > "$BUILD_MARKER"
  else
    echo "llama.cpp already built for backend: $BACKEND"
  fi

  if [ ! -x "$LLAMA_SERVER_BIN" ]; then
    echo "Failed to find llama-server after build."
    exit 1
  fi
}

download_model() {
  mkdir -p "$MODEL_DIR"

  if [ -f "$MODEL_PATH" ]; then
    echo "Model already present: $MODEL_FILE"
    return
  fi

  if [ "${BEESWARM_SKIP_DOWNLOAD:-0}" = "1" ]; then
    echo "Skipping model download because BEESWARM_SKIP_DOWNLOAD=1"
    return
  fi

  echo "Downloading model: $MODEL_REPO / $MODEL_FILE"
  "$HF_CMD" download "$MODEL_REPO" --include "$MODEL_FILE" --local-dir "$MODEL_DIR"
}

build_tensor_split() {
  TENSOR_SPLIT_ARG=()

  if [ "$NVIDIA_GPU_COUNT" -ge 2 ]; then
    local split=""
    local i=1
    while [ "$i" -le "$NVIDIA_GPU_COUNT" ]; do
      if [ -z "$split" ]; then
        split="1"
      else
        split="$split,1"
      fi
      i=$((i + 1))
    done

    TENSOR_SPLIT_ARG=(--split-mode layer --tensor-split "$split")
  fi
}

start_api() {
  cd "$API_DIR" || exit 1

  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi

  MODEL_API="http://127.0.0.1:$MODEL_PORT" node src/index.ts &
  NODE_PID=$!
}

cleanup() {
  echo "Stopping background processes..."
  if [ -n "${NODE_PID:-}" ]; then
    kill "$NODE_PID" 2>/dev/null || true
  fi
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

install_prereqs
select_backend
select_model
build_llama_cpp
download_model
build_tensor_split

echo "Selected backend: $BACKEND"
echo "Selected model:   $MODEL_FILE"
echo "Model path:       $MODEL_PATH"
echo "Context size:     $CTX_SIZE"
echo "Port:             $MODEL_PORT"

if [ "${BEESWARM_BUILD_ONLY:-0}" = "1" ]; then
  echo "Build-only mode complete."
  exit 0
fi

if [ ! -f "$MODEL_PATH" ]; then
  echo "Model file is missing: $MODEL_PATH"
  exit 1
fi

kill_stale_processes
start_api

echo "Node PID:         $NODE_PID"

cd "$CURRENT_DIR" || exit 1
SERVER_ARGS=(
  -m "$MODEL_PATH"
  --host 127.0.0.1
  --port "$MODEL_PORT"
  --ctx-size "$CTX_SIZE"
  -t "$CPU_CORES"
  -ngl "$N_GPU_LAYERS"
)

if [ "${#SERVER_EXTRA_ARGS[@]}" -gt 0 ]; then
  SERVER_ARGS+=("${SERVER_EXTRA_ARGS[@]}")
fi

if [ "${#TENSOR_SPLIT_ARG[@]}" -gt 0 ]; then
  SERVER_ARGS+=("${TENSOR_SPLIT_ARG[@]}")
fi

"$LLAMA_SERVER_BIN" "${SERVER_ARGS[@]}" &
SERVER_PID=$!

wait "$SERVER_PID"
