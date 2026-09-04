/** エントリポイント。 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { bootstrapTokenFromHash } from './auth.js';
import './styles.css';

// #token=<hex> があれば localStorage へ保存してハッシュから消す（サイクル1.27）。
// #thread= の解釈より前に済ませておく必要はない（前置詞が異なり排他的なため）。
bootstrapTokenFromHash();

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root 要素が見つかりません');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
