import { Dashboard } from "./App";
import PortalPage from "./PortalPage";

export default function AppRoutes() {
  const path = window.location.pathname;
  return ["/login", "/register", "/profile", "/applications", "/activity", "/saved-jobs"].includes(path)
    ? <PortalPage />
    : <Dashboard />;
}
