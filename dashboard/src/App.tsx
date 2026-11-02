import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AssistantProvider } from "@/features/layout/AssistantContext";
import { AppLayout } from "@/features/layout/AppLayout";
import { OwnerProvider } from "@/features/owner/OwnerProvider";
import { I18nProvider } from "@/i18n";
import { WalletProvider } from "@/features/wallet/WalletProvider";
import { ToastProvider } from "@/kit";
import { AgentDetailPage } from "@/pages/AgentDetailPage";
import { AgentNewPage } from "@/pages/AgentNewPage";
import { AgentsPage } from "@/pages/AgentsPage";
import { PaymentsPage } from "@/pages/PaymentsPage";
import { PayoutDetailPage } from "@/pages/PayoutDetailPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { TradingGuidePage } from "@/pages/TradingGuidePage";
import { TradingPage } from "@/pages/TradingPage";
import { HomePage } from "@/pages/HomePage";

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
              <I18nProvider>
              <HashRouter>
                <Routes>
                  <Route element={<AppLayout />}>
                    <Route index element={<HomePage />} />
                    <Route path="agents" element={<AgentsPage />} />
                    <Route path="agents/new" element={<AgentNewPage />} />
                    <Route path="agents/:id" element={<AgentDetailPage />} />
                    <Route path="payments" element={<PaymentsPage />} />
                    <Route path="recipients" element={<Navigate to="/payments?tab=recipients" replace />} />
                    <Route path="payouts" element={<Navigate to="/payments?tab=history" replace />} />
                    <Route path="treasury" element={<Navigate to="/" replace />} />
                    <Route path="payouts/:id" element={<PayoutDetailPage />} />
                    <Route path="trading" element={<TradingPage />} />
                    <Route path="trading/guide" element={<TradingGuidePage />} />
                    <Route path="settings" element={<SettingsPage />} />
                    <Route path="policy" element={<Navigate to="/settings" replace />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Route>
                </Routes>
              </HashRouter>
              </I18nProvider>
            </AssistantProvider>
          </OwnerProvider>
        </WalletProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
