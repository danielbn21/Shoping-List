import { createRoot } from 'react-dom/client';
import App from './App';
import VersionGuard from './VersionGuard';
import './styles.css';

createRoot(document.getElementById('root')!).render(<><VersionGuard /><App /></>);
