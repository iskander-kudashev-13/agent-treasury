import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useT } from "@/i18n";
import { Card, Icons } from "@/kit";
import { NETWORK } from "@/lib/config";
import { TRADER_AGENT_ID } from "@/lib/tradingClient";
import { DEFAULT_HARD, hardLimitsOf, pickPair } from "@/lib/tradingGuide";
import { useAgents } from "@/lib/useVault";
import { HowItWorks } from "./Intro";
import { RulesGuide } from "./RulesHelp";
import { useOwnerDetails, useTradingStatus } from "./useTrading";

/**
 * `/trading/guide`: the long explanations that used to sit on the Trading page. Two sections, `#how` and `#rules`. The app uses
 * a HashRouter, so `#how` is the router's own hash and the browser does not scroll to it: this component does.
 */
export function TradingGuide() {
  const t = useT();
  const { hash } = useLocation();
  const agents = useAgents();
  const { status } = useTradingStatus();
  const details = useOwnerDetails();
  const live = status?.enabled ? status : null;
  const trader = agents.data.find((a) => a.id === TRADER_AGENT_ID && a.status !== "Revoked") ?? null;
  const network = live?.hl_network ?? (NETWORK === "mainnet" ? "mainnet" : "testnet");
  const hard = hardLimitsOf(live) ?? DEFAULT_HARD;
  const pair = pickPair({ status: live, rulesPairs: details.rules?.rules.pairs, network });

  useEffect(() => {
    const id = hash.replace(/^#/, "");
    if (id) document.getElementById(id)?.scrollIntoView?.({ block: "start" });
  }, [hash]);

  return (
    <div className="flex flex-col gap-6">
      <Link to="/trading" className="inline-flex items-center gap-1 text-sm">
        ← {t("trading.guide.back")}
      </Link>
      <nav aria-label={t("trading.guide.tocAria")} className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <Link to="/trading/guide#how">{t("trading.guide.linkHow")}</Link>
        <Link to="/trading/guide#rules">{t("trading.guide.linkRules")}</Link>
      </nav>
      <section id="how" aria-label={t("trading.intro.title")} className="scroll-mt-20">
        <HowItWorks trader={trader} status={live} />
      </section>
      <section id="rules" aria-labelledby="trading-rules-guide" className="scroll-mt-20">
        <Card className="flex flex-col gap-4">
          <h2 id="trading-rules-guide" className="m-0 flex items-center gap-2 text-[15px] font-semibold">
            <Icons.Sparkles size={15} /> {t("trading.guide.rulesTitle")}
          </h2>
          <RulesGuide pair={pair} hard={hard} />
        </Card>
      </section>
    </div>
  );
}
