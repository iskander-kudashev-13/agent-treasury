// Dev-only design kit showcase: `pnpm dev` → http://localhost:5173/kit.html. Not part of the production build.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./showcase.css";
import { ToastProvider } from "../overlays";
import { Showcase } from "./Showcase";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <Showcase />
    </ToastProvider>
  </StrictMode>,
);
