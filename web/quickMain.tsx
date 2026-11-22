import { createRoot } from "react-dom/client";
import { QuickEntry, initQuickView } from "./QuickEntry";

initQuickView();
createRoot(document.getElementById("root")!).render(<QuickEntry />);
