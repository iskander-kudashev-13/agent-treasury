# Open questions found while prototyping

1. **New recipient + Fixed mandate.** UI_UPDATES §9 has payroll pay a brand-new Maria, but §3 says a schedule is valid only if a Fixed mandate already includes the recipient. Decide: does `AddSchedule` implicitly add the recipient to the executing agent's Fixed list, or must the batch carry an explicit `UpdateMandate`? Prototype shows the explicit option ("Also add this recipient to payroll's mandate") in the drawer and a summary line on the assistant card.
2. **Two approval thresholds.** The vault policy has `approval_threshold` and each mandate has its own. Which one wins for scheduled payments (min of both?) and which one the Upcoming `⏳ approval` tag reflects — needs to be stated so `will_need_approval` is computed one way.
3. **Daily-limit overflow.** UI_UPDATES §5.1 says excess "will move to the next day". Confirm the contract really defers (vs. rejects with `VAULT_DAILY_LIMIT_EXCEEDED` and retries next run) so the copy is honest.
4. **Treasury agent card vs. Agents summary card.** DESIGN_AGENTS §4 replaces the single Agent card with an Agents summary card; the Treasury prototype still shows the single-agent card. Update in build step D4.
5. **Pause scopes.** Global "Pause all agents" (vault) and per-agent Pause coexist — the Treasury button label should read "Pause all agents" once multiple agents exist.
