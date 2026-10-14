(() => {
  const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const between = (min, max) => min + Math.random() * (max - min);
  function delay(run, character) {
    const base = 650 - run.speed * 5.7;
    if (!run.human) return base;
    if (!run.burstLeft) {
      run.burstLeft = Math.floor(between(3, 12));
      run.burstPace = between(.65, 1.4);
    }
    run.burstLeft--;
    let ms = base * run.burstPace * between(.35, 1.9);
    const boundary = /[，。！？；：,.!?;:\n]/u.test(character);
    if (Math.random() < (boundary ? .38 : .055)) ms += between(280, 2100);
    if (Math.random() < .012) ms += between(1200, 3500);
    return Math.round(ms);
  }
  function typo(run, character) {
    if (!run.human || !/\S/u.test(character)) return null;
    if (run.typoCooldown > 0) { run.typoCooldown--; return null; }
    if (Math.random() >= .045) return null;
    run.typoCooldown = Math.floor(between(2, 9));
    const choices = letters.replace(character, "");
    return choices[Math.floor(Math.random() * choices.length)];
  }
  async function ready(run) {
    while (run.paused && !run.stopped) {
      await new Promise(resolve => { run.wake = () => { run.wake = null; resolve(); }; });
    }
    return !run.stopped;
  }
  async function sleep(run, ms) {
    let remaining = ms;
    while (remaining > 0 && !run.stopped) {
      if (!await ready(run)) return;
      if (run.paused) continue;
      const started = Date.now();
      const elapsed = await new Promise(resolve => {
        const finish = elapsed => { clearTimeout(timer); run.wake = null; resolve(elapsed); };
        const timer = setTimeout(() => finish(true), remaining);
        run.wake = () => finish(false);
      });
      remaining = elapsed ? 0 : remaining - (Date.now() - started);
    }
  }
  globalThis.HTTyping = Object.freeze({ delay, typo, ready, sleep,
    correctionDelay: () => Math.round(between(120, 620)),
    afterCorrection: () => Math.round(between(60, 240)) });
})();
