import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
// oxlint-disable-next-line import/no-unassigned-import -- Vite stylesheet entry
import "./style.css";

createRoot(document.getElementById("root")!).render(<App />);
