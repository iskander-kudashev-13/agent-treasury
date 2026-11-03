# AGENTS.md

Reviewing or judging this repository? Start with **`VERIFY.md`**: one read-only command (`scripts/verify.sh`) builds and
tests every package and checks the live mainnet demo (vault `vault.agenthack.near`), with the expected output for each claim.
No keys, wallet or `.env` are needed, and nothing in that file sends a transaction.

`CLAUDE.md` is the internal development brief used while building the project (milestones, agent workflow). It is not
needed to verify the work. Do not run steps marked ⚠ or `[MAINNET]` in `docs/commands.md`: they sign with the owner's keys.
