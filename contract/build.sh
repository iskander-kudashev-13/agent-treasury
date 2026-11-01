#!/usr/bin/env bash
# Build the vault wasm.
# - rustc must be <= 1.86 (nearcore VM compatibility check in cargo-near).
# - shade-attestation pulls `ring`, whose C code needs a clang with the wasm32 backend (Apple clang lacks it):
#   macOS: `brew install llvm`; Linux: system clang works.
# - `-mcpu=mvp` keeps the C objects to WebAssembly MVP features accepted by the NEAR runtime.
# - `--no-abi` is required by the shade-attestation dependency.
set -euo pipefail
cd "$(dirname "$0")"
LLVM_BIN="${LLVM_BIN:-$( [ -d /opt/homebrew/opt/llvm/bin ] && echo /opt/homebrew/opt/llvm/bin || dirname "$(command -v clang)")}"
rustup toolchain install 1.86.0 --target wasm32-unknown-unknown --profile minimal >/dev/null
CC_wasm32_unknown_unknown="$LLVM_BIN/clang" \
AR_wasm32_unknown_unknown="$LLVM_BIN/llvm-ar" \
CFLAGS_wasm32_unknown_unknown="-mcpu=mvp" \
CARGO_TARGET_DIR=target-wasm \
  cargo +1.86.0 near build non-reproducible-wasm --no-abi
echo "wasm: $(pwd)/target-wasm/near/agent_treasury_vault.wasm"
