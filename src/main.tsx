import { StrictMode, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import AppRoot from './AppRoot.tsx';
import LoginScreen from './LoginScreen.tsx';
import ToastContainer from './Toast.tsx';
import './index.css';

function App() {
  const [currentUser, setCurrentUser] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem('sinteriq_user');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed?.name) setCurrentUser(parsed.name);
      } catch (e) {}
    }
  }, []);

  if (!currentUser) {
    return (
      <>
        <LoginScreen onLogin={(name) => setCurrentUser(name)} />
        <ToastContainer />
      </>
    );
  }

  return (
    <>
      <AppRoot />
      <ToastContainer />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
