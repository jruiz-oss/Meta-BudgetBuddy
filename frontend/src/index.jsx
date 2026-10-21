import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
// Phone layout. Keep this LAST: it has to load after index.css and after every
// component/page stylesheet (Docs.css, ChiefWidget.css, ...) so it wins on equal specificity.
import './mobile.css';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
