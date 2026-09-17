// Test copy only. A visible top-level window close explicitly requests full exit.
export function installTestLifecycle(app, write, timers = globalThis) {
  let timer;
  let closing = false;
  const report = event => { try { write(event); } catch {} };
  report('started');
  const armExit = () => {
    if (timer !== undefined) return;
    timer = timers.setTimeout(() => { report('quit_cleanup_timeout'); app.exit(0); }, 10000);
    timer?.unref?.();
  };
  app.on('browser-window-created', (_event, window) => {
    window.prependListener('close', () => {
      report('window_close_requested');
      if (closing || !window.isVisible() || window.getParentWindow()) return;
      closing = true;
      report('window_close_full_exit');
      armExit();
      // Defer until the existing close listeners have completed their work.
      timers.setTimeout(() => app.quit(), 0);
    });
    window.on('closed', () => report('window_closed'));
  });
  app.on('before-quit', () => report('before_quit'));
  app.on('will-quit', () => {
    report('will_quit');
    armExit();
  });
  app.on('quit', () => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined; report('quit');
  });
}
