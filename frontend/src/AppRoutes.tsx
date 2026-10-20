import { Dashboard } from "./App";
import PortalPage from "./PortalPage";

export default function AppRoutes() {
  const path = window.location.pathname;
  return ["/login", "/register", "/profile", "/applications", "/activity", "/saved-jobs", "/growth", "/learnings", "/weaknesses", "/coach", "/interview-coach", "/debrief"].includes(path)
    ? <PortalPage />
    : <Dashboard />;
}
