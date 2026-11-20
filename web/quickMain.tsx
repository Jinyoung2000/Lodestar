import { createRoot } from "react-dom/client";
import { QuickEntry, initQuickView } from "./QuickEntry"; // QUICKENTRY

// 전역 빠른 입력창(?view=quick)의 시작점. 앱 창의 시작점(web/appMain.tsx)을 불러오지 않아 이 창은 필요한 코드만 읽는다.
initQuickView();
createRoot(document.getElementById("root")!).render(<QuickEntry />);
