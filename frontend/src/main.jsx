import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { EventType } from '@azure/msal-browser'
import { MsalProvider } from '@azure/msal-react'
// The instance lives in its own module so non-React code (utils/apiClient.js)
// can acquire tokens without importing this file's render side-effects.
import { msalInstance } from './config/msalInstance'

const renderApp = () => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </React.StrictMode>,
  );
};

msalInstance.initialize().then(() => {
  // Account selection logic is app dependent. Adjust as needed for different use cases.
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length > 0) {
    msalInstance.setActiveAccount(accounts[0]);
  }

  msalInstance.addEventCallback((event) => {
    if (event.eventType === EventType.LOGIN_SUCCESS && event.payload.account) {
      msalInstance.setActiveAccount(event.payload.account);
    }
  });

  return msalInstance.handleRedirectPromise()
    .then((response) => {
      if (response !== null) {
        // Handle successful redirect - set active account
        msalInstance.setActiveAccount(response.account);
      }
      renderApp();
    })
    .catch((error) => {
      console.error('Redirect error:', error);
      renderApp();
    });
}).catch((error) => {
  console.error('MSAL initialization error:', error);
  renderApp();
});