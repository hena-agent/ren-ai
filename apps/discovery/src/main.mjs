import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Site } from "./site.tsx";
import "./style.css";

createRoot(document.getElementById("root")).render(createElement(Site));
