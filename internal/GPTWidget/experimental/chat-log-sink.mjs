export function installChatLogSink(app, fs, path, directory, clean, publish = () => {}) {
  const marker = 'GPTWIDGET_CHAT_METADATA:';
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (...args) => {
      const message = args[1]?.message ?? args[0]?.message ?? (typeof args[2] === 'string' ? args[2] : null);
      if (typeof message !== 'string' || !message.startsWith(marker) || message.length > 32768) return;
      try {
        const record = clean(JSON.parse(message.slice(marker.length)));
        if (!record) return;
        publish(record);
        fs.mkdirSync(directory,{recursive:true});
        const file = path.join(directory,`chat-model-${record.observationId}.json`);
        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('invalid_log_target');
        if (!fs.existsSync(file) && fs.readdirSync(directory).filter(n=>/^chat-model-[0-9a-f-]{36}\.json$/i.test(n)).length >= 128) throw Error('log_limit');
        const temp = file + '.tmp';
        if (fs.existsSync(temp)) throw Error('pending_log_write');
        fs.writeFileSync(temp,JSON.stringify({observedAt:new Date().toISOString(),...record},null,2),{encoding:'utf8',flag:'wx'});
        fs.renameSync(temp,file);
      } catch { console.error('GPTWidget Chat observer: diagnostic write failed'); }
    });
  });
}
