import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AssistantProvider } from "@/features/layout/AssistantContext";
import { AppLayout } from "@/features/layout/AppLayout";
import { OwnerProvider } from "@/features/owner/OwnerProvider";
import { WalletProvider } from "@/features/wallet/WalletProvider";
import { ToastProvider } from "@/kit";
import { AgentDetailPage } from "@/pages/AgentDetailPage";
import { AgentNewPage } from "@/pages/AgentNewPage";
import { AgentsPage } from "@/pages/AgentsPage";
import { PaymentsPage } from "@/pages/PaymentsPage";
import { PayoutDetailPage } from "@/pages/PayoutDetailPage";
import { PayoutsPage } from "@/pages/PayoutsPage";
import { PolicyPage } from "@/pages/PolicyPage";
import { TradingPage } from "@/pages/TradingPage";
import { TreasuryPage } from "@/pages/TreasuryPage";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } });

/**
 * Routes. To add a page: create `src/pages/XPage.tsx`, add a <Route> below, add it to NAV in features/layout/AppLayout.tsx
 * if it needs a nav entry. HashRouter: static hosting needs no SPA fallback, and wallet redirects (`?account_id=…`) land on `/`.
 */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WalletProvider>
          <OwnerProvider>
            <AssistantProvider>
              <HashRouter>
                <Routes>
                  <Route element={<AppLayout />}>
                    <Route index element={<TreasuryPage />} />
                    <Route path="agents" element={<AgentsPage />} />
                    <Route path="agents/new" element={<AgentNewPage />} />
                    <Route path="agents/:id" element={<AgentDetailPage />} />
                    <Route path="payments" element={<PaymentsPage />} />
                    <Route path="recipients" element={<Navigate to="/payments?tab=recipients" replace />} />
                    <Route path="payouts" element={<PayoutsPage />} />
                    <Route path="payouts/:id" element={<PayoutDetailPage />} />
                    <Route path="trading" element={<TradingPage />} />
                    <Route path="policy" element={<PolicyPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Route>
                </Routes>
              </HashRouter>
            </AssistantProvider>
          </OwnerProvider>
        </WalletProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
