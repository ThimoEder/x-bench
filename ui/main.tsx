import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyColors, applyTheme, readColors, readTheme, shareTheme } from "./theme.ts";
import { followOtherWindows } from "./useTheme.ts";
import { devBuild, devLabel, devTitle } from "./devBuild.ts";
import { fitKeyboardViewport } from "./phone/keyboardViewport.ts";
import type { License } from "./licenses/licenses.ts";
import "./styles.css";

applyTheme(readTheme());
applyColors(readColors());
shareTheme();
followOtherWindows();
fitKeyboardViewport();
if (devBuild) document.title = devTitle(devLabel);
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
if (location.pathname === "/licenses") {
  void Promise.all([import("./licenses/LicensesPage.tsx"), fetch("/licenses.json").then((response) => response.json() as Promise<License[]>)]).then(([{ LicensesPage }, licenses]) => {
    document.getElementById("launch")?.remove();
    createRoot(root).render(<LicensesPage licenses={licenses} />);
  });
} else {
  createRoot(root).render(<App />);
}
