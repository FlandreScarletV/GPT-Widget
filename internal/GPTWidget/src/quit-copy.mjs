// Arm the fallback only after normal quit confirmations have accepted shutdown.
// Cancellation in before-quit must never cause a later forced exit.
export function requestCopyQuit(app, timers = globalThis) {
  if (app.__inspectorQuitPending) return;
  app.__inspectorQuitPending = true;
  timers.setImmediate(() => {
    let accepted = false, timer;
    const clear = () => { if (timer) timers.clearTimeout(timer); };
    const accept = () => {
      accepted = true;
      timer = timers.setTimeout(() => app.exit(0), 10000);
      timer.unref?.();
      app.once('quit', clear);
    };
    app.once('will-quit', accept);
    app.quit();
    if (!accepted) {
      app.removeListener('will-quit', accept);
      app.__inspectorQuitPending = false;
    }
  });
}
