#!/usr/bin/env bash
# Machine-followable verification of Agent Treasury. Needs no keys, sends no transactions, spends nothing.
#   scripts/verify.sh offline   # build + lint + all tests of every package (no network used by the tests)
#   scripts/verify.sh onchain   # read-only checks of the live mainnet demo vault, Hyperliquid fills and 1Click deliveries
#   scripts/verify.sh           # both
# Requirements: Rust stable + cargo, Node.js >= 22.12, pnpm 11, curl, jq. Exit code 0 = every check passed.
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=1; }
want() { if [ "$2" = "$3" ]; then ok "$1 = $3"; else bad "$1: got '$2', expected '$3'"; fi; }

offline() {
  echo "== offline: contract (cargo fmt, clippy, test)"
  local log; log=$(mktemp)
  if (cd contract && cargo fmt --check && cargo clippy --all-targets -q -- -D warnings && cargo test -q >"$log" 2>&1) && ! grep -qE 'test result: FAILED' "$log"; then
    ok "contract: $(grep -E '^test result' "$log" | awk '{s+=$4} END {print s}') tests passed"
  else bad "contract checks (see $log)"; fi
  for p in sdk mcp worker dashboard; do
    echo "== offline: $p (install, typecheck, lint, test, build)"
    log=$(mktemp)
    if (cd "$p" && pnpm install --frozen-lockfile --silent && pnpm -s typecheck && pnpm -s lint && pnpm -s test >"$log" 2>&1 && pnpm -s build >/dev/null); then
      ok "$p: $(grep -oE 'Tests +[0-9]+ passed' "$log" | tail -1)"
    else bad "$p checks (see $log)"; fi
  done
}

# Public RPCs rate-limit; each view tries both endpoints of the network with a short backoff.
RPC_MAIN=${RPC_MAIN:-"https://free.rpc.fastnear.com https://near.drpc.org"}
RPC_TEST=${RPC_TEST:-"https://test.rpc.fastnear.com https://near-testnet.drpc.org"}
view() { # view "<rpc urls>" <contract> <method> <json-args>
  local a out u try; a=$(printf '%s' "$4" | base64 | tr -d '\n')
  for try in 1 2 3; do
    for u in $1; do
      out=$(curl -s -m 15 "$u" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$2\",\"method_name\":\"$3\",\"args_base64\":\"$a\"}}" \
        | jq -er '.result.result | implode' 2>/dev/null) && { printf '%s' "$out"; return 0; }
    done
    sleep $((try * 2))
  done
  return 1
}

onchain() {
  local V=vault.agenthack.near
  echo "== onchain (read-only): mainnet vault $V"
  want "owner"            "$(view "$RPC_MAIN" $V get_contract_info '{}' | jq -r .owner_id)" "agenthack.near"
  want "requires_tee"     "$(view "$RPC_MAIN" $V get_contract_info '{}' | jq -r .requires_tee)" "true"
  want "payouts count"    "$(view "$RPC_MAIN" $V get_payouts_count '{}' | jq -r .)" "3"
  P=$(view "$RPC_MAIN" $V get_payouts '{"from_index":0,"limit":10}')
  want "payout 0 (hl-trader → hypercore 20 USDC)" "$(echo "$P" | jq -r '.[0] | "\(.agent_id) \(.chain) \(.amount) \(.status)"')" "hl-trader hypercore 20000000 Confirmed"
  want "payout 1 (payroll → Maria on base 2 USDC)" "$(echo "$P" | jq -r '.[1] | "\(.agent_id) \(.chain) \(.amount) \(.status)"')" "payroll base 2000000 Confirmed"
  want "payout 2 (payroll → Alex on arb 2 USDC)"   "$(echo "$P" | jq -r '.[2] | "\(.agent_id) \(.chain) \(.amount) \(.status)"')" "payroll arb 2000000 Confirmed"
  R=$(view "$RPC_MAIN" $V get_rejections '{"limit":20}')
  want "refusal PER_TX_LIMIT_EXCEEDED (payroll, 50 USDC)" "$(echo "$R" | jq -r '[.[] | select(.agent_id=="payroll" and .reason=="PER_TX_LIMIT_EXCEEDED")] | length > 0')" "true"
  want "refusal RECIPIENT_NOT_ALLOWED (payroll, injected address)" "$(echo "$R" | jq -r '[.[] | select(.agent_id=="payroll" and .reason=="RECIPIENT_NOT_ALLOWED")] | length > 0')" "true"
  want "hl-trader agent revoked after the session" "$(view "$RPC_MAIN" $V get_agent_budget '{"agent_id":"hl-trader"}' | jq -r .status)" "Revoked"

  echo "== onchain (read-only): NEAR Intents 1Click deliveries"
  for d in $(echo "$P" | jq -r '.[].deposit_address'); do
    want "1Click deposit ${d:0:8}… status" "$(curl -s "https://1click.chaindefuser.com/v0/status?depositAddress=$d" | jq -r .status)" "SUCCESS"
  done

  echo "== onchain (read-only): Hyperliquid fills by the bots (cloid = rules/mandate hash prefix)"
  F=$(curl -s https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' -d '{"type":"userFills","user":"0x072994Aa1Bdb9886Ce04f6D42c6ee513fA92ab0d"}')
  want "AI-agent bot fill (cloid 0xa277ef47…)" "$(echo "$F" | jq -r '[.[] | select(.cloid // "" | startswith("0xa277ef4740ed65b4"))] | .[0] | "\(.side) \(.sz)"')" "B 0.12"
  want "rules bot fill (cloid 0x8d0b7dea…)"    "$(echo "$F" | jq -r '[.[] | select(.cloid // "" | startswith("0x8d0b7dea3634814f"))] | .[0] | "\(.side) \(.sz)"')" "B 0.12"

  echo "== onchain (read-only): testnet judging vault at-vault-11012309.testnet"
  want "testnet payouts count" "$(view "$RPC_TEST" at-vault-11012309.testnet get_payouts_count '{}' | jq -r .)" "3"
}

case "${1:-all}" in
  offline) offline ;;
  onchain) onchain ;;
  all) offline; onchain ;;
  *) echo "usage: $0 [offline|onchain]"; exit 2 ;;
esac
[ $FAIL -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $FAIL
