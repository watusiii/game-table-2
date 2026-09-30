import './style.css';
import { mountApp } from './app';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('The app root element is missing.');

mountApp(root);
