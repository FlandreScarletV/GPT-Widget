import fs from 'node:fs';
import {archive} from './asar.mjs';
const a=archive(fs.readFileSync(process.argv[2]));
const scripts=[...a.entries.keys()].filter(n=>n.startsWith('.vite/build/')&&n.endsWith('.js')).map(n=>a.read(n).toString());
const tray=scripts.some(s=>s.includes('7753b2e9-599f-4ab6-a4a6-58df27d96ea2'));
const exit=scripts.some(s=>s.includes('window_close_full_exit')&&s.includes('quit_cleanup_timeout'));
if(!tray||!exit){console.error('副本缺少独立托盘或完整退出补丁，请重新准备副本。');process.exit(1)}
console.log('隔离补丁检查通过');
