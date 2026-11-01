import { AnimatePresence, motion } from "framer-motion";
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import LandingShowcase from "./pages/LandingShowcase";
import GovernmentCommandDashboard from "./pages/GovernmentCommandDashboard";

const spring = { type: "spring", stiffness: 260, damping: 20 } as const;
const page = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -12 }, transition: spring };

function AnimatedRoutes() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<motion.div {...page}><LandingShowcase onLaunch={() => navigate("/command-center")} /></motion.div>} />
        <Route path="/command-center" element={<motion.div {...page}><GovernmentCommandDashboard onBack={() => navigate("/")} /></motion.div>} />
      </Routes>
    </AnimatePresence>
  );
}

export default function App() {
  return <BrowserRouter><AnimatedRoutes /></BrowserRouter>;
}
