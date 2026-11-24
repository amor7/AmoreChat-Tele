import { createRoot } from 'react-dom/client';
import '@fontsource-variable/vazirmatn';
import './tokens.css';
import './styles.css';
import './voice.css';
import './theme.css';
import './features.css';
import './themes.css';
import './motion.css';
import { initAppearance } from './appearance';
import App from './App';
import './update';

initAppearance();
createRoot(document.getElementById('root')).render(<App />);
