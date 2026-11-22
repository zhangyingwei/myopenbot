import "./polyfills";
import { render } from "@solidjs/web";
import "../../../src/renderer/src/features/web-client/web-client.css";
import { showSavedAppearance } from "../../../src/renderer/src/features/web-client/web-appearance-preference";
import { markSoftwareRendering } from "../../../src/renderer/src/features/web-client/web-software-rendering";
import { loadSavedLanguage, WebApp } from "./renderer-web";

const root = document.getElementById("root");
if (!root) throw new Error("The web client root is missing.");

showSavedAppearance();
markSoftwareRendering();
void loadSavedLanguage()
  .catch(() => undefined)
  .then(() => render(() => <WebApp />, root));
