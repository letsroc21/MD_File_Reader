import ReactDOM from "react-dom/client";
import { applyThemeToDocument, readStoredTheme } from "./theme";
import App from "./App";
import "./styles.css";

if (navigator.userAgent.includes("Mac")) {
  document.body.classList.add("is-mac");
}

applyThemeToDocument(readStoredTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
